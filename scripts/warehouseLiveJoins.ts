// Live charts across saved links (src/engine/live/compileJoin.ts, PR #569) on REAL warehouses: part of the warehouse
// nightly, not a suite. Each warehouse gets the same three tables, linked many → one (Orders.cid → Customers.cid,
// Customers.zid → Zones.zid), and the same charts asked through the real door (`vizDataFor`), executor and connector.
// Each answer is compared, Object.is, with joinJs (analysis/joinJs, the copy's reference) over the rows seeded here.
//
//   fixture  the edge cases of docs/live-data/log.md's 2026-11-16 Live joins entry, in the rows:
//              - a one-side key repeated with identical rows (c2), and with differing rows (c3: 'east' then 'West',
//                which is smaller by bytes; c6: a NULL row then 'Alpha', NULL last). The row Live keeps is smaller
//                on EVERY column, so the pick is one row whatever a case reads;
//              - NULL, '' and whitespace keys on both sides, which match nothing;
//              - 'C1' beside 'c1' (text compares as bytes);
//              - a −0 zone key beside 0 (one partition, BigQuery's FORMAT('%.17g') included), a NULL one, one
//                that matches nothing;
//              - integer amounts and no dates, so every figure is exact.
//            Each warehouse holds them as its own `load` makes them:
//              - BigQuery: three tables written in BIGQUERY_SCRATCH_DATASET, which expire in three days;
//              - Snowflake: literal defining queries; the role is read-only;
//              - ClickHouse: MergeTree tables in the container's scratch database;
//              - the stand-in: DuckDB tables behind the live fake.
//   cases    a related category, a related split, a related filter, two hops, drill-across. Then THE PICK: the dirty
//            keys show their smallest row (Object.is joinJs with that row first). It IS a divergence: joinJs in file
//            order, which is what a copy keeps, shows the other one.
//   door     every statement on the wire went through `warehouse()` (wire count = admissions), and each billed at most
//            `maxBilled` bytes where the warehouse reports billing.
//
// scripts/test-warehouseLiveJoins.ts runs all of it on every `npm test` against the DuckDB fake, with its negative
// controls.

import type { Cell, ParityEngine, Store, StoredColumn } from './liveParityFixture';
import type { VizEncoding } from '../src/analysis/visuals';
import type { FilterStep } from '../src/data/transforms';
import type { SnowflakeConfig } from './warehouseLiveSnowflake';
import type { BigqueryConfig } from './warehouseLiveBigquery';
import { ident, keep, ok as harnessOk, say, secret, summary } from './warehouseLiveHarness';

const registry: typeof import('../src/connectors') = require('../src/connectors');
const budget: typeof import('../src/engine/live/liveBudget') = require('../src/engine/live/liveBudget');
const literal: typeof import('./liveParityLiteral') = require('./liveParityLiteral');
const fixture: typeof import('./liveParityFixture') = require('./liveParityFixture');
const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');

type Ok = (label: string, cond: boolean, extra?: unknown) => void;
/** A `visual:data` reply, read field by field. */
type Reply = Record<string, any>; // any: VizDataReply's union, read as the suites read it

/** What a warehouse needs to hold the fixture: its `load` and the type names a schema sync records. */
export type JoinEngine = Pick<ParityEngine, 'name' | 'load' | 'typeName'>;
export interface JoinConnection { connectorId: string; values: Record<string, unknown>; secrets: Record<string, string> }

interface Table { key: 'orders' | 'customers' | 'zones'; name: string; table: string; cols: { name: string; type: 'text' | 'number'; store: Store }[]; rows: Cell[][] }
const T = (name: string): { name: string; type: 'text'; store: Store } => ({ name, type: 'text', store: 'text' });
const N = (name: string): { name: string; type: 'number'; store: Store } => ({ name, type: 'number', store: 'float' });

