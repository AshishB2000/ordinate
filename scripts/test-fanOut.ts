// Fan-out charts (semantic layer part 8, step 06): a chart on Customers with measures from its many sides
// (Orders, Returns) is ONE question per table, each on the path D10 pins, lined up by label.
//
//   § plan     the pure planner: which questions, on which pinned paths (categoryVia, a filter's via),
//              which filters narrow which measures, and every D13 refusal with its own sentence
//   § answers  each case three ways — resident-forced, JS-forced and a brute-force loop over the fixture
//              arrays (no engine code) — all Object.is; each series equals its own table's chart; orphans
//              fall under the blank label; the door (`visual:data`) answers the same, with its notes
//   § names    (step 07) the many sides' column lists and a bare name's one many-side owner
//   § kpi      (step 07) a KPI on Customers over a many-side column is that table's KPI, filtered by D11,
//              against a brute-force sum; a KPI over its own or a forward column is today's reply
//   § formula  (step 07) a formula metric naming a many-side column, as a KPI and as a chart measure: each
//              leaf on its own table, lined up by label, against a brute-force loop
//
//   npm run build:ts && node scripts/test-fanOut.js

import { ok, finish } from './selfcheck';
import type { VizEncoding } from '../src/analysis/visuals';
import type { FilterStep } from '../src/data/transforms';
import * as fx from './fanOutFixture';
import * as fp from '../src/analysis/fanOutPlan';
import * as msg from '../src/analysis/fanOutMessages';
import type { Cell } from '../src/data/transforms';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-fanout-data-'));

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const visualsIpc: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const ipcRels: typeof import('../src/ipc/relationships') = require('../src/ipc/relationships');
const dashboardsIpc: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');
const metricsIpc: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const metricCheckIpc: typeof import('../src/ipc/metricCheck') = require('../src/ipc/metricCheck');
const { compileMetricFormula }: typeof import('../src/analysis/metricFormula') = require('../src/analysis/metricFormula');
const fan: typeof import('../src/ipc/vizFanOut') = require('../src/ipc/vizFanOut');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const termMsg: typeof import('../src/data/termMessages') = require('../src/data/termMessages');
const analysesIpc: typeof import('../src/ipc/analysesServer') = require('../src/ipc/analysesServer');
const jp: typeof import('../src/analysis/joinPlan') = require('../src/analysis/joinPlan');
const js: typeof import('../src/analysis/joinJs') = require('../src/analysis/joinJs');
const jr: typeof import('../src/engine/joinResident') = require('../src/engine/joinResident');
const { buildVizData }: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
const { residentVizData }: typeof import('../src/ipc/visualsResident') = require('../src/ipc/visualsResident');
const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers; // any: each reply is narrowed by its check

type Reply = import('../src/ipc/visuals').VizDataReply;
type Ok = Extract<Reply, { ok: true }>;
type Ask = (datasetId: string, e: VizEncoding, f: FilterStep[]) => Promise<Reply>;

const { CUSTOMERS, ORDERS, RETURNS, REGIONS, R_OC, R_OR, R_RC, R_CR, RELS, infos, M, F } = fx;
const C = CUSTOMERS.id;
const O = ORDERS.id;
const R = RETURNS.id;
const G = REGIONS.id;
const show = (v: unknown): string => JSON.stringify(v);
const plan = (enc: VizEncoding, filters: FilterStep[] = []): fp.FanOutPlan => {
  const p = fp.planFanOut(C, enc, filters, RELS, infos);
  if (!p || !p.ok) throw new Error(`does not plan: ${show(p)}`);
  return p.plan;
};

