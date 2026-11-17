// A measure on a related table, and a KPI across a link, on Live (docs/live-data/00-plan.md L4; src/engine/live/compileJoin.ts
// rule 3, compile.ts, src/ipc/liveJoin.ts), over the real RPC route against the fake warehouse (DuckDB dialect).
//
// One fixture loaded twice — Live datasets on ONE fake connection, and copies with the same relationships — and every
// figure asked three ways over the same rows: Live (the warehouse), joinResident (the copy's SQL, called directly and
// asserted non-null) and joinJs (the reference over the copies' rows), Object.is.
//   1. RELATED MEASURES: sum, avg, count, min, max and countd of a Customers column, by a PRIMARY category (one customer
//      reached by several orders in one channel: the fan-in mask is what decides) and by a RELATED category. The rows
//      hold a repeated one-side key (identical values), NULL, '' and whitespace keys on both sides, unmatched and
//      case-variant keys, a NULL measure cell.
//   2. THE FOLD: 60 text categories with a related measure. joinJs ranks the top 50 on the UNMASKED first measure, then
//      masks per folded key, so a related row reached from two tail categories counts once in "Other".
//   3. KPIs: a related filter, a related measure (masked over the whole result), both; under a lock on the related
//      table; one statement, counted once, cached under the related epoch.
//   4. DRILL-ACROSS KPI: a measure on the MANY side is that table's own KPI on Live too, as the copy's (and its chart's);
//      across a mix (a Live primary with a copy many side, a copy primary with a Live one) a filter on the primary
//      refuses typed in the mix sentence, nothing sent or hydrated (NEGATIVE CONTROL: unfiltered, the Live side answers).
//   A related measure that is also the category: no masked row leaves its group, on Live, joinResident and joinJs alike.
//   5. NEGATIVE CONTROLS: without the mask, sum and count by the primary category and the KPI take the by-hand unmasked
//      figures and disagree with joinJs; a chart across a reverse hop refuses, and a KPI filter only a reverse hop reaches
//      is skipped as the copy skips it; a mix (a copy, two connections) and a deleted relationship refuse typed on a KPI.
//   Throughout, no Live dataset is ever hydrated (the `getDataset` spy).
//
//   npm run build:ts && node scripts/test-liveJoinMeasures.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, hydrated, post } from './liveRouteHarness';
import type { Cell, FilterStep, TableData } from '../src/data/transforms';
import type { VizEncoding, VizMeasure } from '../src/analysis/visuals';
import type { MetricAggregation } from '../src/analysis/metricValue';

const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const relsIpc: typeof import('../src/ipc/relationships') = require('../src/ipc/relationships');
const joinJs: typeof import('../src/analysis/joinJs') = require('../src/analysis/joinJs');
const joinResident: typeof import('../src/engine/joinResident') = require('../src/engine/joinResident');
const compileJoin: typeof import('../src/engine/live/compileJoin') = require('../src/engine/live/compileJoin');
const lq: typeof import('../src/engine/live/liveQuery') = require('../src/engine/live/liveQuery');
const lj: typeof import('../src/ipc/liveJoin') = require('../src/ipc/liveJoin');
const fixture: typeof import('./liveParityFixture') = require('./liveParityFixture');
const liveRefusals: typeof import('../src/engine/liveRefusals') = require('../src/engine/liveRefusals');
const { fakeMod, fake, liveRecord, liveDataset, datasets, connections, budget, queryCache, ORG_A } = H;

const show = (v: unknown): string => JSON.stringify(v, (_k, x) => (Object.is(x, -0) ? '-0' : x));
const as = <T>(fn: () => Promise<T>): Promise<T> => H.as(ORG_A, fn);
const M = (column: string, aggregation: string, datasetId?: string): VizMeasure => ({ column, aggregation: aggregation as VizMeasure['aggregation'], ...(datasetId ? { datasetId } : {}) });

