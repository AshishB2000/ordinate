// The nightly's Live join cases, on every `npm test`: scripts/warehouseLiveJoins.ts, whose real runs (Snowflake,
// BigQuery with BIGQUERY_SCRATCH_DATASET, the ClickHouse container) only the warehouse nightly makes.
//
//   1. The whole run against the DuckDB fake (scripts/liveFakeConnector.ts) under the real door, executor, budget and
//      connector code: every check passes, each statement billing the fake's 10 MB (inside the bound). Again with each
//      table a literal defining query, as Snowflake's run holds them. The BigQuery and ClickHouse runners' table
//      names are sources their connectors accept.
//   2. NEGATIVE CONTROLS:
//      - an executor that drops the `row_number() = 1` pick fails the cases, the related measures and KPIs among them;
//      - a statement billed past the bound fails the bytes check, and only it;
//      - a statement sent around `warehouse()` fails the door check, and only it.
//   3. BigQuery's gate: without BIGQUERY_SCRATCH_DATASET, no check and no request; set to no dataset name, it fails
//      and asks nothing. The fixture script names only our own tables, and refuses anything else.
//   (The fake is DuckDB, which stores −0 as 0, so the −0 key is only a real engine's case.)
//
//   npm run build:ts && node scripts/test-warehouseLiveJoins.js

export {}; // module scope — sibling test scripts share top-level names
import { finish, ok } from './selfcheck';
import { captureLogs } from './logCapture';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-livejoins-nightly-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
const fakeMod: typeof import('./liveFakeConnector') = require('./liveFakeConnector');
const fakeBq: typeof import('./bigqueryFake') = require('./bigqueryFake');
const fixture: typeof import('./liveParityFixture') = require('./liveParityFixture');
const compileJoin: typeof import('../src/engine/live/compileJoin') = require('../src/engine/live/compileJoin');
const registry: typeof import('../src/connectors') = require('../src/connectors');
const joins: typeof import('./warehouseLiveJoins') = require('./warehouseLiveJoins');

type Check = { label: string; cond: boolean; extra?: unknown };
const failing = (c: Check[]): Check[] => c.filter((x) => !x.cond);
const MB10 = 10 * 2 ** 20;
const engine: import('./warehouseLiveJoins').JoinEngine = { name: 'duckdb (live fake)', load: fixture.duckEngine.load, typeName: fixture.duckEngine.typeName };
const conn = { connectorId: fakeMod.LIVE_FAKE_ID, values: {}, secrets: { password: 'live-fake-not-a-secret' } };

async function run(on = engine): Promise<Check[]> {
  const checks: Check[] = [];
  await joins.runJoins(on, conn, (label, cond, extra) => checks.push({ label, cond, extra }), { maxBilled: joins.BQ_MAX_BILLED });
  return checks;
}