async function main(): Promise<void> {
  // ── § plan ────────────────────────────────────────────────────────────────
  const p = plan(THREE, [F('region', '=', 'West'), F('order_date', '>=', '2024-01-01')]);
  ok('three questions: Customers, Orders, Returns', show(p.questions.map((q) => q.datasetId)) === show([C, O, R]), show(p.questions.map((q) => q.datasetId)));
  ok('each question answers its own measures, in the chart\'s order', show(p.questions.map((q) => q.measures)) === show([[0], [1], [2]]));
  ok('Customers\' question is the chart\'s own, minus the many-side measures and the Orders-only filter',
    show(p.questions[0].encoding) === show({ ...THREE, values: [M('id', 'count')] }) && show(p.questions[0].filters) === show([F('region', '=', 'West')]), show(p.questions[0]));
  ok('Orders\' question reaches zone through Customers (R_CR), pinned, never ship_region', p.questions[1].encoding.categoryVia === R_CR
    && p.questions[1].encoding.categoryDatasetId === G && show(p.questions[1].encoding.values) === show([M('amount', 'sum')]), show(p.questions[1].encoding));
  ok('Returns\' question needs no categoryVia: its default path to Regions IS Returns → Customers → Regions',
    p.questions[2].encoding.categoryVia === undefined && p.questions[2].encoding.categoryDatasetId === G, show(p.questions[2].encoding));
  ok('the bare region filter reaches Orders as Customers.region (via R_OC), never Orders.region',
    show(p.questions[1].filters[0]) === show({ ...F('region', '=', 'West'), via: R_OC }), show(p.questions[1].filters));
  ok('…and Returns through R_RC', show(p.questions[2].filters) === show([{ ...F('region', '=', 'West'), via: R_RC }]), show(p.questions[2].filters));
  ok('order_date narrows Revenue only: Orders gets it, Customers and Returns do not, and the note says so',
    show(p.questions[1].filters[1]) === show(F('order_date', '>=', '2024-01-01')) && p.questions[2].filters.length === 1
    && show(p.notes) === show([{ kind: 'ownRows', measures: [1, 2] }, { kind: 'narrows', column: 'order_date', measures: [1] }]), show(p.notes));

  // Many sides alone: no Customers question, and a split rides on values[0] (a split draws one measure).
  const alone = plan({ category: 'segment', values: [M('amount', 'sum', O), M('refund', 'avg', R)] });
  ok('many-side measures alone: no Customers question; the category on Customers is named by id',
    show(alone.questions.map((q) => [q.datasetId, q.encoding.categoryDatasetId, q.encoding.categoryVia ?? null])) === show([[O, C, null], [R, C, null]]));
  const split = plan({ category: 'segment', series: 'tier', values: [M('amount', 'sum', O), M('id', 'count')] });
  ok('a split: one question for values[0], the split on Customers by Orders\' default path',
    split.questions.length === 1 && split.questions[0].encoding.seriesDatasetId === C && show(split.questions[0].encoding.values) === show([M('amount', 'sum')]), show(split));
  const twoPaths = plan({ category: 'zone', categoryDatasetId: G, values: [M('amount', 'sum', O), { ...M('amount', 'max', O), via: R_OC }] });
  ok('the same many side twice by the same path is ONE question', twoPaths.questions.length === 1 && show(twoPaths.questions[0].measures) === show([0, 1]));
  const viaZone = plan({ category: 'zone', categoryDatasetId: G, categoryVia: R_CR, values: [M('amount', 'sum', O)] });
  ok('a categoryVia that IS Customers\' default path plans the same question', show(viaZone.questions[0].encoding) === show({ ...plan({ category: 'zone', categoryDatasetId: G, values: [M('amount', 'sum', O)] }).questions[0].encoding }));
  const onlyMany = plan({ category: 'segment', values: [M('id', 'count'), M('amount', 'sum', O)] }, [F('ship_region', '=', 'East'), F('nope', '=', 1)]);
  ok('a column only Orders has goes to Orders bare; one no table has stays on every question (each skips it as today)',
    show(onlyMany.questions[0].filters) === show([F('nope', '=', 1)]) && show(onlyMany.questions[1].filters) === show([F('ship_region', '=', 'East'), F('nope', '=', 1)])
    && show(onlyMany.notes) === show([{ kind: 'ownRows', measures: [1] }, { kind: 'narrows', column: 'ship_region', measures: [1] }]), show(onlyMany));

  ok('NEGATIVE CONTROL: a chart with only forward measures is not planned', fp.planFanOut(O, { category: 'zone', categoryDatasetId: G, values: [M('amount', 'sum')] }, [], RELS, infos) === null);
  ok('NEGATIVE CONTROL: a chart on Customers with no measure from another table is not planned', fp.planFanOut(C, { category: 'zone', categoryDatasetId: G, values: [M('id', 'count')] }, [], RELS, infos) === null);
  ok('NEGATIVE CONTROL: an unrelated measure is not planned (today\'s sentence answers)',
    fp.planFanOut(C, { category: 'segment', values: [M('amount', 'sum', O), M('x', 'sum', fx.ID(9))] }, [], RELS, infos) === null);
  ok('NEGATIVE CONTROL: a split whose drawn measure is Customers\' own is not planned', fp.planFanOut(C, { category: 'segment', series: 'tier', values: [M('id', 'count'), M('amount', 'sum', O)] }, [], RELS, infos) === null);

  const base: VizEncoding = { category: 'segment', values: [M('id', 'count'), M('amount', 'sum', O)] };
  const REFUSED: [string, VizEncoding, string][] = [
    ['a category from Orders with a Customers count', { ...base, category: 'ship_region', categoryDatasetId: O }, msg.fanOutManySide('ship_region', 'Orders', 'Customers')],
    ['a split from Orders', { category: 'segment', series: 'ship_region', seriesDatasetId: O, values: [M('amount', 'sum', O)] }, msg.fanOutManySide('ship_region', 'Orders', 'Customers')],
    ['a category on Regions reached only from Orders', { ...base, category: 'zone', categoryDatasetId: G, categoryVia: R_OR }, msg.fanOutOffPath('zone', 'Orders', 'Customers')],
    ['a facet', { ...base, facet: { rows: 'tier' } }, msg.fanOutShape()],
    ['a pivot', { ...base, pivot: { rows: ['segment'], columns: [], values: [M('amount', 'sum')] } } as unknown as VizEncoding, msg.fanOutShape()],
    ['a map', { ...base, geo: { level: 'us_state' } }, msg.fanOutShape()],
    ['raw points', { category: 'segment', values: [M('amount', 'none', O)] }, msg.fanOutShape()],
  ];
  for (const [why, enc, sentence] of REFUSED) {
    const r = fp.planFanOut(C, enc, [], RELS, infos);
    ok(`refused, with its sentence: ${why}`, !!r && !r.ok && r.error === sentence, show(r));
  }
  ok('the sentences differ, and none is findPath\'s', new Set(REFUSED.map((x) => x[2])).size === 3 && REFUSED.every((x) => !/inflated/.test(x[2])));

  await answers();
  await names();
  await kpis();
  await formulas();

  fx.removeFixture();
  fs.rmSync(process.env.ORDINATE_LOCAL_DIR as string, { recursive: true, force: true });
  finish();
}

