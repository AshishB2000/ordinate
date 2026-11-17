// Live charts across saved relationships (docs/live-data/00-plan.md L4; src/engine/live/compileJoin.ts, liveJoin.ts,
// src/ipc/liveJoin.ts), over the real RPC route against the fake warehouse (DuckDB dialect).
//
// One fixture is loaded twice: as Live datasets on ONE fake connection (Orders → Customers → Zones, and Orders →
// Customers again by ship-to, labelled) and as copies with the same relationships. Then:
//   1. PARITY: each joined chart (a related category; a related split; through a labelled link; two hops; a filter
//      on a related column; a related number category's bins and a related date's auto grain, each with its probe;
//      `in` over a related column with nulls; avg; a measure on a MANY side, by drill-across) is Object.is between Live, the copy's door (joinResident) and
//      joinJs over the copies' rows. The edge cases are in the rows: a key repeated with the same values, a NULL,
//      '' and whitespace key on either side (they match nothing), keys that match nothing, 'C1' beside 'c1', number
//      keys (a repeated zone, a NULL one), a hop after one that found nothing.
//   2. THE PICK (a key repeated with DIFFERENT values): Live keeps the row smallest by the columns read (NULL last,
//      text by bytes); the copy keeps the first in file order. Pinned: Live equals the copy whose rows hold that
//      row first (Object.is), and differs from the one that does not (the divergence is real).
//   3. NEGATIVE CONTROLS: without the one-row-per-key cut, the identical repeat doubles its rows and parity fails;
//      a Live dataset beside a copy, and on another connection, refuses typed (`related`) and sends nothing (the
//      same chart over one connection answers: case 1); a COPY whose link reaches a Live dataset (its category, or a
//      Live drill-across question on a copy many side) refuses typed, before any table is read (control: two copies);
//      a measure on a related table refuses (`relatedMeasure`);
//      a reverse hop refuses in the copy's own sentence; a number key linked to text refuses (`joinKeyTypes`).
//   4. LOCK: the executor under a lock on Customers equals joinJs over the locked customers (NEGATIVE CONTROL: no
//      lock, every customer).
//   5. CACHE AND BUDGET: a text axis is ONE statement, counted once by the daily limit under the primary; asked
//      again it is a cache hit; a Refresh of the RELATED dataset asks again; a related cache age of 0 always asks
//      (the lowest age wins; NEGATIVE CONTROL: back to 300, a hit).
//   6. REQUIRED RANGE: Customers' table requires a date filter, so its scan takes "Last 12 months" and the chart
//      says so; Object.is joinJs over the customers in range (NEGATIVE CONTROL: before the fact, every customer).
//   Throughout, no Live dataset is ever hydrated (the `getDataset` spy).
//
//   npm run build:ts && node scripts/test-liveJoins.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, hydrated, post } from './liveRouteHarness';
import type { Cell, FilterStep } from '../src/data/transforms';
import type { VizEncoding } from '../src/analysis/visuals';

const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const relsIpc: typeof import('../src/ipc/relationships') = require('../src/ipc/relationships');
const joinJs: typeof import('../src/analysis/joinJs') = require('../src/analysis/joinJs');
const compileJoin: typeof import('../src/engine/live/compileJoin') = require('../src/engine/live/compileJoin');
const fixture: typeof import('./liveParityFixture') = require('./liveParityFixture');
const store: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const liveRefusals: typeof import('../src/engine/liveRefusals') = require('../src/engine/liveRefusals');
const { fake, fakeMod, liveRecord, liveDataset, datasets, connections, budget, queryCache, ORG_A } = H;

const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x));
const as = <T>(fn: () => Promise<T>): Promise<T> => H.as(ORG_A, fn);
const M = (column: string, aggregation: string, datasetId?: string) => ({ column, aggregation: aggregation as import('../src/analysis/visuals').VizMeasure['aggregation'], ...(datasetId ? { datasetId } : {}) });