export const ORDERS: Table = {
  key: 'orders', name: 'Orders', table: 'ordinate_join_orders', cols: [T('oid'), T('cid'), T('chan'), N('amt')],
  rows: [
    ['o1', 'c1', 'web', 10], ['o2', 'c1', 'store', 20], ['o3', 'c2', 'web', 7], ['o4', 'c2', 'web', 3], ['o5', 'c3', 'store', 11],
    ['o6', 'c3', 'web', 13], ['o7', 'c4', 'store', 2], ['o8', 'c5', 'web', 17], ['o9', 'c6', 'store', 19], ['o10', 'c7', 'web', 23],
    ['o11', 'c9', 'store', 29], // a key no customer has
    ['o12', null, 'web', 31], ['o13', '', 'store', 37], ['o14', '  ', 'web', 41], // empty keys match nothing
    ['o15', 'C1', 'store', 43], ['o16', 'c1', 'web', 47],
  ],
};
export const CUSTOMERS: Table = {
  key: 'customers', name: 'Customers', table: 'ordinate_join_customers', cols: [T('cid'), T('region'), T('seg'), N('zid'), N('credit')],
  rows: [
    ['c1', 'North', 'A', 1, 10],
    ['c2', 'South', 'B', 2, 20],
    ['c2', 'South', 'B', 2, 20], // the same key, the same row: one row per key
    ['c3', 'east', 'b', 2, 9], // the same key, a different row, first in file order …
    ['c3', 'West', 'A', 1, 5], // … and the one Live keeps: smaller on every column ('W' < 'e' as bytes)
    ['c4', 'East', null, 7, 4], // a NULL split value; zone 7 does not exist
    ['c5', 'West', 'A', null, 8], // no zone key: the next hop finds nothing
    ['c6', null, null, null, null], // a NULL row first …
    ['c6', 'Alpha', 'A', 0, 3], // … and the one Live keeps (NULL last)
    ['c7', 'Zed', 'B', -0, 2], // −0 is zone 0
    [null, 'Nowhere', 'Z', 1, 1], ['', 'Blank', 'Z', 1, 1], ['  ', 'Spaces', 'Z', 1, 1], // empty keys match nothing
    ['C1', 'Upper', 'B', 2, 6], // not 'c1'
  ],
};
/** Customers with each dirty key's kept row first: what Live must equal under joinJs (a copy keeps the first in file order). */
const PICKED: Cell[][] = [0, 1, 2, 4, 3, 5, 6, 8, 7, 9, 10, 11, 12, 13].map((i) => CUSTOMERS.rows[i]);
export const ZONES: Table = {
  key: 'zones', name: 'Zones', table: 'ordinate_join_zones', cols: [N('zid'), T('zone')],
  rows: [[1, 'Z1'], [2, 'Z2'], [2, 'Z2'], [0, 'Z0'], [-0, 'Z0'], [null, 'Znull'], [9, 'Z9']],
};
const TABLES = [ORDERS, CUSTOMERS, ZONES];
const stored = (t: Table): StoredColumn[] => t.cols.map(({ name, store }) => ({ name, store }));

/** BigQuery bills at least 10 MB per table a statement reads; a join reads up to all three. */
export const BQ_MAX_BILLED = 3 * 10 * 2 ** 20;

/**
 * TODO: related measures and KPIs across a link on Live. On this base the executor refuses a measure on a related
 * table (`relatedMeasure`, ipc/liveJoin) and asks no KPI across a link, so these are not asked yet. The fixture is
 * ready for them: Customers.credit is the related measure, c2's identical repeat must count once and the dirty keys
 * pick as above. Each compares with joinJs (`joinedVizDataJs` with its fan-in mask; `joinedMetricJs`).
 */
export const TODO_RELATED_MEASURE_AND_KPI_CASES = [
  'a related measure: sum(Customers.credit) by Orders.chan, each customer once',
  'a related measure by a related category: sum(Customers.credit) by Zones.zone, across two hops',
  'a KPI across a link: sum(Orders.amt) where Customers.region = \'West\'',
  'a KPI of a related measure: sum(Customers.credit) over the customers Orders reaches',
] as const;