/** One local project holding the fixture and its relationships, for the doors; ids swapped in by `swap`. */
let door: Promise<{ P: string; saved: Map<string, string>; swap: <T>(v: T) => T }> | null = null;
function doorProject(): Promise<{ P: string; saved: Map<string, string>; swap: <T>(v: T) => T }> {
  door ??= (async () => {
    await projects.init();
    const P = (await projects.createProject('Fan-out')).id;
    const saved = new Map<string, string>();
    for (const f of fx.ALL) saved.set(f.id, (await datasets.saveDataset(P, { name: f.name, sourceKind: 'csv', columns: f.columns, rows: f.rows }))!.id);
    const swap = <T>(v: T): T => JSON.parse([...saved].reduce((s, [a, b]) => s.split(a).join(b), JSON.stringify(v)));
    for (const r of RELS) await rels.saveRelationship(P, swap(r));
    return { P, saved, swap };
  })();
  return door;
}

// ── § names (step 07) ───────────────────────────────────────────────────────

async function names(): Promise<void> {
  ok('Customers: Orders and Returns are its many sides', show(fp.manySideColumnGroups(C, RELS, infos).map((g) => g.name)) === '["Orders","Returns"]', show(fp.manySideColumnGroups(C, RELS, infos)));
  const amount = fp.manySideOwner(C, 'amount', RELS, infos);
  const both = fp.manySideOwner(C, 'customer_id', RELS, infos);
  ok('amount is owned by Orders; customer_id by both, so refused naming both',
    !!amount && amount.ok && amount.datasetId === O && !!both && !both.ok && /Orders and on Returns/.test(both.error), show([amount, both]));
  ok('an own column, a forward one and a column no table has have no many-side owner',
    fp.manySideOwner(C, 'segment', RELS, infos) === null && fp.manySideOwner(C, 'zone', RELS, infos) === null && fp.manySideOwner(C, 'nope', RELS, infos) === null);
  ok('NEGATIVE CONTROL: from Orders, Customers is forward, never a many side (Returns is one, through Customers)',
    show(fp.manySideColumnGroups(O, RELS, infos).map((g) => g.name)) === '["Returns"]');
  const { P, swap } = await doorProject();
  ok('relatedColumnNames is unchanged: forward only', show(await ipcRels.relatedColumnNames(P, swap(C))) === '["region","zone"]');
  ok('manySideColumnNames: Orders\' then Returns\' columns', show(await ipcRels.manySideColumnNames(P, swap(C))) === show([...ORDERS.columns, ...RETURNS.columns].map((c) => c.name)));
  if (!handlers.has('relationship:related')) ipcRels.register();
  const related = await handlers.get('relationship:related')!(null, { projectId: P, datasetId: swap(C) });
  ok('relationship:related: the forward groups as before, and manyGroups beside them',
    related.ok === true && show(related.groups.map((g: { name: string }) => g.name)) === '["Regions"]' && show(related.manyGroups.map((g: { datasetId: string }) => g.datasetId)) === show([swap(O), swap(R)]), show(related));
  ok('Regions: every table that rolls up to it, nearest first (Customers and Orders by one hop, Returns by two)',
    show(fp.manySideColumnGroups(G, RELS, infos).map((g) => g.name)) === '["Customers","Orders","Returns"]', show(fp.manySideColumnGroups(G, RELS, infos).map((g) => g.name)));
  const lonely = (await datasets.saveDataset(P, { name: 'Lonely', sourceKind: 'csv', columns: [{ name: 'x', type: 'text' }], rows: [['a']] }))!.id;
  const alone = await handlers.get('relationship:related')!(null, { projectId: P, datasetId: lonely });
  ok('NEGATIVE CONTROL: a dataset with no many side gets today\'s reply, with no manyGroups key', show(alone) === show({ ok: true, groups: [] }), show(alone));
}

// ── § kpi (step 07) ─────────────────────────────────────────────────────────