type Col = { name: string; type: 'text' | 'number' | 'date' };
const CUST_COLS: Col[] = [{ name: 'cid', type: 'text' }, { name: 'region', type: 'text' }, { name: 'seg', type: 'text' }, { name: 'zid', type: 'number' }, { name: 'since', type: 'date' }];
const CUST: Cell[][] = [
  ['c1', 'North', 'A', 1, '2024-01-10'],
  ['c2', 'South', 'B', 2, '2024-05-10'],
  ['c2', 'South', 'B', 2, '2024-05-10'], // the same key again, the same values: one row per key, as joinJs
  ['c4', 'East', null, 7, '2024-09-10'], // a null split value; zid 7 has no zone
  ['c5', 'West', 'A', null, '2024-11-02'], // no zone key: the next hop finds nothing
  [null, 'Nowhere', 'Z', 1, '2024-01-01'], // a NULL key matches nothing
  ['', 'Blank', 'Z', 1, '2024-01-01'], // nor does '' …
  ['  ', 'Spaces', 'Z', 1, '2024-01-01'], // … nor whitespace
  ['C1', 'Upper', 'B', 2, '2024-02-02'], // 'C1' is not 'c1'
];
const ZONE_COLS: Col[] = [{ name: 'zid', type: 'number' }, { name: 'zone', type: 'text' }];
const ZONE: Cell[][] = [[1, 'Z1'], [2, 'Z2'], [2, 'Z2'], [null, 'Znull'], [9, 'Z9']];
const ORDER_COLS: Col[] = [{ name: 'oid', type: 'text' }, { name: 'cid', type: 'text' }, { name: 'ship', type: 'text' }, { name: 'amt', type: 'number' }, { name: 'd', type: 'date' }];
const ORDERS: Cell[][] = [
  ['o1', 'c1', 'c2', 10, '2024-01-05'], ['o2', 'c1', 'c1', 20, '2024-02-05'], ['o3', 'c1', 'c4', 5, '2024-02-20'],
  ['o4', 'c2', 'c2', 7, '2024-01-15'], ['o5', 'c2', 'c9', 3, '2024-03-01'], ['o6', 'c2', 'c1', 11, '2024-03-09'],
  ['o7', 'c4', 'c4', 13, '2024-01-30'], ['o8', 'c4', null, 2, '2024-02-11'], ['o9', 'c5', 'c5', 17, '2024-03-02'],
  ['o10', 'c9', 'c2', 19, '2024-01-07'], ['o11', null, 'c1', 23, '2024-02-14'], ['o12', '', 'c2', 29, '2024-03-21'],
  ['o13', '  ', 'C1', 31, '2024-01-25'], ['o14', 'C1', 'c5', 37, '2024-02-27'], ['o15', 'c1', 'c2', 41, '2024-03-30'],
];

interface Side { orders: string; customers: string; zones: string; ship: string }

async function sides(P: string, connId: string): Promise<{ live: Side; copy: Side }> {
  return as(async () => {
    await fakeMod.loadWarehouseTable('lj_orders', ORDER_COLS, ORDERS);
    await fakeMod.loadWarehouseTable('lj_customers', CUST_COLS, CUST);
    await fakeMod.loadWarehouseTable('lj_zones', ZONE_COLS, ZONE);
    const live = async (name: string, table: string, columns: Col[]) => (await liveRecord.saveLiveRecord(P, { name, columns, origin: { kind: 'connection', connId, table } }))!.id;
    const copy = async (name: string, columns: Col[], rows: Cell[][]) => (await datasets.saveDataset(P, { name, sourceKind: 'csv', ...fixture.importTyped(columns, rows) }))!.id;
    const link = async (s: Omit<Side, 'ship'>): Promise<Side> => {
      await rels.saveRelationship(P, { from: { datasetId: s.orders, column: 'cid' }, to: { datasetId: s.customers, column: 'cid' }, cardinality: 'many_to_one' });
      await rels.saveRelationship(P, { from: { datasetId: s.customers, column: 'zid' }, to: { datasetId: s.zones, column: 'zid' }, cardinality: 'many_to_one' });
      const ship = await rels.saveRelationship(P, { from: { datasetId: s.orders, column: 'ship' }, to: { datasetId: s.customers, column: 'cid' }, cardinality: 'many_to_one', label: 'Ship to' });
      return { ...s, ship: ship!.id };
    };
    return {
      live: await link({ orders: await live('Orders', 'lj_orders', ORDER_COLS), customers: await live('Customers', 'lj_customers', CUST_COLS), zones: await live('Zones', 'lj_zones', ZONE_COLS) }),
      copy: await link({ orders: await copy('Orders copy', ORDER_COLS, ORDERS), customers: await copy('Customers copy', CUST_COLS, CUST), zones: await copy('Zones copy', ZONE_COLS, ZONE) }),
    };
  });
}