const M = (column: string, aggregation: 'sum' | 'count', datasetId?: string) => ({ column, aggregation, ...(datasetId ? { datasetId } : {}) });
const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x));
const chartOf = (r: Reply) => ({ labels: r.data.labels, series: r.data.series.map((s: Reply) => ({ name: s.name, values: s.values })) });
/** Integer amounts: every figure is exact, so Object.is throughout. */
const EXACT = (): boolean => false;
function problems(ref: Reply, live: Reply, byName: boolean): string[] {
  if (ref?.ok !== true || live?.ok !== true) return [`not both answered: ${show([ref, live]).slice(0, 400)}`];
  return cmp.compareCharts(chartOf(ref), chartOf(live), EXACT, byName);
}

/** The cases on one warehouse: `engine` holds the fixture there, `conn` is the connection Live asks through. */
export async function runJoins(engine: JoinEngine, conn: JoinConnection, ok: Ok = harnessOk, opts: { maxBilled?: number } = {}): Promise<void> {
  const def = registry.getConnector(conn.connectorId);
  const live = def?.live;
  if (!live) return ok(`${engine.name} joins: the ${conn.connectorId} connector answers Live questions`, false);
  // The watch: every statement on the wire (the connector's runBound) and every one `warehouse()` admitted.
  const wire: { sql: string; bytes?: number }[] = [];
  const door: string[] = [];
  const realRun = live.runBound;
  live.runBound = async (ctx, sql, params) => {
    const r = await realRun.call(live, ctx, sql, params);
    wire.push({ sql, bytes: r.ok ? r.bytes : undefined });
    return r;
  };
  budget.setDailyCheckForTest((_org, id) => { door.push(id); return { ok: true }; });
  // The run's own secrets store (server mode has none without Postgres), as the partition-time case keeps.
  const configSecrets: typeof import('../src/app/configSecrets') = require('../src/app/configSecrets');
  const vault = new Map<string, string>();
  configSecrets.useSecretStore({
    get: async (org, kind, ref) => vault.get(`${org}\u0000${kind}\u0000${ref}`) ?? null,
    put: async (org, kind, ref, value) => { vault.set(`${org}\u0000${kind}\u0000${ref}`, value); },
    delete: async (org, kind, ref) => vault.delete(`${org}\u0000${kind}\u0000${ref}`),
  });
  try {
    const projects: typeof import('../src/app/projects') = require('../src/app/projects');
    const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
    const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
    const liveDataset: typeof import('../src/data/liveDataset') = require('../src/data/liveDataset');
    const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
    const { storeSecrets }: typeof import('../src/ipc/connectionSecrets') = require('../src/ipc/connectionSecrets');
    const { liveTarget }: typeof import('../src/engine/live/liveTarget') = require('../src/engine/live/liveTarget');
    await projects.init();
    const P = (await projects.createProject('Live joins')).id;
    const c = await connections.saveConnection(P, { name: `${engine.name} joins`, connectorId: conn.connectorId, values: conn.values });
    if (!c) return ok(`${engine.name} joins: the connection is saved`, false);
    await storeSecrets(c.id, conn.secrets);

    // ── The fixture, as Live datasets whose columns carry the warehouse's type names (as a schema sync stores them) ─
    const ids = {} as Record<Table['key'], string>;
    for (const t of TABLES) {
      const src = await engine.load(t.table, stored(t), t.rows);
      const where = src.kind === 'sql' ? { sql: src.sql } : { table: src.parts.join('.') };
      const columns = t.cols.map(({ name, type }) => ({ name, type }));
      const rec = await liveRecord.saveLiveRecord(P, { name: t.name, columns, origin: { kind: 'connection', connId: c.id, ...where } });
      const synced = !!rec && await liveDataset.writeSchemaSync(P, rec.id, {
        columns, profile: { columns: t.cols.map((x) => ({ name: x.name, sourceType: engine.typeName(x.store) })) }, missingColumns: [], syncedAt: new Date().toISOString(), changed: false,
      });
      if (!rec || !synced) return ok(`${engine.name} joins: the Live dataset ${t.name} is saved`, false);
      ids[t.key] = rec.id;
    }
    const typed = await Promise.all(TABLES.map(async (t) => { const r = await liveTarget(P, ids[t.key]); return r.ok && r.target.columns.every((x) => !!x.sourceType); }));
    ok(`${engine.name} joins: every table's columns carry the warehouse's type names (the safe casts read them)`, typed.every(Boolean), typed);
    await rels.saveRelationship(P, { from: { datasetId: ids.orders, column: 'cid' }, to: { datasetId: ids.customers, column: 'cid' }, cardinality: 'many_to_one' });
    await rels.saveRelationship(P, { from: { datasetId: ids.customers, column: 'zid' }, to: { datasetId: ids.zones, column: 'zid' }, cardinality: 'many_to_one' });

    // ── The reference: joinJs over the seeded rows, on the copy's own plan ─
    const asCopy = (t: Table, rows = t.rows) => fixture.importTyped(t.cols, rows);
    const seeded = new Map([[ids.orders, asCopy(ORDERS)], [ids.customers, asCopy(CUSTOMERS, PICKED)], [ids.zones, asCopy(ZONES)]]);
    const filed = new Map([...seeded, [ids.customers, asCopy(CUSTOMERS)]]);
    const reference = (d: string, enc: VizEncoding, filters: FilterStep[], tables = seeded) => referenceChart(P, d, enc, filters, tables);

    // ── The cases, through the door ─
    const { vizDataFor }: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
    const category: VizEncoding = { category: 'region', categoryDatasetId: ids.customers, values: [M('amt', 'sum')] };
    const cases: [string, string, VizEncoding, FilterStep[], boolean][] = [
      ['a related category', ids.orders, category, [], false],
      ['a related split', ids.orders, { category: 'chan', series: 'seg', seriesDatasetId: ids.customers, values: [M('amt', 'sum')] }, [], true],
      ['a related filter (`!=` keeps the unmatched rows)', ids.orders, { category: 'cid', values: [M('amt', 'sum')] }, [{ type: 'filter', column: 'region', op: '!=', value: 'North' }], false],
      ['two hops, Orders → Customers → Zones (number keys, −0 beside 0)', ids.orders, { category: 'zone', categoryDatasetId: ids.zones, values: [M('amt', 'sum')] }, [], false],
      // A count no case above asks, so its question across the link is its own statement, not the cache's.
      ['drill-across: a measure on the many side', ids.customers, { category: 'region', values: [M('credit', 'sum'), M('oid', 'count', ids.orders)] }, [], false],
    ];
    const answers: Reply[] = [];
    for (const [label, d, enc, filters, byName] of cases) {
      const before = wire.length;
      const got = keep(await vizDataFor(P, d, enc, filters)) as Reply;
      const p = problems(await reference(d, enc, filters), got, byName);
      answers.push(got);
      ok(`${engine.name} joins, ${label}: Live = joinJs, Object.is, asked of the warehouse`, p.length === 0 && got.asOf?.mode === 'live' && wire.length > before, p.join(' | ') || show(got).slice(0, 400));
    }
    const [cat] = answers;
    const labels: unknown[] = cat?.ok ? cat.data.labels : [];
    ok(`${engine.name} joins, THE PICK: each dirty key shows its smallest row — c3 'West' over 'east' (bytes), c6 'Alpha' over a NULL row`,
      cat?.ok === true && labels.includes('Alpha') && !labels.includes('east'), show(labels));
    const copy = await reference(ids.orders, category, [], filed);
    ok(`${engine.name} joins, …a pinned divergence: joinJs in file order (a copy's pick) shows 'east' instead`,
      problems(copy, cat, false).length > 0 && copy.data.labels.includes('east'), show(copy.data?.labels));
    say(`${engine.name} joins: not asked yet (${TODO_RELATED_MEASURE_AND_KPI_CASES.length} TODO cases): ${TODO_RELATED_MEASURE_AND_KPI_CASES.join('; ')}`);

    // ── Every statement through the one door, its bytes bounded ─
    ok(`${engine.name} joins: every statement on the wire went through warehouse() (${wire.length} sent, ${door.length} admitted)`,
      wire.length >= cases.length && wire.length === door.length, show(wire.map((w) => w.sql.slice(0, 120))));
    const billed = wire.flatMap((w) => (w.bytes === undefined ? [] : [w.bytes]));
    if (opts.maxBilled !== undefined) {
      ok(`${engine.name} joins: each statement billed at most ${opts.maxBilled} bytes (${billed.join(', ')})`, billed.length > 0 && billed.every((b) => b <= opts.maxBilled!), billed);
    }
    summary(`- ${engine.name} live joins: ${wire.length} statements${billed.length ? `, billed ${billed.reduce((a, b) => a + b, 0)} bytes` : ''}`);
  } finally {
    live.runBound = realRun;
    budget.setDailyCheckForTest(null);
    configSecrets.useSecretStore(null);
  }
}