async function kpis(): Promise<void> {
  const { P, swap } = await doorProject();
  if (!handlers.has('dashboard:metric')) dashboardsIpc.register();
  type Kpi = { ok: boolean; value?: number | null; notes?: string[]; error?: string };
  const kpi = (d: string, spec: { column: string; aggregation: string }, filters: FilterStep[]): Promise<Kpi> =>
    handlers.get('dashboard:metric')!(null, { projectId: P, datasetId: swap(d), ...spec, filters: swap(filters) });
  const sum = { column: 'amount', aggregation: 'sum' };
  const segmentOf = (o: Cell[]): Cell => custOf(o[1])?.[COL.segment] ?? null;
  const bruteSum = (keepIt: (o: Cell[]) => boolean = () => true): number => ORDERS.rows.filter(keepIt).reduce((a, o) => a + (o[4] as number), 0);
  const ownRows = msg.fanOutOwnRows('“sum of amount”');

  const v = await kpi(C, sum, [F('segment', '=', 'SMB')]);
  ok('a KPI on Customers over amount is Orders\' sum for SMB customers', v.ok && Object.is(v.value, bruteSum((o) => segmentOf(o) === 'SMB')), show(v));
  const onOrders = await kpi(O, sum, [{ ...F('segment', '=', 'SMB'), via: R_OC }]);
  ok('…and equals the same KPI asked on Orders with the pinned filter', Object.is(v.value, onOrders.value) && onOrders.notes === undefined, show(onOrders));
  ok('…and says its measure counts Orders\' own rows', show(v.notes) === show([ownRows]), show(v.notes));
  const all = await kpi(C, sum, []);
  ok('unfiltered: every order, the orphans too', Object.is(all.value, bruteSum()), show(all));
  const dated = await kpi(C, sum, [F('order_date', '>=', '2024-01-01')]);
  ok('an order_date control narrows sum(amount), with no note about it', Object.is(dated.value, bruteSum((o) => String(o[5]) >= '2024-01-01')) && show(dated.notes) === show([ownRows]), show(dated));
  const refund = await kpi(C, sum, [F('refund', '>', 1)]);
  ok('a filter no table on Orders\' side has is skipped, as a dashboard filter is today', Object.is(refund.value, bruteSum()) && show(refund.notes) === show([ownRows]), show(refund));
  // On Orders, Returns is the many side and meets Orders' tree at Customers: Orders' own columns are off its path.
  const refunds = (keepIt: (r: Cell[]) => boolean = () => true): number => RETURNS.rows.filter(keepIt).reduce((a, r) => a + (r[1] as number), 0);
  const offPath = await kpi(O, { column: 'refund', aggregation: 'sum' }, [F('order_date', '>=', '2024-01-01')]);
  ok('a filter off the many side\'s path (Orders\' own order_date, for Returns) leaves the KPI unaffected, and the tile says so',
    Object.is(offPath.value, refunds()) && show(offPath.notes) === show([msg.fanOutOwnRows('“sum of refund”'), msg.fanOutNarrowsNone('order_date')]), show(offPath));
  const smbRefunds = await kpi(O, { column: 'refund', aggregation: 'sum' }, [F('segment', '=', 'SMB')]);
  ok('…while Customers\' segment reaches Returns through Customers', Object.is(smbRefunds.value, refunds((r) => custOf(r[0])?.[COL.segment] === 'SMB')), show(smbRefunds));
  const both = await kpi(C, { column: 'customer_id', aggregation: 'count' }, []);
  ok('a column on two many sides: no figure, and the sentence names both', both.ok && both.value === null && /Orders and on Returns/.test(String(both.notes)), show(both));
  // A dashboard term the KPI leaves out (an Orders term, part 1 05b): its note after the fan-out's, neither replacing the other.
  const paid = (await terms.saveTerm(P, { name: 'Paid orders', datasetId: swap(O), filters: [F('amount', '>', 0)] }))!;
  const scoped = await kpi(C, sum, [{ type: 'term', term: paid.id, fromControl: true } as unknown as FilterStep]);
  ok('a dashboard term the KPI leaves out: its note after the fan-out\'s, the figure unfiltered', Object.is(scoped.value, all.value)
    && show(scoped.notes) === show([ownRows, termMsg.termNotApplied('Paid orders', 'Customers')]), show(scoped));
  // A dashboard's tiles (analysis:tiles, which 05b gave notes): the KPI and its chart each carry the fan-out's note.
  if (!handlers.has('analysis:tiles')) analysesIpc.register();
  if (!handlers.has('visual:data')) visualsIpc.register();
  const tiles = await handlers.get('analysis:tiles')!(null, { projectId: P, items: swap([
    { kind: 'metric', datasetId: C, ...sum, filters: [F('segment', '=', 'SMB')] },
    { kind: 'visual', datasetId: C, encoding: { category: 'segment', values: [M('amount', 'sum', O)] }, filters: [] },
  ]) }) as Kpi[];
  ok('analysis:tiles: the KPI tile carries its figure and the fan-out\'s note, and so does its chart', Object.is(tiles[0]?.value, v.value)
    && show(tiles[0]?.notes) === show([ownRows]) && tiles[1]?.ok === true && show(tiles[1]?.notes) === show([ownRows]), show(tiles));
  const reads = await ipcRels.metricReads(P, swap(C), 'amount', swap([F('zone', '=', 'W')]));
  ok('metricReads: Orders and the Regions its pinned filter joins (never Customers itself)', sorted(reads) === sorted([swap(O), swap(G)]), show(reads));

  // Old content: a KPI over Customers' own or forward column is today's reply, byte for byte.
  const own = await kpi(C, { column: 'id', aggregation: 'count' }, []);
  ok('NEGATIVE CONTROL: count(id) under the order_date control is today\'s reply (the filter skipped, no notes)',
    own.ok && own.value === CUSTOMERS.rows.length && show(await kpi(C, { column: 'id', aggregation: 'count' }, [F('order_date', '>=', '2024-01-01')])) === show(own), show(own));
  const zone = await kpi(C, { column: 'zone', aggregation: 'count' }, []);
  ok('NEGATIVE CONTROL: a forward column resolves as before (each Regions row reached, once), with no notes', zone.ok && zone.value === new Set(CUSTOMERS.rows.map((r) => r[COL.region]).filter((x) => regionOf(x))).size && zone.notes === undefined, show(zone));
  ok('NEGATIVE CONTROL: Orders\' own amount on Orders is not fanned out', show(await ipcRels.metricReads(P, swap(O), 'amount', [])) === '[]');
}

const sorted = (xs: string[]): string => JSON.stringify([...xs].sort());

// ── § formula (step 07) ─────────────────────────────────────────────────────