/** The chart joinJs draws over the copies' rows (analysis/joinJs, the reference), `tweak` changing a table first. */
async function joinJsChart(P: string, datasetId: string, enc: VizEncoding, filters: FilterStep[], tweak?: (id: string, rows: Cell[][]) => Cell[][]): Promise<Reply> {
  return as(async () => {
    const vj = await relsIpc.vizJoin(P, datasetId, enc, filters);
    if (!vj || !vj.join.ok) return { ok: false, error: vj && !vj.join.ok ? vj.join.error : 'no join' };
    const tables = new Map<string, { columns: import('../src/data/parse').ParsedColumn[]; rows: Cell[][] }>();
    for (const t of vj.join.value.plan.tables) {
      const ds = (await datasets.getDataset(P, t.datasetId))!;
      tables.set(t.datasetId, { columns: ds.columns, rows: tweak ? tweak(t.datasetId, ds.rows) : ds.rows });
    }
    const r = joinJs.joinedVizDataJs(vj.join.value, tables, vj.infos);
    return { ok: true, data: r.data };
  });
}

const chartOf = (r: Reply) => ({ labels: r.data.labels, series: r.data.series.map((s: Reply) => ({ name: s.name, values: s.values })) });
const EXACT = (): boolean => false; // integer amounts: every figure is exact, so Object.is

function problems(a: Reply, b: Reply, byName: boolean): string[] {
  if (!a || a.ok !== true || !b || b.ok !== true) return [`not both answered: ${show([a, b]).slice(0, 400)}`];
  return cmp.compareCharts(chartOf(a), chartOf(b), EXACT, byName);
}