type Col = { name: string; type: 'text' | 'number' | 'date' };
const CUST_COLS: Col[] = [{ name: 'cid', type: 'text' }, { name: 'region', type: 'text' }, { name: 'seg', type: 'text' }, { name: 'target', type: 'number' }];
const CUST: Cell[][] = [
  ['c1', 'North', 'A', 100], ['c2', 'South', 'B', 40], ['c2', 'South', 'B', 40], // c2 twice, the same values: one row per key
  ['c3', 'North', 'B', 25], ['c4', 'East', null, null], ['c5', 'West', 'A', 7], // a NULL measure cell
  [null, 'Nowhere', 'Z', 1000], ['', 'Blank', 'Z', 2000], ['  ', 'Spaces', 'Z', 3000], ['C1', 'Upper', 'B', 13], // empty keys match nothing
];
const ORDER_COLS: Col[] = [{ name: 'oid', type: 'text' }, { name: 'cid', type: 'text' }, { name: 'ch', type: 'text' }, { name: 'amt', type: 'number' }];
const ORDERS: Cell[][] = [
  ['o1', 'c1', 'web', 10], ['o2', 'c1', 'web', 20], ['o3', 'c1', 'shop', 5], ['o4', 'c2', 'web', 7], ['o5', 'c2', 'web', 3],
  ['o6', 'c3', 'shop', 11], ['o7', 'c4', 'web', 13], ['o8', 'c5', null, 2], ['o9', 'c9', 'web', 17], ['o10', null, 'shop', 19],
  ['o11', '', 'web', 23], ['o12', '  ', 'shop', 29], ['o13', 'C1', 'web', 31], ['o14', 'c3', 'web', 37], ['o15', 'c1', '', 41],
];
// The fold: 60 categories. p00–p48 rank first on the unmasked total; p49 (two orders of one owner: 80 unmasked, 40
// masked) is 50th only UNMASKED, ahead of p50 (60 either way); p58 and p59 reach the same owner, once in "Other".
const ITEM_COLS: Col[] = [{ name: 'iid', type: 'text' }, { name: 'cat', type: 'text' }, { name: 'own', type: 'text' }];
const OWNER_COLS: Col[] = [{ name: 'own', type: 'text' }, { name: 'w', type: 'number' }];
const pad = (i: number): string => `p${String(i).padStart(2, '0')}`;
const OWNERS: Cell[][] = [...Array.from({ length: 48 }, (_x, i) => [`w${i}`, 1000 - 10 * i]), ['w48', 100], ['w49', 40], ['w50', 60],
  ...Array.from({ length: 7 }, (_x, k) => [`w${51 + k}`, k + 1]), ['shared', 9]];
const ITEMS: Cell[][] = [...Array.from({ length: 51 }, (_x, i) => [`i${i}`, pad(i), `w${i}`]), ['i49b', 'p49', 'w49'],
  ...Array.from({ length: 7 }, (_x, k) => [`i${51 + k}`, pad(51 + k), `w${51 + k}`]), ['i58', 'p58', 'shared'], ['i59', 'p59', 'shared']];

interface Side { orders: string; customers: string; items: string; owners: string }