/** joinJs's chart over `tables` (datasetId → rows as a copy holds them), drill-across lined up by the door's own code. */
async function referenceChart(P: string, datasetId: string, enc: VizEncoding, filters: FilterStep[], tables: Map<string, ReturnType<typeof fixture.importTyped>>): Promise<Reply> {
  const relsIpc: typeof import('../src/ipc/relationships') = require('../src/ipc/relationships');
  const joinJs: typeof import('../src/analysis/joinJs') = require('../src/analysis/joinJs');
  const vizData: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
  const { fanOutVizData }: typeof import('../src/ipc/vizFanOut') = require('../src/ipc/vizFanOut');
  const one = async (d: string, e: VizEncoding, f: FilterStep[]): Promise<Reply> => {
    const vj = await relsIpc.vizJoin(P, d, e, f);
    if (vj && !vj.join.ok) return { ok: false, error: vj.join.error };
    const own = tables.get(d)!;
    return { ok: true, ...(vj && vj.join.ok ? joinJs.joinedVizDataJs(vj.join.value, tables, vj.infos) : vizData.buildVizData(own.columns, own.rows, e, f)) };
  };
  // fanOutVizData is the plan and line-up a drill-across chart takes; each of its questions is joinJs's here.
  return ((await fanOutVizData(P, datasetId, enc, filters, one as Parameters<typeof fanOutVizData>[4])) as Reply | null) ?? one(datasetId, enc, filters);
}