async function formulas(): Promise<void> {
  const { P, swap } = await doorProject();
  if (!handlers.has('metric:save')) metricsIpc.register();
  if (!handlers.has('metric:check')) metricCheckIpc.register();
  const save = async (name: string, formula: string): Promise<string> => {
    const r = await handlers.get('metric:save')!(null, { projectId: P, input: { name, datasetId: swap(C), definition: { formula } } });
    if (!r.ok) throw new Error(`metric "${name}" not saved: ${show(r)}`);
    return r.metric.id as string;
  };
  const chart = (encoding: VizEncoding): Promise<Reply> => handlers.get('visual:data')!(null, { projectId: P, datasetId: swap(C), encoding: swap(encoding) });
  const perCustomer = await save('Revenue per customer', 'sum(amount) / count(id)');
  const amountOf = (keepIt: (o: Cell[]) => boolean): number | null => ((rs) => (rs.length ? rs.reduce((a, o) => a + (o[4] as number), 0) : null))(ORDERS.rows.filter(keepIt));

  const value = await handlers.get('metric:value')!(null, { projectId: P, id: perCustomer });
  ok('KPI: the formula over two tables (every order over every customer row)', value.ok && Object.is(value.value, (amountOf(() => true) as number) / CUSTOMERS.rows.length), show(value));

  const c = await chart({ category: 'segment', values: [{ column: 'Revenue per customer', aggregation: 'sum', metricId: perCustomer }] });
  // Brute force: per segment label, the orders of customers with it (first row per id; orphans under ''), over its customer rows.
  const segOf = (o: Cell[]): string => String(custOf(o[1])?.[COL.segment] ?? '');
  const labels = [...new Set([...CUSTOMERS.rows.map((r) => String(r[COL.segment])), ...ORDERS.rows.map(segOf)])];
  const brute = new Map(labels.map((l) => {
    const n = CUSTOMERS.rows.filter((r) => String(r[COL.segment]) === l).length;
    const a = amountOf((o) => segOf(o) === l);
    return [l, a === null || n === 0 ? null : a / n] as const;
  }));
  const drawn = c.ok ? new Map(c.data.labels.map((l, k) => [String(l), c.data.series[0].values[k]] as const)) : new Map();
  ok('chart: per segment, each leaf on its own table, lined up', c.ok && drawn.size === brute.size && [...brute].every(([l, v]) => drawn.has(l) && Object.is(drawn.get(l), v)), show([c, [...brute]]));
  ok('the blank segment: no customer count, so the formula is null, never Infinity', c.ok && drawn.has('') && drawn.get('') === null && amountOf((o) => segOf(o) === '') !== null, show(c));
  ok('Gov (the repeated c1 that no order reaches): a count and no amount, so null', c.ok && drawn.get('Gov') === null, show(c));

  const zoneShare = await save('Zones counted', 'count(zone)');
  const viaFormula = await chart({ category: 'segment', values: [{ column: 'Zones counted', aggregation: 'sum', metricId: zoneShare }] });
  const plainZone = await chart({ category: 'segment', values: [M('zone', 'count', G)] });
  ok('a forward column in a formula draws, and equals the same measure charted plainly', viaFormula.ok && plainZone.ok
    && show(viaFormula.data.labels) === show(plainZone.data.labels) && viaFormula.data.series[0].values.every((v, k) => Object.is(v, plainZone.data.series[0].values[k])), show([viaFormula, plainZone]));
  const twoOwners = await chart({ category: 'segment', values: [{ column: 'Ambiguous', aggregation: 'sum', metricId: await save('Ambiguous', 'count(customer_id)') }] });
  ok('a formula naming a column two many sides have: refused, naming both', !twoOwners.ok && /Orders and on Returns/.test(twoOwners.error), show(twoOwners));

  const check = await handlers.get('metric:check')!(null, { projectId: P, datasetId: swap(C), expression: 'sum(amount) / count(id)' });
  ok('metric:check accepts sum(amount) on Customers, and previews the KPI', check.valid === true && check.preview?.value === value.value, show(check));
  const own = compileMetricFormula('sum(amount) / count(id)', CUSTOMERS.columns.map((x) => x.name));
  ok('NEGATIVE CONTROL: with own columns only (today), the formula does not compile', !own.ok && /Unknown function/.test(own.error), show(own));
}

// ── § answers ───────────────────────────────────────────────────────────────

const okOf = (r: { data: Ok['data']; recommendedShape: string; warnings: string[]; category?: Ok['category'] }): Reply =>
  ({ ok: true, data: r.data, recommendedShape: r.recommendedShape, warnings: r.warnings, category: r.category });

/** The JS reference: the joined fold through the planner's join, or the single-table bridge. */
const jsAsk: Ask = async (d, e, f) => {
  const j = jp.resolveVizJoin(d, e, f, RELS, infos);
  if (j && !j.ok) return { ok: false, error: j.error };
  return okOf(j ? js.joinedVizDataJs(j.value, fx.tables, infos) : buildVizData(fx.byId(d).columns, fx.byId(d).rows, e, f));
};
/** The resident SQL over the same Parquet bytes; a shape it declines (a split) is counted, then answered by JS. */
let declined = 0;
const residentAsk: Ask = async (d, e, f) => {
  const j = jp.resolveVizJoin(d, e, f, RELS, infos);
  if (j && !j.ok) return { ok: false, error: j.error };
  const r = j ? await jr.joinedAggregateResident(j.value.plan.tables.map((t) => fx.sourceOf(t.datasetId)), j.value, infos)
    : await residentVizData('', d, e, f, { parquetPath: fx.byId(d).file, columns: fx.byId(d).columns });
  if (r) return okOf(r);
  declined++;
  return jsAsk(d, e, f);
};