async function sides(P: string, connId: string): Promise<{ live: Side; copy: Side }> {
  return as(async () => {
    const tables: [string, Col[], Cell[][]][] = [['jm_orders', ORDER_COLS, ORDERS], ['jm_customers', CUST_COLS, CUST], ['jm_items', ITEM_COLS, ITEMS], ['jm_owners', OWNER_COLS, OWNERS]];
    for (const [t, c, r] of tables) await fakeMod.loadWarehouseTable(t, c, r);
    const live = async (name: string, table: string, columns: Col[]) => (await liveRecord.saveLiveRecord(P, { name, columns, origin: { kind: 'connection', connId, table } }))!.id;
    const copy = async (name: string, columns: Col[], rows: Cell[][]) => (await datasets.saveDataset(P, { name, sourceKind: 'csv', ...fixture.importTyped(columns, rows) }))!.id;
    const link = async (s: Side): Promise<Side> => {
      await rels.saveRelationship(P, { from: { datasetId: s.orders, column: 'cid' }, to: { datasetId: s.customers, column: 'cid' }, cardinality: 'many_to_one' });
      await rels.saveRelationship(P, { from: { datasetId: s.items, column: 'own' }, to: { datasetId: s.owners, column: 'own' }, cardinality: 'many_to_one' });
      return s;
    };
    return {
      live: await link({ orders: await live('Orders', 'jm_orders', ORDER_COLS), customers: await live('Customers', 'jm_customers', CUST_COLS), items: await live('Items', 'jm_items', ITEM_COLS), owners: await live('Owners', 'jm_owners', OWNER_COLS) }),
      copy: await link({ orders: await copy('Orders copy', ORDER_COLS, ORDERS), customers: await copy('Customers copy', CUST_COLS, CUST), items: await copy('Items copy', ITEM_COLS, ITEMS), owners: await copy('Owners copy', OWNER_COLS, OWNERS) }),
    };
  });
}

async function tablesOf(P: string, plan: { tables: { datasetId: string }[] }, tweak?: (id: string, rows: Cell[][]) => Cell[][]): Promise<Map<string, TableData>> {
  const out = new Map<string, TableData>();
  for (const t of plan.tables) {
    const ds = (await datasets.getDataset(P, t.datasetId))!;
    out.set(t.datasetId, { columns: ds.columns, rows: tweak ? tweak(t.datasetId, ds.rows) : ds.rows });
  }
  return out;
}

/** The copy's chart both ways: joinResident (asserted non-null by the caller) and joinJs. */
async function copyCharts(P: string, datasetId: string, enc: VizEncoding, filters: FilterStep[]): Promise<{ resident: Reply | null; js: Reply }> {
  return as(async () => {
    const vj = await relsIpc.vizJoin(P, datasetId, enc, filters);
    if (!vj || !vj.join.ok) return { resident: null, js: { ok: false, error: vj && !vj.join.ok ? vj.join.error : 'no join' } };
    const sources = await relsIpc.residentSources(P, vj.join.value.plan);
    const fast = sources ? await joinResident.joinedAggregateResident(sources, vj.join.value, vj.infos) : null;
    const js = joinJs.joinedVizDataJs(vj.join.value, await tablesOf(P, vj.join.value.plan), vj.infos);
    return { resident: fast ? { ok: true, data: fast.data } : null, js: { ok: true, data: js.data } };
  });
}

/** The copy's KPI both ways: joinResident and joinJs (`tweak` changes a table first, joinJs only). */
async function copyKpis(P: string, datasetId: string, column: string, aggregation: MetricAggregation, filters: FilterStep[], tweak?: (id: string, rows: Cell[][]) => Cell[][]): Promise<{ resident: number | null; js: number | null; planned: boolean }> {
  return as(async () => {
    const mj = await relsIpc.metricJoin(P, datasetId, column, filters);
    if (!mj || !mj.planned.ok) return { resident: null, js: null, planned: false };
    const { plan, layout, column: merged, table, filters: flt } = mj.planned.value;
    const sources = await relsIpc.residentSources(P, plan);
    const resident = sources ? await joinResident.joinedMetricResident(sources, plan, layout, mj.infos, { column: merged, aggregation }, flt) : null;
    const js = joinJs.joinedMetricJs(plan, layout, await tablesOf(P, plan, tweak), mj.infos, { column: merged, aggregation, table }, flt);
    return { resident, js, planned: true };
  });
}

// A related measure's series is named after its dataset: "Customers copy.target" is the copy's "Customers.target".
const chartOf = (r: Reply) => ({ labels: r.data.labels, series: r.data.series.map((s: Reply) => ({ name: String(s.name).replace(/ copy\./g, '.'), values: s.values })) });
const EXACT = (): boolean => false; // integer figures and one division each side: Object.is