// ── Each warehouse ───────────────────────────────────────────────────────────

/** Snowflake: the nightly's role is read-only, so each table is a defining query over literals (./liveParityLiteral). */
export async function runSnowflakeJoins(cfg: SnowflakeConfig): Promise<void> {
  const conn = (require('./warehouseLiveSnowflake') as typeof import('./warehouseLiveSnowflake')).snowflakeConnection(cfg);
  const engine: JoinEngine = {
    name: 'snowflake',
    load: async (_table, columns, rows) => ({ kind: 'sql', sql: literal.literalTwin(literal.SNOWFLAKE, 'snowflake', columns, rows) }),
    typeName: (s) => literal.SNOWFLAKE.name[s],
  };
  await runJoins(engine, { connectorId: 'snowflake', ...conn });
}

/** Whether BigQuery's joins run: they write their tables, so only into BIGQUERY_SCRATCH_DATASET. Set but no dataset name fails. */
export function bigqueryJoinsPlan(cfg: Pick<BigqueryConfig, 'scratch'>): { run: true; scratch: string } | { run: false; why: string; bad?: true } {
  const shape: typeof import('../src/connectors/bigqueryShape') = require('../src/connectors/bigqueryShape');
  if (!cfg.scratch) return { run: false, why: 'BIGQUERY_SCRATCH_DATASET is not set' };
  return shape.validDataset(cfg.scratch) ? { run: true, scratch: cfg.scratch } : { run: false, why: 'BIGQUERY_SCRATCH_DATASET is not a dataset name', bad: true };
}

