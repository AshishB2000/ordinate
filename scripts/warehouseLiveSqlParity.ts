// SQL on Live datasets on REAL warehouses: the nightly (docs/live-data/01-live-sql.md, F7). F2's
// differential (./liveSqlDiff.ts: DuckDB runs the model's text over the extract; Live translates it,
// prints it for the engine's dialect and runs it) with Live's side through each warehouse's REAL
// connector, `live.runBound` by `connectors/liveRun.runLiveBound`, in server mode (the SSRF guard
// checks and pins every socket). Every cell is compared with `Object.is` (floats flagged `approx`
// within 1e-13), unlocked and under a viewer's lock; a divergence is a pin in ./liveSqlPins.ts with a
// check that it still exists, never a loosened comparison. Three legs:
//
//   clickhouse  the `clickhouse` job's container (CLICKHOUSE_URL), the fixture in a scratch database:
//               the whole corpus, every hostile literal, the controls, the pins, and the LIFT PROBE of
//               pins CH1 and CH2 (their held cases run with the refusal widened, reported only).
//   snowflake   `runSnowflakeSql` / `runBigquerySql`, called by scripts/test-warehouseLive.ts after
//   bigquery    its own checks, under its plans (unset: its one skip line; half set: a failure) and
//               its SECRET CANARY. The rows are literal twins (./liveParityLiteral.ts): the accounts
//               are never written. A billed warehouse runs every 8th case plus every window
//               (BigQuery's NULLS order inside OVER is unverified), every hostile literal (binding is
//               what differs most per engine, F-D4), the controls and the pins.
//   fake        `--fake`: the same leg through scripts/liveFakeConnector.ts (DuckDB), so the harness
//               runs on every `npm test` (scripts/test-warehouseLiveSql.ts).
//
// Run on its own with neither CLICKHOUSE_URL nor `--fake` it prints ONE skip line and passes; a set but
// unusable CLICKHOUSE_URL (not http(s), or nothing answering) fails.
//
//   npm run build:ts && CLICKHOUSE_URL=http://default:secret@localhost:8123 node scripts/warehouseLiveSqlParity.js
//   npm run build:ts && node scripts/warehouseLiveSqlParity.js --fake

import type { ParityEngine } from './liveParityFixture';
import type { SnowflakeConfig } from './warehouseLiveSnowflake';
import type { BigqueryConfig } from './warehouseLiveBigquery';
import { finish } from './selfcheck';
import { ok as harnessOk, say, summary, writeSummary } from './warehouseLiveHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

type Ok = (label: string, cond: boolean, extra?: unknown) => void;