interface Case { label: string; enc: VizEncoding; filters: FilterStep[]; grain?: string }
const THREE: VizEncoding = { category: 'zone', categoryDatasetId: G, values: [M('id', 'count'), M('amount', 'sum', O), M('refund', 'sum', R)] };
const CASES: Case[] = [
  { label: 'Customers + Orders by segment (orphans, the repeated id)', enc: { category: 'segment', values: [M('id', 'count'), M('amount', 'sum', O)] }, filters: [] },
  { label: 'Orders alone, every aggregation, by tier', enc: { category: 'tier', values: (['sum', 'avg', 'count', 'min', 'max'] as const).map((a) => M('amount', a, O)) }, filters: [] },
  { label: 'two many sides by a forward table (zone), filtered on Customers and on Orders only', enc: THREE, filters: [F('region', '=', 'West'), F('order_date', '>=', '2024-01-01')] },
  { label: 'filters on Customers and on a forward table', enc: { category: 'segment', values: [M('id', 'count'), M('amount', 'avg', O), M('refund', 'max', R)] }, filters: [F('tier', '=', 'A'), F('zone', '=', 'W')] },
  { label: 'an auto-grained date (signup), Customers first: month, pinned on the rest', enc: { category: 'signup', values: [M('id', 'count'), M('amount', 'sum', O), M('refund', 'sum', R)] }, filters: [], grain: 'month' },
  { label: 'an auto-grained date, many sides only: Orders\' grain', enc: { category: 'signup', values: [M('amount', 'sum', O), M('refund', 'min', R)] }, filters: [], grain: 'day' },
  { label: 'a split by tier', enc: { category: 'segment', series: 'tier', values: [M('amount', 'sum', O)] }, filters: [] },
  { label: 'an empty many side under a filter only Returns has', enc: { category: 'segment', values: [M('id', 'count'), M('refund', 'sum', R)] }, filters: [F('refund', '>', 100)] },
  // Part 5's distinct count (cross-part items 2, 12): counted on its own table, never over the fanned rows.
  { label: 'a distinct count of Orders\' customers by tier, beside a Customers count', enc: { category: 'tier', values: [M('id', 'count'), M('customer_id', 'countd', O), M('amount', 'countd', O)] }, filters: [] },
];

const viaAsk = async (c: Case, ask: Ask): Promise<Reply> => {
  const p = fp.planFanOut(C, c.enc, c.filters, RELS, infos);
  if (!p || !p.ok) throw new Error(`${c.label}: does not plan ${show(p)}`);
  return fan.askFanOut(p.plan, c.enc, ask);
};

// The brute force: plain loops over the fixture arrays. Each row of a measure's table reaches its customer
// (first row per key), the customer its region (first row per key); the filters are D11's, restated.
type Row = Cell[];
const firstBy = (rows: Row[], col: number) => (k: Cell): Row | undefined => (k == null || String(k).trim() === '' ? undefined : rows.find((r) => r[col] === k));
const custOf = firstBy(CUSTOMERS.rows, 0);
const regionOf = firstBy(REGIONS.rows, 0);
interface Ctx { cust?: Row; order?: Row; ret?: Row }
const COL = { segment: 1, region: 2, tier: 3, signup: 4 } as const;
function field(ctx: Ctx, name: string, grain?: string): Cell {
  if (name === 'zone') return ctx.cust ? (regionOf(ctx.cust[COL.region])?.[1] ?? null) : null;
  const v = ctx.cust ? ctx.cust[COL[name as keyof typeof COL]] : null;
  return name === 'signup' && typeof v === 'string' && grain === 'month' ? v.slice(0, 7) : v ?? null;
}
const OPS: Record<string, (a: Cell, b: Cell) => boolean> = { '=': (a, b) => a === b, '>=': (a, b) => a != null && String(a) >= String(b), '>': (a, b) => typeof a === 'number' && a > (b as number) };
function keep(ctx: Ctx, f: FilterStep): boolean {
  if (f.column === 'order_date') return !ctx.order || OPS[f.op](ctx.order[5], f.value as Cell); // Orders only
  if (f.column === 'refund') return !ctx.ret || OPS[f.op](ctx.ret[1], f.value as Cell); // Returns only
  return OPS[f.op](field(ctx, f.column), f.value as Cell);
}
function rowsOf(d: string): { ctx: Ctx; cell: (col: string) => Cell }[] {
  if (d === C) return CUSTOMERS.rows.map((r) => ({ ctx: { cust: r }, cell: (c) => r[CUSTOMERS.columns.findIndex((x) => x.name === c)] }));
  if (d === O) return ORDERS.rows.map((r) => ({ ctx: { order: r, cust: custOf(r[1]) }, cell: (c) => r[ORDERS.columns.findIndex((x) => x.name === c)] }));
  return RETURNS.rows.map((r) => ({ ctx: { ret: r, cust: custOf(r[0]) }, cell: (c) => r[RETURNS.columns.findIndex((x) => x.name === c)] }));
}
function agg(cells: Cell[], a: string): number | null {
  if (a === 'count') return cells.filter((x) => x != null && String(x).trim() !== '').length;
  if (a === 'countd') return new Set(cells.filter((x) => x != null && String(x).trim() !== '').map((x) => (Object.is(x, -0) ? '0' : String(x)))).size;
  const nums = cells.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (!nums.length) return null;
  let s = nums[0];
  for (const x of nums.slice(1)) s = a === 'min' ? Math.min(s, x) : a === 'max' ? Math.max(s, x) : s + x;
  return a === 'avg' ? s / nums.length : s;
}
/** label (and split value) → each measure's figure, null where its table has no row in that group. */
function bruteForce(c: Case, grain?: string): Map<string, (number | null)[]> {
  const split = !!c.enc.series;
  const values = split ? c.enc.values.slice(0, 1) : c.enc.values;
  const out = new Map<string, (number | null)[]>();
  values.forEach((v, i) => {
    const groups = new Map<string, Cell[]>();
    for (const r of rowsOf(v.datasetId || C)) {
      if (!c.filters.every((f) => keep(r.ctx, f))) continue;
      const lab = field(r.ctx, c.enc.category, grain);
      const key = JSON.stringify([lab ?? '', ...(split ? [field(r.ctx, c.enc.series as string) ?? ''] : [])]);
      groups.set(key, [...(groups.get(key) ?? []), r.cell(v.column)]);
    }
    for (const [key, cells] of groups) {
      const row = out.get(key) ?? values.map(() => null);
      row[i] = agg(cells, v.aggregation);
      out.set(key, row);
    }
  });
  return out;
}
/** The reply in the brute force's shape (a split's series are its split values). */
function asMap(r: Reply, c: Case): Map<string, (number | null)[]> {
  const out = new Map<string, (number | null)[]>();
  if (!r.ok) return out;
  r.data.labels.forEach((l, k) => {
    if (c.enc.series) {
      for (const s of r.data.series) if (s.values[k] !== null) out.set(JSON.stringify([l, s.name]), [s.values[k]]);
    } else out.set(JSON.stringify([l]), r.data.series.map((s) => s.values[k]));
  });
  return out;
}
function mapDiff(a: Map<string, (number | null)[]>, b: Map<string, (number | null)[]>): string {
  if (a.size !== b.size) return `size ${a.size} vs ${b.size}: ${show([...a.keys()])} vs ${show([...b.keys()])}`;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w || v.length !== w.length || v.some((x, i) => !Object.is(x, w[i]))) return `${k}: ${show(v)} vs ${show(w)}`;
  }
  return '';
}
const sameReply = (a: Reply, b: Reply): boolean => a.ok && b.ok && show([a.data.labels, a.data.series, a.notes ?? null, a.category ?? null]) === show([b.data.labels, b.data.series, b.notes ?? null, b.category ?? null])
  && a.data.series.every((s, i) => s.values.every((v, k) => Object.is(v, b.data.series[i].values[k])));