/** One fixture table's script: CREATE OR REPLACE (idempotent), expiring on its own, over our own literals only. */
export function bigqueryFixtureScript(table: string, columns: StoredColumn[], rows: Cell[][], expiresAt: string): string {
  if (!/^[\w-]+\.\w+\.ordinate_join_\w+$/.test(table) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(expiresAt)) throw new Error('the fixture holds only our own names');
  return `CREATE OR REPLACE TABLE \`${table}\` OPTIONS (expiration_timestamp = TIMESTAMP '${expiresAt}') AS\n${literal.literalTwin(literal.BIGQUERY, 'bigquery', columns, rows)}`;
}

/** BigQuery: the three tables rewritten in the scratch dataset each run, with a `bigquery`-scope token minted for the scripts alone. */
export async function runBigqueryJoins(cfg: BigqueryConfig, inner?: import('../src/connectors/bigquery').Transport, ok: Ok = harnessOk): Promise<void> {
  const plan = bigqueryJoinsPlan(cfg);
  if (!plan.run && plan.bad) return ok('BigQuery joins: BIGQUERY_SCRATCH_DATASET is a dataset name (set but unusable fails, never skips)', false);
  if (!plan.run) {
    console.log(`skip BigQuery live joins: ${plan.why} (docs/server/live-data.md, "Testing against a real account")`);
    summary(`- BigQuery live joins: skipped — ${plan.why}`);
    return;
  }
  const auth: typeof import('../src/connectors/bigqueryAuth') = require('../src/connectors/bigqueryAuth');
  const bq: typeof import('../src/connectors/bigquery') = require('../src/connectors/bigquery');
  const shape: typeof import('../src/connectors/bigqueryShape') = require('../src/connectors/bigqueryShape');
  const http: typeof import('../src/connectors/http') = require('../src/connectors/http');
  const pt: typeof import('./warehouseLivePartitionTime') = require('./warehouseLivePartitionTime');
  const key = auth.parseKey(cfg.keyJson);
  if ('ok' in key) return ok('BigQuery joins: the key file is one this server accepts', false, key.error);
  secret('BigQuery key file', cfg.keyJson);
  const project = cfg.project || key.projectId || '';
  ident('bigquery project', project);
  ident('bigquery scratch dataset', plan.scratch);
  const send = inner ?? http.httpRequest;
  // Every token issued during the run, for the canary.
  bq.setTransport(async (o) => {
    if (o.url.hostname === auth.TOKEN_HOST) secret('BigQuery signed assertion', new URLSearchParams(o.body ?? '').get('assertion'));
    const r = await send(o);
    if (o.url.hostname === auth.TOKEN_HOST) {
      try { secret('BigQuery access token', String(shape.prop(JSON.parse(r.body), 'access_token') ?? '')); } catch { /* not a token reply */ }
    }
    return r;
  });
  try {
    const write = await pt.writeToken(key);
    if (!write.ok) return ok('BigQuery joins: a token that may write the fixture', false, keep(write).error);
    const expires = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const engine: JoinEngine = {
      name: 'bigquery',
      load: async (table, columns, rows) => {
        const said = await pt.runScript(write.token, project, bigqueryFixtureScript(`${project}.${plan.scratch}.${table}`, columns, rows, expires), cfg.location);
        if (said) throw new Error(`the fixture table ${table} was not written: ${said}`);
        return { kind: 'table', parts: [project, plan.scratch, table] };
      },
      typeName: (s) => literal.BIGQUERY.name[s],
    };
    const conn = (require('./warehouseLiveBigquery') as typeof import('./warehouseLiveBigquery')).bigqueryConnection(cfg);
    await runJoins(engine, { connectorId: 'bigquery', ...conn }, ok, { maxBilled: BQ_MAX_BILLED });
  } finally {
    bq.setTransport(null);
  }
}