/** A billed warehouse runs every STRIDE-th corpus case (the note's "every 8th"), plus every window. */
export const STRIDE = 8;
const WINDOW_RE = / OVER \(/i;

export interface LegReport {
  /** Corpus runs (each case unlocked and locked) and how many agreed. */
  runs: number;
  agreed: number;
  /** The lift probe's lines (empty on an engine with no dialect pin). */
  probe: string[];
}

/** The leg on one engine. `stride` 1 runs every case. Lazy requires: the caller sets the data dir first. */
export async function runLeg(engine: ParityEngine, ok: Ok, stride: number): Promise<LegReport> {
  const corpus: typeof import('./liveSqlCorpus') = require('./liveSqlCorpus');
  const diff: typeof import('./liveSqlDiff') = require('./liveSqlDiff');
  const pins: typeof import('./liveSqlPins') = require('./liveSqlPins');
  const report: LegReport = { runs: 0, agreed: 0, probe: [] };
  const kit = await diff.setupKit(ok);
  if (!kit) return report;
  const sources = await diff.loadSources(kit, engine);
  const held = pins.heldOn(engine.dialect);
  const cases = corpus.CASES.filter((c, i) => !held.has(c.name) && (i % stride === 0 || WINDOW_RE.test(c.sql)));
  for (const lock of [false, true]) report.agreed += await diff.runCorpus(kit, sources, engine, ok, lock, cases);
  report.runs = cases.length * 2;
  ok(`${engine.name}: ${report.agreed} of ${report.runs} corpus runs agree (${cases.length} statements, unlocked and locked; ${held.size} held back by its pins)`,
    report.runs > 0 && report.agreed === report.runs);
  for (const c of diff.literalCases()) {
    const p = await diff.problems(kit, c, sources, engine, { lock: false });
    ok(`${engine.name}: ${c.name} binds and agrees`, p.length === 0, p.join(' | '));
  }
  await pins.controls(kit, sources, engine, ok, cases);
  await pins.run(kit, sources, engine, ok);
  await pins.dialectPins(kit, sources, ok);
  report.probe = await pins.liftProbe(kit, sources, engine);
  for (const line of report.probe) say(line);
  return report;
}

/** A billed account's leg: the literal twins through the connector's own runBound, at the stride. */
async function billedLeg(engine: ParityEngine, seen: import('./liveParityEngines').Observed): Promise<void> {
  const t0 = Date.now();
  const r = await runLeg(engine, harnessOk, STRIDE);
  say(`${engine.name}: live SQL, ${seen.statements} statements through runBound in ${Math.round((Date.now() - t0) / 1000)} s`);
  summary(`- ${engine.name} live SQL: ${seen.statements} statements; ${r.agreed} of ${r.runs} corpus runs agree`);
}

export async function runSnowflakeSql(cfg: SnowflakeConfig): Promise<void> {
  const eng: typeof import('./liveParityEngines') = require('./liveParityEngines');
  const literal: typeof import('./liveParityLiteral') = require('./liveParityLiteral');
  const { values, secrets } = (require('./warehouseLiveSnowflake') as typeof import('./warehouseLiveSnowflake')).snowflakeConnection(cfg);
  const seen = eng.freshObserved();
  await billedLeg(literal.literalEngine('snowflake', 'snowflake', literal.SNOWFLAKE, eng.runner('snowflake', values, secrets, seen)), seen);
}

export async function runBigquerySql(cfg: BigqueryConfig): Promise<void> {
  const eng: typeof import('./liveParityEngines') = require('./liveParityEngines');
  const literal: typeof import('./liveParityLiteral') = require('./liveParityLiteral');
  const { values, secrets } = (require('./warehouseLiveBigquery') as typeof import('./warehouseLiveBigquery')).bigqueryConnection(cfg);
  const seen = eng.freshObserved();
  await billedLeg(literal.literalEngine('bigquery', 'bigquery', literal.BIGQUERY, eng.runner('bigquery', values, secrets, seen)), seen);
}

/** The fake warehouse's leg: DuckDB tables, read through the `live-fake` connector's runBound. */
export async function runFakeLeg(ok: Ok, stride = 1): Promise<LegReport> {
  const fake: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
  const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
  const eng: typeof import('./liveParityEngines') = require('./liveParityEngines');
  fake.registerLiveFake();
  return runLeg({ ...fx.duckEngine, name: 'live-fake', run: eng.runner(fake.LIVE_FAKE_ID, {}, {}, eng.freshObserved()) }, ok, stride);
}

async function fakeMain(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-livesql-fake-'));
  process.env.ORDINATE_LOCAL_DIR = tmp;
  try {
    const r = await runFakeLeg(harnessOk);
    summary(`- live-fake live SQL: ${r.agreed} of ${r.runs} corpus runs agree`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function clickhouseMain(raw: string): Promise<void> {
  const eng: typeof import('./liveParityEngines') = require('./liveParityEngines');
  const target = eng.clickhouseTarget(raw);
  harnessOk('CLICKHOUSE_URL is an http(s) URL (a set but unusable value fails, never skips)', !!target);
  if (!target) return;
  // Server mode: the SSRF guard checks and pins every socket; the server's address, the one that answers, is allowed.
  const reach = await eng.reachableAddress(target.host, target.port);
  process.env.SSRF_ALLOW = [process.env.SSRF_ALLOW, reach.cidr].filter(Boolean).join(',');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-livesql-ch-'));
  const context: typeof import('../src/server/context') = require('../src/server/context');
  context.enterServerMode(path.join(tmp, 'data'));
  const identity = { user: { email: 'parity@ordinate.invalid', role: 'admin' as const }, org: { id: 'parity' } };
  await context.runInContext(identity, `live-sql-ch-${process.pid}`, async () => {
    const t0 = Date.now();
    const c = await eng.clickhouseParity(raw, reach.address);
    try {
      say(`ClickHouse ${c.version}: scratch database ${c.database}`);
      const r = await runLeg(c.engine, harnessOk, 1);
      say(`clickhouse: live SQL, ${c.seen.statements} statements through runBound in ${Date.now() - t0} ms`);
      summary(`- clickhouse live SQL: ${c.seen.statements} statements; ${r.agreed} of ${r.runs} corpus runs agree`);
      for (const line of r.probe) summary(`  - ${line}`);
    } finally {
      await c.close();
    }
  });
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (require.main === module) {
  const chUrl = (process.env.CLICKHOUSE_URL ?? '').trim();
  const go = process.argv.includes('--fake') ? fakeMain() : chUrl ? clickhouseMain(chUrl) : null;
  if (!go) {
    console.log('skip live SQL parity on ClickHouse: CLICKHOUSE_URL is unset (the nightly\'s clickhouse job sets it; `--fake` runs the leg on the fake warehouse)');
    finish();
  } else {
    void go
      .catch((e: unknown) => harnessOk('live SQL parity reached its end', false, e instanceof Error ? e.stack : String(e)))
      .finally(() => {
        writeSummary();
        finish();
      });
  }
}
