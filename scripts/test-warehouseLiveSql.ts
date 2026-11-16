// The Live SQL nightly's own harness, on every `npm test` (docs/live-data/01-live-sql.md, F7):
// scripts/warehouseLiveSqlParity.ts, whose real legs (ClickHouse in a container, Snowflake and
// BigQuery on real accounts) only the nightly runs.
//
//   1. Its leg on the FAKE warehouse (scripts/liveFakeConnector.ts, through the connector registry
//      and runLiveBound): every case agrees, the pins hold (CH1/CH2 still refused on ClickHouse).
//      CONTROL: with the CH1 refusal lifted, pin CH1 fails.
//   2. A set but UNUSABLE account fails: the same leg over a warehouse that refuses every statement
//      fails its verdict and agrees on nothing (CONTROL: 1 passes); and run on its own, a
//      CLICKHOUSE_URL that is not http(s), or that nothing answers, exits non-zero.
//   3. Unset prints ONE skip line and passes: the script with no CLICKHOUSE_URL, and
//      test-warehouseLive with no SNOWFLAKE_* or BIGQUERY_* variable (one line per warehouse: the
//      Live SQL legs it now runs add none).
//
//   npm run build:ts && node scripts/test-warehouseLiveSql.js

export {}; // module scope — sibling test scripts share top-level names
import { finish, ok } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { spawnSync }: typeof import('child_process') = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-livesql-nightly-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

/** A script run on its own, with no warehouse variable but those given (and no CI summary file). */
function child(script: string, env: Record<string, string> = {}, args: string[] = []): { status: number | null; out: string; err: string } {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SNOWFLAKE|BIGQUERY|CLICKHOUSE|DBT_SL)_|^GITHUB_STEP_SUMMARY$/.test(k)));
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { env: { ...base, ...env }, encoding: 'utf8', timeout: 90_000 });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

const skipLines = (s: string): string[] => s.split('\n').filter((l) => l.startsWith('skip '));

async function main(): Promise<void> {
  const sql: typeof import('./warehouseLiveSqlParity') = require('./warehouseLiveSqlParity');
  const fake: typeof import('./liveFakeConnector') = require('./liveFakeConnector');

  // 1. The leg on the fake warehouse.
  const good = await sql.runFakeLeg(ok);
  ok(`the fake leg ran the corpus through the connector (${good.agreed} of ${good.runs} runs agree)`, good.runs > 0 && good.agreed === good.runs);

  // NEGATIVE CONTROL: with ClickHouse's correlated-subquery refusal gone, pin CH1 says it no longer exists.
  const diff: typeof import('./liveSqlDiff') = require('./liveSqlDiff');
  const pins: typeof import('./liveSqlPins') = require('./liveSqlPins');
  const print: typeof import('../src/engine/live/sql/print') = require('../src/engine/live/sql/print');
  const kit = await diff.setupKit(ok);
  if (!kit) return;
  const sources = await diff.loadSources(kit, (require('./liveParityFixture') as typeof import('./liveParityFixture')).duckEngine);
  const pinChecks: { label: string; cond: boolean }[] = [];
  print.OFF_CLICKHOUSE.correlated = false;
  try {
    await pins.dialectPins(kit, sources, (label, cond) => pinChecks.push({ label, cond }));
  } finally {
    print.OFF_CLICKHOUSE.correlated = true;
  }
  const failed = pinChecks.filter((c) => !c.cond).map((c) => c.label);
  ok('NEGATIVE CONTROL: a lifted CH1 refusal fails pin CH1 and the held-back count, and nothing else', failed.length === 2 && /^PIN CH1 .* still refuses/.test(failed[0]) && /hold back exactly/.test(failed[1]), failed);

  // 2. A set but unusable account: every statement refused, as a wrong key or a dropped grant would be.
  const seen: { label: string; cond: boolean }[] = [];
  fake.fake.hook = async () => ({ ok: false, error: 'the account refused the key (simulated)' });
  let broken: import('./warehouseLiveSqlParity').LegReport;
  try {
    broken = await sql.runFakeLeg((label, cond) => seen.push({ label, cond }), sql.STRIDE);
  } finally {
    fake.resetFake();
  }
  const verdict = seen.find((s) => / corpus runs agree /.test(s.label));
  ok(`an unusable account FAILS the leg: its verdict fails, 0 of ${broken.runs} runs agree, ${seen.filter((s) => !s.cond).length} checks fail`,
    !!verdict && !verdict.cond && broken.runs > 0 && broken.agreed === 0, JSON.stringify(verdict));
  const notUrl = child('warehouseLiveSqlParity.js', { CLICKHOUSE_URL: 'ftp://clickhouse.invalid' });
  ok('a CLICKHOUSE_URL that is not http(s) exits non-zero, never skips', notUrl.status === 1 && /FAIL CLICKHOUSE_URL is an http\(s\) URL/.test(notUrl.err) && skipLines(notUrl.out).length === 0, notUrl);
  const deaf = child('warehouseLiveSqlParity.js', { CLICKHOUSE_URL: 'http://parity:parity@127.0.0.1:9' });
  ok('a CLICKHOUSE_URL nothing answers on exits non-zero', deaf.status === 1 && /FAIL live SQL parity reached its end/.test(deaf.err) && !deaf.err.includes('parity:parity'), deaf);

  // 3. Unset: one skip line each, exit 0.
  const unset = child('warehouseLiveSqlParity.js');
  ok('no CLICKHOUSE_URL: one skip line, exit 0, no check run', unset.status === 0 && skipLines(unset.out).length === 1 && /CLICKHOUSE_URL is unset/.test(unset.out) && !/^(ok|FAIL) /m.test(unset.out + unset.err), unset);
  const live = child('test-warehouseLive.js');
  const lines = skipLines(live.out);
  ok('test-warehouseLive with no warehouse variable: one skip line per warehouse (the Live SQL legs add none), exit 0',
    live.status === 0 && lines.length === 2 && /Snowflake/.test(lines[0]) && /BigQuery/.test(lines[1]), { status: live.status, lines, err: live.err.slice(0, 2000) });
}

main()
  .catch((e: unknown) => ok('the Live SQL nightly harness suite threw', false, e instanceof Error ? e.stack : String(e)))
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