void (async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const { live: L, copy: X } = await sides(P, s.connId);
  const liveIds = new Set([L.orders, L.customers, L.zones]);
  const hydratedBefore = hydrated.length;
  const refusedAs = (r: Reply, reason: string): boolean => r.ok === false && r.code === 'live_refused' && r.reason === reason && typeof r.error === 'string' && !('data' in r);
  const chart = async (d: string, encoding: VizEncoding, filters: FilterStep[] = []): Promise<Reply> => (await post('visual:data', { projectId: P, datasetId: d, encoding, filters })).value;

  // ── 1. Parity: Live = the copy's door = joinJs, on the edge-case rows ──
  type Case = [string, (x: Side) => VizEncoding, (x: Side) => FilterStep[], boolean];
  const cases: Case[] = [
    ['a related category (repeat, NULL, \'\', whitespace, unmatched and case-variant keys)', (x) => ({ category: 'region', categoryDatasetId: x.customers, values: [M('amt', 'sum')] }), () => [], false],
    ['a related split under a month axis (a null split value)', (x) => ({ category: 'd', grain: 'month', series: 'seg', seriesDatasetId: x.customers, values: [M('amt', 'sum')] }), () => [], true],
    ['a category through the labelled "Ship to" link', (x) => ({ category: 'region', categoryDatasetId: x.customers, categoryVia: x.ship, values: [M('oid', 'count')] }), () => [], false],
    ['two hops, Orders → Customers → Zones (number keys; a hop after one that found nothing)', (x) => ({ category: 'zone', categoryDatasetId: x.zones, values: [M('amt', 'sum')] }), () => [], false],
    ['a filter on a related column (`!=` keeps the unmatched rows, as a copy)', () => ({ category: 'cid', values: [M('amt', 'sum')] }), () => [{ type: 'filter', column: 'region', op: '!=', value: 'North' }], false],
    ['a related number category: its bins (a probe, then the chart)', (x) => ({ category: 'zid', categoryDatasetId: x.customers, values: [M('amt', 'sum')] }), () => [], false],
    ['a related date category: its auto grain (a probe, then the chart)', (x) => ({ category: 'since', categoryDatasetId: x.customers, values: [M('amt', 'sum')] }), () => [], false],
    ['`in` on a related column with nulls, and a primary filter inside the scan', (x) => ({ category: 'region', categoryDatasetId: x.customers, values: [M('amt', 'sum')] }), () => [{ type: 'filter', column: 'seg', op: 'in', values: ['A'] }, { type: 'filter', column: 'amt', op: '>', value: 4 }], false],
    ['avg and count by a related category', (x) => ({ category: 'region', categoryDatasetId: x.customers, values: [M('amt', 'avg'), M('amt', 'count')] }), () => [], false],
  ];
  for (const [label, enc, flt, split] of cases) {
    const live = await chart(L.orders, enc(L), flt(L));
    const copy = await chart(X.orders, enc(X), flt(X));
    const ref = await joinJsChart(P, X.orders, enc(X), flt(X));
    const a = problems(copy, live, split);
    const b = problems(ref, live, split);
    ok(`parity, ${label}: Live = the copy (joinResident) = joinJs, Object.is`, a.length === 0 && b.length === 0, [...a, ...b].join(' | ') || show(live.data));
    ok(`…${label}: dated live`, live.asOf?.mode === 'live', show(live.asOf));
  }
  {
    // A measure on the many side (drill-across, analysis/fanOutPlan): Orders' own question by Customers' region, as a copy asks it.
    const enc = (x: Side): VizEncoding => ({ category: 'region', values: [M('zid', 'sum'), M('amt', 'sum', x.orders)] });
    const live = await chart(L.customers, enc(L));
    const copy = await chart(X.customers, enc(X));
    const p = problems(copy, live, false);
    ok('a measure on a MANY side (drill-across): one question per table, each across its link on the warehouse — Object.is the copy\'s, its notes too',
      p.length === 0 && show(live.notes) === show(copy.notes) && live.asOf?.mode === 'live', p.join(' | ') || show([live, copy]).slice(0, 600));
  }
  {
    // A many-side measure whose plan refuses (its category on the many side too): the planner's sentence, typed as Live's.
    const enc = (x: Side): VizEncoding => ({ category: 'oid', categoryDatasetId: x.orders, values: [M('amt', 'sum', x.orders)] });
    const live = await chart(L.customers, enc(L));
    const copy = await chart(X.customers, enc(X));
    ok('a drill-across the planner refuses: typed (live_refused, related) on Live, in the copy\'s sentence', refusedAs(live, 'related') && copy.ok === false
      && live.error === copy.error.replace(/Orders copy/g, 'Orders').replace(/Customers copy/g, 'Customers'), show([live, copy]));
  }
  const blank = await chart(L.orders, { category: 'region', categoryDatasetId: L.customers, values: [M('amt', 'sum')] });
  ok('the rows no customer matched are ONE blank category (o10 c9, o11 NULL, o12 \'\', o13 whitespace: 19+23+29+31)', blank.ok && blank.data.series[0].values[blank.data.labels.indexOf('')] === 102, show(blank.data));
  ok('…and the repeated c2 counts its orders once (7+3+11)', blank.ok && blank.data.series[0].values[blank.data.labels.indexOf('South')] === 21, show(blank.data));

  // ── 2. The pick: a key whose rows disagree ──
  const PICK_COLS: Col[] = [{ name: 'k', type: 'text' }, { name: 'name', type: 'text' }];
  const PICK: Cell[][] = [['k1', 'West'], ['k1', 'East'], ['k2', 'North'], ['k3', null], ['k3', 'Alpha']]; // file order: West, then a null
  const PICKED: Cell[][] = [['k1', 'East'], ['k1', 'West'], ['k2', 'North'], ['k3', 'Alpha'], ['k3', null]]; // the smallest first: bytes, NULL last
  const BUYS_COLS: Col[] = [{ name: 'k', type: 'text' }, { name: 'n', type: 'number' }];
  const BUYS: Cell[][] = [['k1', 5], ['k2', 7], ['k1', 1], ['k3', 4]];
  const pick = await as(async () => {
    await fakeMod.loadWarehouseTable('lj_pick', PICK_COLS, PICK);
    await fakeMod.loadWarehouseTable('lj_buys', BUYS_COLS, BUYS);
    const lp = (await liveRecord.saveLiveRecord(P, { name: 'Names', columns: PICK_COLS, origin: { kind: 'connection', connId: s.connId, table: 'lj_pick' } }))!.id;
    const lb = (await liveRecord.saveLiveRecord(P, { name: 'Buys', columns: BUYS_COLS, origin: { kind: 'connection', connId: s.connId, table: 'lj_buys' } }))!.id;
    const xb = (await datasets.saveDataset(P, { name: 'Buys copy', sourceKind: 'csv', ...fixture.importTyped(BUYS_COLS, BUYS) }))!.id;
    const xp = (await datasets.saveDataset(P, { name: 'Names copy', sourceKind: 'csv', ...fixture.importTyped(PICK_COLS, PICK) }))!.id;
    for (const [f, t] of [[lb, lp], [xb, xp]]) await rels.saveRelationship(P, { from: { datasetId: f, column: 'k' }, to: { datasetId: t, column: 'k' }, cardinality: 'many_to_one' });
    return { lp, lb, xb, xp };
  });
  const PICK_ENC = (d: string): VizEncoding => ({ category: 'name', categoryDatasetId: d, values: [M('n', 'sum')] });
  const livePick = await chart(pick.lb, PICK_ENC(pick.lp));
  const filePick = await joinJsChart(P, pick.xb, PICK_ENC(pick.xp), []);
  const smallPick = await joinJsChart(P, pick.xb, PICK_ENC(pick.xp), [], (id, rows) => (id === pick.xp ? fixture.importTyped(PICK_COLS, PICKED).rows : rows));
  ok('THE PICK (pinned divergence): Live keeps the smallest row of a repeated key (East over West, Alpha over NULL) — Object.is joinJs with that row first',
    problems(smallPick, livePick, false).length === 0, problems(smallPick, livePick, false).join(' | ') || show(livePick.data));
  ok('…and it IS a divergence: joinJs in file order shows West and the blank category instead', problems(filePick, livePick, false).length > 0
    && filePick.ok && filePick.data.labels.includes('West') && filePick.data.labels.includes(''), show([filePick.data, livePick.data]));

  // ── 3. Negative controls and refusals ──
  {
    const enc = (x: Side): VizEncoding => ({ category: 'region', categoryDatasetId: x.customers, values: [M('amt', 'sum')] });
    compileJoin.setJoinCutForTest(false);
    await as(async () => { queryCache.invalidateDataset(L.orders, P); });
    const uncut = await chart(L.orders, enc(L)).finally(() => compileJoin.setJoinCutForTest(true));
    await as(async () => { queryCache.invalidateDataset(L.orders, P); });
    const p = problems(await chart(X.orders, enc(X)), uncut, false);
    ok('NEGATIVE CONTROL: without the one-row-per-key cut, the repeated c2 doubles its orders and parity fails', p.length > 0
      && uncut.ok && uncut.data.series[0].values[uncut.data.labels.indexOf('South')] === 42, p.join(' | '));
  }
  const quiet = async (fn: () => Promise<Reply>): Promise<{ r: Reply; calls: number }> => { const before = fake.calls.length; const r = await fn(); return { r, calls: fake.calls.length - before }; };
  {
    // Orders (Live) → a COPY of customers: no one engine holds both.
    await as(() => rels.saveRelationship(P, { from: { datasetId: L.orders, column: 'oid' }, to: { datasetId: X.customers, column: 'cid' }, cardinality: 'many_to_one', label: 'Copy link' }));
    const { r, calls } = await quiet(() => chart(L.orders, { category: 'region', categoryDatasetId: X.customers, values: [M('amt', 'sum')] }));
    ok('a Live dataset beside a copy: refused, typed (related), in the sentence that names both — nothing sent', refusedAs(r, 'related') && calls === 0
      && r.error === await as(async () => liveRefusals.liveJoinMixed('Orders', 'Customers copy')), show(r));
  }
  {
    const other = await as(async () => {
      const conn = (await connections.saveConnection(P, { name: 'Second warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: {} }))!;
      const id = (await liveRecord.saveLiveRecord(P, { name: 'Far zones', columns: ZONE_COLS, origin: { kind: 'connection', connId: conn.id, table: 'lj_zones' } }))!.id;
      await rels.saveRelationship(P, { from: { datasetId: L.customers, column: 'zid' }, to: { datasetId: id, column: 'zid' }, cardinality: 'many_to_one', label: 'Far' });
      return id;
    });
    const { r, calls } = await quiet(() => chart(L.customers, { category: 'zone', categoryDatasetId: other, values: [M('cid', 'count')] }));
    ok('Live datasets on two connections: refused, typed (related), nothing sent — NEGATIVE CONTROL of case 1 (one connection answers)', refusedAs(r, 'related') && calls === 0
      && r.error === await as(async () => liveRefusals.liveJoinApart('Customers', 'Far zones')), show(r));
  }
  {
    const r = await chart(L.orders, { category: 'region', categoryDatasetId: L.customers, values: [M('zid', 'sum', L.customers)] });
    ok('a measure on a related table: refused, typed (relatedMeasure)', refusedAs(r, 'relatedMeasure'), show(r));
    const rev = await chart(L.customers, { category: 'oid', categoryDatasetId: L.orders, values: [M('cid', 'count')] });
    const revCopy = await chart(X.customers, { category: 'oid', categoryDatasetId: X.orders, values: [M('cid', 'count')] });
    ok('a reverse hop (Customers → its many side): refused, typed (related), in the copy\'s own sentence', refusedAs(rev, 'related') && revCopy.ok === false
      && rev.error === revCopy.error.replace(/Orders copy/g, 'Orders').replace(/Customers copy/g, 'Customers'), show([rev, revCopy]));
    const byAmt = await as(() => rels.saveRelationship(P, { from: { datasetId: L.orders, column: 'amt' }, to: { datasetId: L.customers, column: 'cid' }, cardinality: 'many_to_one', label: 'By amount' }));
    const types = await chart(L.orders, { category: 'region', categoryDatasetId: L.customers, categoryVia: byAmt!.id, values: [M('amt', 'sum')] });
    ok('a number key linked to a text one: refused, typed (joinKeyTypes), naming the column', refusedAs(types, 'joinKeyTypes') && types.error.includes('"amt"'), show(types));
    await as(() => rels.deleteRelationship(P, byAmt!.id));
  }
  {
    // A COPY's join that reaches a Live dataset, both ways in: a copy's category from the Live Customers, and a Live chart's
    // drill-across question on a copy many side (Orders copy → Live Customers). Said, typed, before any table is read.
    const mixed = await as(() => rels.saveRelationship(P, { from: { datasetId: X.orders, column: 'cid' }, to: { datasetId: L.customers, column: 'cid' }, cardinality: 'many_to_one', label: 'Live customers' }));
    const from = hydrated.length;
    const sentence = await as(async () => liveRefusals.liveJoinMixed('Customers', 'Orders copy'));
    const copyCat = await quiet(() => chart(X.orders, { category: 'region', categoryDatasetId: L.customers, categoryVia: mixed!.id, values: [M('amt', 'sum')] }));
    ok('a copy whose category comes from a Live dataset: refused, typed (related), in the mix sentence — nothing sent, nothing hydrated',
      refusedAs(copyCat.r, 'related') && copyCat.r.error === sentence && copyCat.calls === 0, show(copyCat.r));
    const drill = await quiet(() => chart(L.customers, { category: 'region', values: [M('zid', 'sum'), M('amt', 'sum', X.orders)] }));
    ok('a Live chart whose many-side measure is on a copy: its drill-across question refused the same way — nothing sent, nothing hydrated',
      refusedAs(drill.r, 'related') && drill.r.error === sentence && drill.calls === 0, show(drill.r));
    ok('…and neither hydrated a Live dataset', !hydrated.slice(from).some((id) => liveIds.has(id)), show(hydrated.slice(from)));
    const both = await chart(X.orders, { category: 'region', categoryDatasetId: X.customers, values: [M('amt', 'sum')] });
    ok('NEGATIVE CONTROL: the same link between two copies answers', both.ok === true, show(both).slice(0, 200));
    await as(() => rels.deleteRelationship(P, mixed!.id));
  }

  // ── 4. A lock on the related side ──
  {
    const enc = (x: Side): VizEncoding => ({ category: 'region', categoryDatasetId: x.customers, values: [M('amt', 'sum')] });
    const lq: typeof import('../src/engine/live/liveQuery') = require('../src/engine/live/liveQuery');
    const lj: typeof import('../src/ipc/liveJoin') = require('../src/ipc/liveJoin');
    const LOCK: FilterStep = { type: 'filter', column: 'region', op: 'in', values: ['North', 'East'], lock: true };
    const planned = await as(async () => lj.liveJoinOf(P, (await datasets.getDatasetMeta(P, L.orders))!, enc(L), []));
    const req = planned && planned.ok ? planned.req : null;
    const locked = req ? await as(() => lq.liveJoinedVizData(P, { ...req, tables: req.tables.map((t, i) => ({ ...t, lock: i ? [LOCK] : [] })) })) : null;
    const ref = await joinJsChart(P, X.orders, enc(X), [], (id, rows) => (id === X.customers ? rows.filter((r) => r[1] === 'North' || r[1] === 'East') : rows));
    const open = await chart(L.orders, enc(L));
    ok('a lock on Customers: its rows only — Object.is joinJs over the locked customers', !!locked && problems(ref, locked as Reply, false).length === 0, locked ? problems(ref, locked as Reply, false).join(' | ') : show(planned));
    ok('NEGATIVE CONTROL: without the lock, South and West are there', problems(ref, open, false).length > 0 && open.data.labels.includes('South'), show(open.data));
  }

  // ── 5. One statement, the budget, the cache under every epoch ──
  {
    const enc: VizEncoding = { category: 'seg', categoryDatasetId: L.customers, values: [M('amt', 'sum')] };
    const counted: string[] = [];
    budget.setDailyCheckForTest((_org, id) => { counted.push(id); return { ok: true }; });
    const first = await quiet(() => chart(L.orders, enc));
    ok('a text axis across a link is ONE warehouse statement, counted once by the daily limit, under the primary', first.r.ok && first.calls === 1 && show(counted) === show([L.orders]), show({ calls: first.calls, counted }));
    const again = await quiet(() => chart(L.orders, enc));
    ok('…asked again inside the cache age: the cache answers, nothing sent', again.r.ok && again.calls === 0 && again.r.asOf?.cached === true, show({ calls: again.calls, asOf: again.r.asOf }));
    await as(() => liveDataset.bumpEpoch(P, L.customers));
    const refreshed = await quiet(() => chart(L.orders, enc));
    ok('…a Refresh of the RELATED dataset moves the key: asked again', refreshed.r.ok && refreshed.calls === 1, show({ calls: refreshed.calls }));
    await as(() => liveDataset.setMaxCacheAge(P, L.customers, 0));
    const zero = await quiet(() => chart(L.orders, enc));
    ok('…a related cache age of 0 wins over the primary\'s 300: always asked', zero.r.ok && zero.calls === 1, show({ calls: zero.calls }));
    await as(() => liveDataset.setMaxCacheAge(P, L.customers, 300));
    await quiet(() => chart(L.orders, enc));
    const hit = await quiet(() => chart(L.orders, enc));
    ok('NEGATIVE CONTROL: back to 300, a hit', hit.r.ok && hit.calls === 0, show({ calls: hit.calls }));
    budget.setDailyCheckForTest(null);
  }

  // ── 6. The related table requires a date range ──
  {
    const enc = (x: Side): VizEncoding => ({ category: 'region', categoryDatasetId: x.customers, values: [M('amt', 'sum')] });
    const before = await chart(L.orders, enc(L));
    await as(async () => {
      const made = await store.createSourceDoc(P, s.connId, 'lj_customers', {});
      if (!made.ok) throw new Error('fixture: a source doc');
      await store.updateSourceDoc(P, s.connId, made.docId, (d) => ({ ...d, facts: { columns: [{ name: 'since', type: 'DATE' }], partition: { columns: ['since'], method: 'DAY', required: true }, readAt: '2025-03-01T00:00:00Z', readBy: 'ana' } }));
      await liveDataset.bumpEpoch(P, L.customers);
    });
    const ranged = await chart(L.orders, enc(L));
    // REQUIRED_RANGE on ORDINATE_TODAY 2025-03-15: 2024-03-01 to 2025-02-28. c1 (2024-01-10) falls out.
    const ref = await joinJsChart(P, X.orders, enc(X), [], (id, rows) => (id === X.customers ? rows.filter((r) => typeof r[4] === 'string' && r[4] >= '2024-03-01' && r[4] <= '2025-02-28') : rows));
    const p = problems(ref, ranged, false);
    ok('a related table that requires a date range: its scan takes "Last 12 months" — Object.is joinJs over the customers in range', p.length === 0, p.join(' | ') || show(ranged.data));
    ok('…and the chart says so', Array.isArray(ranged.notes) && ranged.notes.some((n: string) => /12 months/.test(n)), show(ranged.notes));
    ok('NEGATIVE CONTROL: before the fact, every customer (North is there) and no note', before.ok && before.data.labels.includes('North') && !before.notes && !ranged.data.labels.includes('North'), show([before.data.labels, ranged.data.labels]));
  }

  ok('no Live dataset was ever hydrated', !hydrated.slice(hydratedBefore).some((id) => liveIds.has(id) || id === pick.lp || id === pick.lb), show(hydrated.slice(hydratedBefore)));
})()
  .catch((e) => ok('live joins suite threw', false, e && (e as Error).stack))
  .then(() => close())
  .finally(() => finish());