function problems(a: Reply | null, b: Reply): string[] {
  if (!a || a.ok !== true || !b || b.ok !== true) return [`not both answered: ${show([a, b]).slice(0, 400)}`];
  return cmp.compareCharts(chartOf(a), chartOf(b), EXACT, false);
}

void (async () => {
  const s = await H.setupOrg(ORG_A);
  const P = s.projectId;
  const { live: L, copy: X } = await sides(P, s.connId);
  const liveIds = new Set([L.orders, L.customers, L.items, L.owners]);
  const hydratedBefore = hydrated.length;
  const chart = async (d: string, encoding: VizEncoding, filters: FilterStep[] = []): Promise<Reply> => (await post('visual:data', { projectId: P, datasetId: d, encoding, filters })).value;
  const kpi = async (d: string, column: string, aggregation: string, filters: FilterStep[] = []): Promise<Reply> => (await post('dashboard:metric', { projectId: P, datasetId: d, column, aggregation, filters })).value;
  const refusedAs = (r: Reply, reason: string): boolean => r && r.ok === false && r.code === 'live_refused' && r.reason === reason && typeof r.error === 'string';
  const quiet = async (fn: () => Promise<Reply>): Promise<{ r: Reply; calls: number }> => { const before = fake.calls.length; const r = await fn(); return { r, calls: fake.calls.length - before }; };

  // ── 1. A related measure, every aggregation, by a primary and by a related category ──
  const AGGS = ['sum', 'avg', 'count', 'min', 'max', 'countd'];
  for (const agg of AGGS) {
    for (const [by, enc] of [
      ['a primary category (one customer, many orders per channel)', (x: Side): VizEncoding => ({ category: 'ch', values: [M('target', agg, x.customers)] })],
      ['a related category', (x: Side): VizEncoding => ({ category: 'region', categoryDatasetId: x.customers, values: [M('target', agg, x.customers), M('amt', 'sum')] })],
    ] as const) {
      const live = await chart(L.orders, enc(L));
      const { resident, js } = await copyCharts(P, X.orders, enc(X), []);
      const p = [...problems(resident, live), ...problems(js, live)];
      ok(`${agg} of a related measure by ${by}: Live = joinResident = joinJs, Object.is`, p.length === 0 && live.asOf?.mode === 'live', p.join(' | ') || show(live.data));
    }
  }
  {
    // A related filter and a split beside the related measure, and a primary filter inside the scan.
    const enc = (x: Side): VizEncoding => ({ category: 'ch', series: 'seg', seriesDatasetId: x.customers, values: [M('target', 'sum', x.customers)] });
    const flt: FilterStep[] = [{ type: 'filter', column: 'region', op: '!=', value: 'West' }, { type: 'filter', column: 'amt', op: '>', value: 2 }];
    const live = await chart(L.orders, enc(L), flt);
    const { js } = await copyCharts(P, X.orders, enc(X), flt);
    const p = cmp.compareCharts(chartOf(js), chartOf(live), EXACT, true);
    ok('a related measure under a related split and filters (masked per category AND series): Live = joinJs', live.ok && p.length === 0, p.join(' | ') || show(live));
  }
  {
    // The measure column is the category column. The mask must not move a row out of its group: joinResident and Live
    // mask a copy of the cell and keep the key, and joinJs reads a hidden copy of the key (keyCopies). Before that fix,
    // joinJs moved North's later orders to the blank category (North's sum of amt read 21).
    const enc = (x: Side): VizEncoding => ({ category: 'region', categoryDatasetId: x.customers, values: [M('region', 'count', x.customers), M('amt', 'sum')] });
    const live = await chart(L.orders, enc(L));
    const { resident, js } = await copyCharts(P, X.orders, enc(X), []);
    const p = problems(resident, live);
    ok('a related measure that IS the category (count of region by region): Live = joinResident, Object.is', p.length === 0, p.join(' | ') || show(live.data));
    const q = problems(js, live);
    ok('…and Live = joinJs too: no row leaves its group (North is not the 21 the unfixed joinJs gave)', q.length === 0
      && js.data.series[1].values[js.data.labels.indexOf('North')] !== 21, q.join(' | ') || show(js.data));
  }
  {
    const web = await chart(L.orders, { category: 'ch', values: [M('target', 'sum', L.customers)] });
    // web: c1 (100, o1 and o2), c2 (40, o4 and o5; its repeated row joined once), c3 (25), c4 (NULL), C1 (13); o9, o11 match nothing.
    ok('the mask by hand: web counts c1 once and c2 once — 100 + 40 + 25 + 13 = 178, not 100·2 + 40·2 + 25 + 13', web.ok && web.data.series[0].values[web.data.labels.indexOf('web')] === 178, show(web.data));
  }

  // ── 2. The fold: the top 50 ranked unmasked, "Other" masked as one group ──
  const FOLDS: [string, (owners: string) => VizMeasure[]][] = [
    ...['sum', 'count', 'avg', 'countd', 'min', 'max'].map((agg): [string, (o: string) => VizMeasure[]] => [`${agg} of a related measure`, (o) => [M('w', agg, o)]]),
    ['a primary count first (it ranks), then a related sum', (o) => [M('iid', 'count'), M('w', 'sum', o)]],
  ];
  for (const [label, ms] of FOLDS) {
    const live = await chart(L.items, { category: 'cat', values: ms(L.owners) });
    const { resident, js } = await copyCharts(P, X.items, { category: 'cat', values: ms(X.owners) }, []);
    const p = [...problems(resident, live), ...problems(js, live)];
    ok(`a folded text axis (60 categories), ${label}: Live = joinResident = joinJs — the cut ranked unmasked, "Other" masked once`, p.length === 0 && live.data.labels.includes('Other'), p.join(' | ') || show(live.data));
  }
  {
    const live = await chart(L.items, { category: 'cat', values: [M('w', 'sum', L.owners)] });
    const at = (l: string): number | null => (live.ok ? live.data.series[0].values[live.data.labels.indexOf(l)] : null);
    ok('…by hand: p49 is kept (80 unmasked beats p50\'s 60) showing 40; "Other" is 60 + 1…7 + 9 (the shared owner once) = 97', live.ok && at('p49') === 40 && !live.data.labels.includes('p50') && at('Other') === 97, show(live.data));
  }

  // ── 3. KPIs across a link ──
  type K = [string, string, string, (x: Side) => FilterStep[]];
  const kpis: K[] = [
    ['a related filter, a primary measure', 'amt', 'sum', () => [{ type: 'filter', column: 'region', op: 'in', values: ['North', 'South'] }]],
    ['a related filter that keeps unmatched rows (`!=`)', 'amt', 'count', () => [{ type: 'filter', column: 'seg', op: '!=', value: 'A' }]],
    ...AGGS.map((agg): K => [`a related measure (${agg}), masked over the whole result`, 'target', agg, () => []]),
    ['a related measure AND a related filter AND a primary filter', 'target', 'sum', () => [{ type: 'filter', column: 'seg', op: 'in', values: ['A', 'B'] }, { type: 'filter', column: 'ch', op: '=', value: 'web' }]],
    ['a related avg under a related filter', 'target', 'avg', () => [{ type: 'filter', column: 'region', op: '!=', value: 'South' }]],
  ];
  for (const [label, column, agg, flt] of kpis) {
    const live = await kpi(L.orders, column, agg, flt(L));
    const c = await copyKpis(P, X.orders, column, agg as MetricAggregation, flt(X));
    ok(`KPI, ${label}: Live = joinResident = joinJs, Object.is`, c.planned && live.ok === true && c.resident !== null && Object.is(live.value, c.resident) && Object.is(live.value, c.js) && live.asOf?.mode === 'live',
      show({ live, c }));
  }
  {
    const r = await kpi(L.orders, 'target', 'sum');
    ok('…by hand: sum of target over every order counts each matched customer once — 100 + 40 + 25 + 7 + 13 = 185', r.ok && r.value === 185, show(r));
  }
  {
    // A lock on Customers, through the executor (as test-liveJoins asks the chart): joinJs over the locked customers.
    const LOCK: FilterStep = { type: 'filter', column: 'region', op: 'in', values: ['North', 'East'], lock: true };
    const planned = await as(async () => lj.liveMetricJoinOf(P, (await datasets.getDatasetMeta(P, L.orders))!, { column: 'target', aggregation: 'sum' }, []));
    const req = planned && planned.ok ? planned.req : null;
    const locked = req ? await as(() => lq.liveJoinedMetric(P, { ...req, tables: req.tables.map((t, i) => ({ ...t, lock: i ? [LOCK] : [] })) })) : null;
    const ref = await copyKpis(P, X.orders, 'target', 'sum', [], (id, rows) => (id === X.customers ? rows.filter((r) => r[1] === 'North' || r[1] === 'East') : rows));
    ok('a KPI under a lock on Customers: its rows only — Object.is joinJs over the locked customers (125, not 185)', !!locked && locked.ok && Object.is(locked.value, ref.js) && ref.js === 125, show({ locked, ref }));
  }
  {
    const counted: string[] = [];
    budget.setDailyCheckForTest((_org, id) => { counted.push(id); return { ok: true }; });
    const first = await quiet(() => kpi(L.orders, 'target', 'max', [{ type: 'filter', column: 'seg', op: '=', value: 'B' }]));
    ok('a KPI across a link is ONE statement, counted once, under the primary', first.r.ok && first.calls === 1 && show(counted) === show([L.orders]), show({ first, counted }));
    const again = await quiet(() => kpi(L.orders, 'target', 'max', [{ type: 'filter', column: 'seg', op: '=', value: 'B' }]));
    ok('…asked again: the cache answers, nothing sent', again.r.ok && again.calls === 0 && again.r.asOf?.cached === true, show(again));
    await as(() => liveDataset.bumpEpoch(P, L.customers));
    const refreshed = await quiet(() => kpi(L.orders, 'target', 'max', [{ type: 'filter', column: 'seg', op: '=', value: 'B' }]));
    ok('…a Refresh of the RELATED dataset asks again (its epoch is in the key)', refreshed.r.ok && refreshed.calls === 1, show(refreshed));
    budget.setDailyCheckForTest(null);
  }

  // ── 4. Drill-across KPI: a many-side measure is that table's own KPI ──
  {
    const flt: FilterStep[] = [{ type: 'filter', column: 'region', op: '!=', value: 'West' }];
    const live = await kpi(L.customers, 'amt', 'sum', flt);
    const copy = await kpi(X.customers, 'amt', 'sum', flt);
    ok('a KPI on Customers of Orders\' amt (drill-across) under a Customers filter: Orders\' own KPI across its link on the warehouse — Object.is the copy\'s, its notes too',
      live.ok === true && copy.ok === true && Object.is(live.value, copy.value) && show(live.notes) === show(copy.notes) && live.asOf?.mode === 'live', show([live, copy]));
  }

  // ── 5. Negative controls and refusals ──
  {
    compileJoin.setJoinMaskForTest(false);
    await as(async () => { queryCache.invalidateDataset(L.orders, P); });
    const out: string[] = [];
    try {
      for (const agg of ['sum', 'count']) {
        const enc = (x: Side): VizEncoding => ({ category: 'ch', values: [M('target', agg, x.customers)] });
        const unmasked = await chart(L.orders, enc(L));
        if (!unmasked.ok || problems((await copyCharts(P, X.orders, enc(X), [])).js, unmasked).length === 0) out.push(`${agg} by a primary category: ${show(unmasked).slice(0, 200)}`);
        // By hand, unmasked: web adds c1 and c2 once per order — 100·2 + 40·2 + 25 + 13 = 318; 7 cells counted, not 5.
        if (unmasked.ok && unmasked.data.series[0].values[unmasked.data.labels.indexOf('web')] !== (agg === 'sum' ? 318 : 6)) out.push(`${agg}: web is ${show(unmasked.data)}`);
      }
      const k = await kpi(L.orders, 'target', 'sum');
      if (!(k.ok && k.value === 550)) out.push(`the KPI unmasked is not 550 (c1 four times, c2 and c3 twice): ${show(k)}`);
    } finally {
      compileJoin.setJoinMaskForTest(true);
      await as(async () => { queryCache.invalidateDataset(L.orders, P); });
    }
    ok('NEGATIVE CONTROL: without the mask, sum and count by the primary category and the KPI disagree with joinJs — the mask is what makes them agree', out.length === 0, out.join(' | '));
  }
  {
    // A reverse hop is no join: the copy skips the filter (a column its dataset lacks), and so does Live — one statement, no join.
    const flt: FilterStep[] = [{ type: 'filter', column: 'ch', op: '=', value: 'web' }];
    const { r, calls } = await quiet(() => kpi(L.customers, 'cid', 'count', flt));
    const copy = await kpi(X.customers, 'cid', 'count', flt);
    const plan = await as(async () => lj.liveMetricJoinOf(P, (await datasets.getDatasetMeta(P, L.customers))!, { column: 'cid', aggregation: 'count' }, flt));
    ok('a KPI filtered across a reverse hop (Customers → its many side) is never joined: Live = the copy (the filter skipped, as a copy skips it)',
      r.ok === true && copy.ok === true && Object.is(r.value, copy.value) && plan === null && calls === 1, show({ r, copy, plan, calls }));
    const rev = await chart(L.customers, { category: 'oid', categoryDatasetId: L.orders, values: [M('target', 'sum')] });
    ok('a chart across a reverse hop is still refused, typed (related)', refusedAs(rev, 'related'), show(rev));
  }
  {
    await as(() => rels.saveRelationship(P, { from: { datasetId: L.orders, column: 'oid' }, to: { datasetId: X.owners, column: 'own' }, cardinality: 'many_to_one', label: 'Copy link' }));
    const { r, calls } = await quiet(() => kpi(L.orders, 'amt', 'sum', [{ type: 'filter', column: 'w', op: '>', value: 1 }]));
    ok('a Live KPI whose filter is on a copy: refused, typed (related), in the sentence naming both — nothing sent', refusedAs(r, 'related') && calls === 0
      && r.error === await as(async () => liveRefusals.liveJoinMixed('Orders', 'Owners copy')), show(r));
  }
  {
    const far = await as(async () => {
      const conn = (await connections.saveConnection(P, { name: 'Second warehouse', connectorId: fakeMod.LIVE_FAKE_ID, values: {} }))!;
      const id = (await liveRecord.saveLiveRecord(P, { name: 'Far owners', columns: OWNER_COLS, origin: { kind: 'connection', connId: conn.id, table: 'jm_owners' } }))!.id;
      await rels.saveRelationship(P, { from: { datasetId: L.customers, column: 'cid' }, to: { datasetId: id, column: 'own' }, cardinality: 'many_to_one', label: 'Far' });
      return id;
    });
    const { r, calls } = await quiet(() => kpi(L.customers, 'w', 'sum'));
    ok('a Live KPI whose measure is on another connection: refused, typed (related), nothing sent', refusedAs(r, 'related') && calls === 0
      && r.error === await as(async () => liveRefusals.liveJoinApart('Customers', 'Far owners')), show({ r, far }));
  }

  {
    // A drill-across KPI across a MIX, both ways round: a Live Customers' KPI on a copy many side (Refunds copy → Customers),
    // and a copy Customers' KPI on a Live many side (Refunds → Customers copy). With a filter on Customers, each is refused
    // in the mix sentence, nothing sent, nothing hydrated; with none, the Live many side's own KPI answers.
    const REFUND_COLS: Col[] = [{ name: 'rid', type: 'text' }, { name: 'cid', type: 'text' }, { name: 'refund', type: 'number' }];
    const REFUNDS: Cell[][] = [['r1', 'c1', 5], ['r2', 'c2', 3], ['r3', 'c3', 2], ['r4', 'c9', 1]];
    const ids = await as(async () => {
      await fakeMod.loadWarehouseTable('jm_refunds', REFUND_COLS, REFUNDS);
      const live = (await liveRecord.saveLiveRecord(P, { name: 'Refunds', columns: REFUND_COLS, origin: { kind: 'connection', connId: s.connId, table: 'jm_refunds' } }))!.id;
      const copy = (await datasets.saveDataset(P, { name: 'Refunds copy', sourceKind: 'csv', ...fixture.importTyped(REFUND_COLS, REFUNDS) }))!.id;
      await rels.saveRelationship(P, { from: { datasetId: live, column: 'cid' }, to: { datasetId: X.customers, column: 'cid' }, cardinality: 'many_to_one' });
      await rels.saveRelationship(P, { from: { datasetId: copy, column: 'cid' }, to: { datasetId: L.customers, column: 'cid' }, cardinality: 'many_to_one' });
      return { live, copy };
    });
    const flt: FilterStep[] = [{ type: 'filter', column: 'region', op: '=', value: 'North' }];
    const from = hydrated.length;
    const a = await quiet(() => kpi(L.customers, 'refund', 'sum', flt));
    ok('a Live KPI whose many-side measure is on a copy, filtered on the Live side: refused, typed (related), in the mix sentence — nothing sent', refusedAs(a.r, 'related') && a.calls === 0
      && a.r.error === await as(async () => liveRefusals.liveJoinMixed('Customers', 'Refunds copy')), show(a));
    const b = await quiet(() => kpi(X.customers, 'refund', 'sum', flt));
    ok('a copy KPI whose many-side measure is Live, filtered on the copy: refused, typed (related), in the mix sentence — nothing sent', refusedAs(b.r, 'related') && b.calls === 0
      && b.r.error === await as(async () => liveRefusals.liveJoinMixed('Refunds', 'Customers copy')), show(b));
    ok('…and neither hydrated a Live dataset', !hydrated.slice(from).some((id) => liveIds.has(id) || id === ids.live), show(hydrated.slice(from)));
    const c = await quiet(() => kpi(X.customers, 'refund', 'sum'));
    // Its asOf is the older of the two (the copy's), as stampAsOf dates any figure by its oldest input.
    ok('NEGATIVE CONTROL: unfiltered, the copy\'s KPI on its Live many side is that table\'s own Live KPI (5 + 3 + 2 + 1), asked of the warehouse', c.r.ok === true && c.r.value === 11 && c.calls === 1, show(c));
  }
  {
    // A filter through a relationship since deleted: the copy plans no join and shows no figure; Live says why, typed.
    const gone = await as(() => rels.saveRelationship(P, { from: { datasetId: L.orders, column: 'cid' }, to: { datasetId: L.customers, column: 'cid' }, cardinality: 'many_to_one', label: 'Gone soon' }));
    await as(() => rels.deleteRelationship(P, gone!.id));
    const flt: FilterStep[] = [{ type: 'filter', column: 'region', op: '=', value: 'North', via: gone!.id }];
    const { r, calls } = await quiet(() => kpi(L.orders, 'amt', 'sum', flt));
    const copy = await kpi(X.orders, 'amt', 'sum', flt);
    ok('a Live KPI whose filter names a deleted relationship: no figure — refused, typed (related), nothing sent; the copy shows none either', refusedAs(r, 'related') && calls === 0
      && copy.ok === true && copy.value === null, show({ r, copy }));
  }

  ok('no Live dataset was ever hydrated', !hydrated.slice(hydratedBefore).some((id) => liveIds.has(id)), show(hydrated.slice(hydratedBefore)));
})()
  .catch((e) => ok('live join measures suite threw', false, e && (e as Error).stack))
  .then(() => close())
  .finally(() => finish());