async function answers(): Promise<void> {
  for (const c of CASES) {
    const res = await viaAsk(c, residentAsk);
    const jsr = await viaAsk(c, jsAsk);
    const grain = res.ok ? res.category?.grain : undefined;
    ok(`${c.label}: resident === JS`, sameReply(res, jsr), show([res, jsr]));
    const d = mapDiff(asMap(res, c), bruteForce(c, grain));
    ok(`${c.label}: === brute force`, res.ok && d === '', d || show(res));
    if (c.grain) ok(`${c.label}: the grain is ${c.grain}`, grain === c.grain, String(grain));
    // Each series is its own table's chart, label by label (absent there → null here).
    const p = fp.planFanOut(C, c.enc, c.filters, RELS, infos);
    let own = res.ok && !!p && p.ok;
    if (res.ok && p && p.ok) {
      for (const q of p.plan.questions) {
        for (const [pos, i] of q.measures.entries()) {
          const alone = await jsAsk(q.datasetId, { ...q.encoding, values: [q.encoding.values[pos]], ...(grain && { grain }) }, q.filters);
          if (!alone.ok || c.enc.series) continue;
          own = own && res.data.labels.every((l, k) => Object.is(res.data.series[i].values[k], ((at) => (at < 0 ? null : alone.data.series[0].values[at]))(alone.data.labels.indexOf(l))));
        }
      }
    }
    ok(`${c.label}: each series equals its own table's chart`, own);
  }
  const distinct = CASES[CASES.length - 1];
  const counted = { ...distinct, enc: { ...distinct.enc, values: distinct.enc.values.map((v) => (v.aggregation === 'countd' ? { ...v, aggregation: 'count' as const } : v)) } };
  ok('NEGATIVE CONTROL: the distinct counts are not plain counts (a customer orders more than once)', mapDiff(asMap(await viaAsk(distinct, residentAsk), distinct), bruteForce(counted)) !== '');
  ok('the resident path declined only the split (it has no resident twin)', declined === 1, String(declined));

  const seg = await viaAsk(CASES[0], residentAsk);
  const ids = new Set(CUSTOMERS.rows.map((r) => r[0]));
  const orphan = ORDERS.rows.filter((r) => !ids.has(r[1])).reduce((a, r) => a + (r[4] as number), 0);
  const blank = seg.ok ? seg.data.labels.indexOf('') : -1;
  ok('orphans: the blank label holds the Orders with no (or an unknown) customer, counted once',
    blank >= 0 && seg.ok && Object.is(seg.data.series[1].values[blank], orphan) && seg.data.series[0].values[blank] === null, show(seg));

  const zone = fp.planFanOut(C, THREE, [], RELS, infos);
  if (zone && zone.ok) {
    const plain = { ...zone.plan, questions: zone.plan.questions.map((q) => (q.datasetId === O ? { ...q, encoding: { ...q.encoding, categoryVia: undefined } } : q)) };
    const bfs = await fan.askFanOut(plain, THREE, jsAsk);
    ok('NEGATIVE CONTROL: Orders\' question asked without categoryVia (breadth-first, ship region) disagrees with brute force',
      mapDiff(asMap(bfs, { label: '', enc: THREE, filters: [] }), bruteForce({ label: '', enc: THREE, filters: [] })) !== '');
  }
  const regional = fp.planFanOut(C, THREE, CASES[2].filters, RELS, infos);
  if (regional && regional.ok) {
    const bare = { ...regional.plan, questions: regional.plan.questions.map((q) => ({ ...q, filters: q.filters.map((f) => (f.via ? { ...f, via: undefined } : f)) })) };
    ok('NEGATIVE CONTROL: the region filter without its via (Orders\' and Returns\' own region, or none) disagrees with brute force',
      mapDiff(asMap(await fan.askFanOut(bare, THREE, jsAsk), CASES[2]), bruteForce(CASES[2])) !== '');
  }
  const signup = fp.planFanOut(C, CASES[4].enc, [], RELS, infos);
  const alone = signup && signup.ok ? await jsAsk(O, signup.plan.questions[1].encoding, []) : null;
  ok('NEGATIVE CONTROL: unpinned, Orders\' own question by signup picks the day grain (so the pin matters)', !!alone && alone.ok && alone.category?.grain === 'day', show(alone));
  const folded = await fan.askFanOut({ questions: [{ datasetId: C, encoding: { category: 'id', values: [M('id', 'count')] }, filters: [], measures: [0] }, { datasetId: O, encoding: { category: 'id', categoryDatasetId: C, values: [M('amount', 'sum')] }, filters: [], measures: [1] }], notes: [] },
    { category: 'id', values: [M('id', 'count'), M('amount', 'sum', O)] }, jsAsk);
  ok('a text axis folded into "Other" across questions is refused with its sentence', !folded.ok && folded.error === msg.fanOutOneAxis(), show(folded));
  // The merged axis: a date's periods in time order, blank last, whichever question drew them; a text axis first-seen.
  const drawn = (category: Ok['category'], by: Record<string, Cell[]>): Ask => async (d) => okOf({ data: { labels: by[d], series: [{ name: d, values: by[d].map((_, i) => i + 1) }] } as unknown as Ok['data'], recommendedShape: 'categorical', warnings: [], category });
  const twoSides = { questions: [O, R].map((d, i) => ({ datasetId: d, encoding: { category: 'signup', values: [M('amount', 'sum')] }, filters: [], measures: [i] })), notes: [] };
  const merged = async (category: Ok['category'], by: Record<string, Cell[]>) => ((r) => (r.ok ? { labels: r.data.labels, series: r.data.series.map((s) => s.values) } : r))(await fan.askFanOut(twoSides, { category: 'signup', values: [M('amount', 'sum', O), M('refund', 'sum', R)] }, drawn(category, by)));
  const byMonth = await merged({ kind: 'date', grain: 'month' }, { [O]: ['2024-01', null, '2024-03'], [R]: ['2024-02', '2023-12'] });
  ok('a date axis merged from two questions is in time order, blank last, each figure under its own period', show(byMonth) === show({ labels: ['2023-12', '2024-01', '2024-02', '2024-03', null], series: [[null, 1, null, 3, 2], [2, null, 1, null, null]] }), show(byMonth));
  const byText = await merged({ kind: 'text' }, { [O]: ['West', 'East'], [R]: ['North', 'East'] });
  ok('NEGATIVE CONTROL: a text axis keeps first-seen order', show(byText) === show({ labels: ['West', 'East', 'North'], series: [[1, 2, null], [null, 2, 1]] }), show(byText));

  // ── the door ──
  const { P, saved, swap } = await doorProject();
  if (!handlers.has('visual:data')) visualsIpc.register();
  const post = (enc: VizEncoding, filters: FilterStep[]): Promise<Reply> => handlers.get('visual:data')!(null, { projectId: P, datasetId: saved.get(C), encoding: swap(enc), filters: swap(filters) });
  const door = await post(CASES[2].enc, CASES[2].filters);
  const want = await viaAsk(CASES[2], residentAsk);
  ok('the door: visual:data answers the same reply, with the notes', door.ok && sameReply(door, want)
    && show(door.ok && door.notes) === show([msg.fanOutOwnRows('“sum of amount”, “sum of refund”'), msg.fanOutNarrows('order_date', '“sum of amount”')]), show([door, want]));
  // A dashboard term on Orders (a many side: no safe hop from Customers) is left out, with its note (part 1 05b): beside the fan-out's own, never instead.
  const paid = (await terms.saveTerm(P, { name: 'Paid', datasetId: swap(O), filters: [F('amount', '>', 0)] }))!;
  const scoped = await post(CASES[2].enc, [...CASES[2].filters, { type: 'term', term: paid.id, fromControl: true } as unknown as FilterStep]);
  ok('the door: a dashboard term the chart leaves out keeps the fan-out\'s notes and adds its own', scoped.ok && door.ok && sameReply({ ...scoped, notes: door.notes }, want)
    && show(scoped.notes) === show([...(door.notes ?? []), termMsg.termNotApplied('Paid', 'Customers')]), show(scoped));
  const fwd: VizEncoding = { category: 'zone', categoryDatasetId: G, values: [M('id', 'count')] };
  const today = await post(fwd, []);
  ok('NEGATIVE CONTROL: a chart with no many-side measure is today\'s answer, with no notes', sameReply(today, await jsAsk(C, fwd, [])) && today.ok && today.notes === undefined, show(today));
  const refused = await post({ ...fwd, category: 'ship_region', categoryDatasetId: O, values: [M('amount', 'sum', O)] }, []);
  ok('the door refuses a D13 case with its sentence', !refused.ok && refused.error === msg.fanOutManySide('ship_region', 'Orders', 'Customers'), show(refused));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