async function main(): Promise<void> {
  context.enterServerMode(tmp);
  fakeMod.registerLiveFake();
  await context.runInContext({ user: { email: 'nightly@ordinate.invalid', role: 'admin' }, org: { id: 'nightly' } }, 'live-joins-nightly', async () => {
    // 1. The whole run on the fake.
    fakeMod.fake.billedBytes = MB10;
    const good = await run();
    ok(`the join cases on the DuckDB fake: all ${good.length} checks pass`, good.length >= 10 && failing(good).length === 0, failing(good));
    ok('…the cases, the pick and its divergence, the door and the bytes are all among them',
      ['a related category', 'a related split', 'a related filter', 'two hops', 'drill-across', 'a related measure:', 'two links away', 'a KPI across a link', 'a KPI of a related measure', 'THE PICK', 'divergence', 'warehouse()', 'billed at most'].every((w) => good.some((c) => c.label.includes(w))), good.map((c) => c.label));

    // …and Snowflake's shape: each table a literal defining query (`origin.sql`), in DuckDB's types.
    const literal: typeof import('./liveParityLiteral') = require('./liveParityLiteral');
    const spell = { ...literal.SNOWFLAKE, type: { ...literal.SNOWFLAKE.type, float: 'DOUBLE' } };
    const asSql = await run({ name: 'duckdb (literal tables)', load: async (_t, cols, rows) => ({ kind: 'sql', sql: literal.literalTwin(spell, 'duckdb', cols, rows) }), typeName: fixture.duckEngine.typeName });
    ok(`…and over literal defining queries, as Snowflake holds them: all ${asSql.length} checks pass`, asSql.length === good.length && failing(asSql).length === 0, failing(asSql));
    // The table names the BigQuery and ClickHouse runners build are sources their connectors accept.
    const { liveSourceOf }: typeof import('../src/engine/live/liveTarget') = require('../src/engine/live/liveTarget');
    const parts = (id: string, table: string): unknown => { const s = liveSourceOf({ table }, registry.getConnector(id)!, registry.getConnector(id)!.live!.dialect); return s?.kind === 'table' ? s.parts : s; };
    const bqParts = parts('bigquery', 'acme-analytics-123.nightly_scratch.ordinate_join_orders');
    const chParts = parts('clickhouse', 'ordinate_l28_41_1763000000000.ordinate_join_orders');
    ok('the BigQuery runner\'s project.dataset.table (a hyphenated project) and the ClickHouse runner\'s db.table are sources their connectors accept',
      JSON.stringify(bqParts) === '["acme-analytics-123","nightly_scratch","ordinate_join_orders"]' && JSON.stringify(chParts) === '["ordinate_l28_41_1763000000000","ordinate_join_orders"]', [bqParts, chParts]);

    // 2. NEGATIVE CONTROL: an executor that drops the pick (every row of a repeated key joins).
    compileJoin.setJoinCutForTest(false);
    let uncut: Check[];
    try {
      uncut = await run();
    } finally {
      compileJoin.setJoinCutForTest(true);
    }
    const lost = failing(uncut).map((c) => c.label);
    ok('NEGATIVE CONTROL: an executor that drops the row_number() = 1 pick fails the related category, split, filter, two hops, drill-across, related measures, KPIs and THE PICK',
      ['a related category', 'a related split', 'a related filter', 'two hops', 'drill-across', 'a related measure:', 'two links away', 'a KPI across a link', 'a KPI of a related measure', 'THE PICK'].every((w) => lost.some((l) => l.includes(w))), lost);

    // NEGATIVE CONTROL: billed past the bound.
    fakeMod.fake.billedBytes = joins.BQ_MAX_BILLED + 1;
    const costly = await run();
    fakeMod.fake.billedBytes = MB10;
    ok('NEGATIVE CONTROL: a statement billed past the bound fails the bytes check, and only it',
      failing(costly).length === 1 && failing(costly)[0].label.includes('billed at most'), failing(costly).map((c) => c.label));

    // NEGATIVE CONTROL: one statement sent straight to the connector, around warehouse().
    const def = registry.getConnector(fakeMod.LIVE_FAKE_ID)!;
    let sneaked = false;
    fakeMod.fake.hook = async (_call, ctx) => {
      if (!sneaked) { sneaked = true; await def.live!.runBound(ctx, 'SELECT 1 AS x', []); }
      return undefined;
    };
    let around: Check[];
    try {
      around = await run();
    } finally {
      fakeMod.fake.hook = null;
    }
    ok('NEGATIVE CONTROL: a statement sent around warehouse() fails the door check, and only it',
      sneaked && failing(around).length === 1 && failing(around)[0].label.includes('warehouse()'), failing(around).map((c) => c.label));

    // 3. BigQuery's gate, asking nothing either way.
    let calls = 0;
    const counting: import('../src/connectors/bigquery').Transport = async () => { calls += 1; return { status: 500, headers: {}, body: '', truncated: false }; };
    const gate = async (scratch?: string): Promise<Check[]> => {
      const checks: Check[] = [];
      const quiet = captureLogs();
      try {
        await joins.runBigqueryJoins({ keyJson: fakeBq.makeKey().json, project: fakeBq.PROJECT, ...(scratch === undefined ? {} : { scratch }) }, counting, (label, cond, extra) => checks.push({ label, cond, extra }));
      } finally {
        quiet.restore();
      }
      return checks;
    };
    const unset = await gate();
    ok('no BIGQUERY_SCRATCH_DATASET: no check, no request (the run prints its one skip line)', unset.length === 0 && calls === 0, { unset, calls });
    const bad = await gate('not a dataset;');
    ok('NEGATIVE CONTROL: a BIGQUERY_SCRATCH_DATASET that is no dataset name fails, never skips, and asks nothing', bad.length === 1 && !bad[0].cond && calls === 0, { bad, calls });
    const plans = [joins.bigqueryJoinsPlan({}), joins.bigqueryJoinsPlan({ scratch: 'nightly_scratch' }), joins.bigqueryJoinsPlan({ scratch: 'a.b' })];
    ok('the plan: unset skips, a dataset name runs, anything else fails', !plans[0].run && !('bad' in plans[0]) && plans[1].run && !plans[2].run && plans[2].bad === true, plans);
    const script = joins.bigqueryFixtureScript(`${fakeBq.PROJECT}.nightly_scratch.ordinate_join_zones`, [{ name: 'zid', store: 'float' }, { name: 'zone', store: 'text' }], [[-0, 'Z0'], [null, "it's"]], '2026-11-20T00:00:00.000Z');
    let refused = 0;
    for (const t of ['p.s.ordinate_join_x`; DROP TABLE y', 'p.s.other_table']) {
      try { joins.bigqueryFixtureScript(t, [], [], '2026-11-20T00:00:00.000Z'); } catch { refused += 1; }
    }
    ok('the BigQuery fixture script: CREATE OR REPLACE our own table, expiring, from literals (−0 kept, a quote escaped); any other name refused',
      script.startsWith(`CREATE OR REPLACE TABLE \`${fakeBq.PROJECT}.nightly_scratch.ordinate_join_zones\` OPTIONS (expiration_timestamp = TIMESTAMP '2026-11-20T00:00:00.000Z') AS\nSELECT`)
      && script.includes("'-0'") && script.includes("'it\\'s'") && refused === 2, script);
  });
}

main()
  .catch((e: unknown) => ok('the live joins nightly suite threw', false, e instanceof Error ? e.stack : String(e)))
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
