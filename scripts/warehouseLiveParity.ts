// The live-parity matrix on the real-account warehouses — Snowflake and
// BigQuery (docs/live-data/00-plan.md L2.8). The third half of
// scripts/test-warehouseLive.ts, which calls it after each warehouse's own
// connector checks, with the same credentials, in the same server mode (the
// SSRF guard pins every socket) and under the same secret canary.
//
// The accounts are READ-ONLY, so the fixture is never written to them: every
// twin is a defining query over literals (./liveParityLiteral.ts — CI proves
// the same twin on Postgres). Every statement goes through the real
// connector's `live.runBound`: Snowflake's SQL API with `?` binds, the UTC /
// WEEK_START = 1 session and the QUERY_TAG; BigQuery's jobs.query with `@p`
// parameters and its bytes cap.
//
// A warehouse bills per statement, so the chart, KPI and answer cases run at a
// STRIDE (every filter op, the negative controls and the pins still run); the
// matrix is otherwise the one every `npm test` runs on DuckDB, compared the
// same way (scripts/liveParityMatrix.ts: `Object.is`, ~1e-13 on float sums).

import type { ParityEngine } from './liveParityFixture';
import type { SnowflakeConfig } from './warehouseLiveSnowflake';
import type { BigqueryConfig } from './warehouseLiveBigquery';
import { ok, say } from './warehouseLiveHarness';

const mx: typeof import('./liveParityMatrix') = require('./liveParityMatrix');
const pins: typeof import('./liveParityPins') = require('./liveParityPins');
const eng: typeof import('./liveParityEngines') = require('./liveParityEngines');
const literal: typeof import('./liveParityLiteral') = require('./liveParityLiteral');

/** Every 8th chart, KPI and answer case: ~500 statements a warehouse, a few minutes each night. */
const STRIDE = 8;

async function runOn(engine: ParityEngine, seen: import('./liveParityEngines').Observed): Promise<void> {
  const today = process.env.ORDINATE_TODAY;
  process.env.ORDINATE_TODAY = '2025-03-15'; // inside the fixture's dates, so relative periods find rows
  const t0 = Date.now();
  try {
    const x = await mx.setupExtract(ok);
    if (!x) return;
    const report = await mx.runMatrix(x, engine, { ok, stride: STRIDE });
    const caught = await mx.brokenBlankCaught(x, engine, report.envs.typed);
    ok(`NEGATIVE CONTROL: on ${engine.name}, a broken empty predicate (whitespace not empty) is caught`, caught.length >= 3, caught.join(' | '));
    const unfolded = await mx.unfoldedBlankCaught(x, engine, report.envs.typed);
    ok(`NEGATIVE CONTROL: on ${engine.name}, the same statements without the '' → NULL fold disagree with the extract (two blank rows)`,
      unfolded.stripped > 0 && unfolded.problems.length >= 3, `${unfolded.stripped} statements unfolded: ${unfolded.problems.join(' | ')}`);
    await pins.run({ pid: x.pid, ok, live: mx.parityKit(x, engine.run).live, env: report.envs.typed, stored: x.stored, engine });
    say(`${engine.name}: ${seen.statements} statements through runBound in ${Math.round((Date.now() - t0) / 1000)} s; chart rows in rank order as sent ` +
      `in ${seen.rankOrdered} of ${seen.charts} (the shaping re-sorts either way); −0 in ${seen.negZero} cells`);
  } finally {
    if (today === undefined) delete process.env.ORDINATE_TODAY;
    else process.env.ORDINATE_TODAY = today;
  }
}

export async function runSnowflakeParity(cfg: SnowflakeConfig): Promise<void> {
  const { values, secrets } = (require('./warehouseLiveSnowflake') as typeof import('./warehouseLiveSnowflake')).snowflakeConnection(cfg);
  const seen = eng.freshObserved();
  await runOn(literal.literalEngine('snowflake', 'snowflake', literal.SNOWFLAKE, eng.runner('snowflake', values, secrets, seen)), seen);
}

export async function runBigqueryParity(cfg: BigqueryConfig): Promise<void> {
  const { values, secrets } = (require('./warehouseLiveBigquery') as typeof import('./warehouseLiveBigquery')).bigqueryConnection(cfg);
  const seen = eng.freshObserved();
  await runOn(literal.literalEngine('bigquery', 'bigquery', literal.BIGQUERY, eng.runner('bigquery', values, secrets, seen)), seen);
}
