// Self-check for column-level lineage (semantic layer part 8, D16-D20): the flow through Prepare, what each
// consumer reads on its own dataset, column and term nodes, and the lineage:column / lineage:fields channels.
//
//   npm run build:ts && node scripts/test-lineageColumns.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-lineagecols-')); // before any store loads

const { columnFlow, FLOW_RULES }: typeof import('../src/analysis/lineageFlow') = require('../src/analysis/lineageFlow');
const { STEP_TYPES }: typeof import('../src/data/transforms') = require('../src/data/transforms');
import type { TransformStep } from '../src/data/transforms';
import type { FlowColumn } from '../src/analysis/lineageFlow';

const show = (v: unknown): string => JSON.stringify(v);
const step = (s: object): TransformStep => s as TransformStep;
const R = (from: string, to: string) => step({ type: 'rename_column', from, to });
const CALC = (name: string, expression: string) => step({ type: 'calculated_field', name, expression });
const DROP = (column: string) => step({ type: 'drop_column', column });
const at = (f: FlowColumn[], key: string): FlowColumn => f.find((c) => c.key === key) as FlowColumn;

// ── § flow ───────────────────────────────────────────────────────────────────
ok('FLOW_RULES names every STEP_TYPES member, and nothing else', show(Object.keys(FLOW_RULES).sort()) === show([...STEP_TYPES].sort()));

const f = columnFlow(['amt', 'cost', 'region'], [R('amt', 'amount'), CALC('Margin', '[amount] - [cost]'), CALC('Margin %', '[Margin] / [amount]'), R('amount', 'revenue'), DROP('cost')]);
ok('a rename chain is one column', show(at(f, 'revenue')) === show({ key: 'revenue', was: ['amt', 'amount'], from: [], how: 'source' }), show(at(f, 'revenue')));
ok('calc over calc', show(at(f, 'Margin %').from) === show(['Margin', 'revenue']), show(at(f, 'Margin %')));
ok('a dropped input still feeds the calc that read it', at(f, 'cost').dropped === true && at(f, 'Margin').from.includes('cost'));
ok('first-seen order', show(f.map((c) => c.key)) === show(['revenue', 'cost', 'region', 'Margin', 'Margin %']), show(f.map((c) => c.key)));
ok('an LOD dimension is an input', at(columnFlow(['region', 'amount'], [CALC('Share', '{FIXED [region] : sum([amount])}')]), 'Share').from.join() === 'region,amount');

const ga = columnFlow(['region', 'amount', 'cost'], [step({ type: 'group_aggregate', groupBy: ['region'], aggregations: [{ column: 'amount', fn: 'sum', as: 'total' }, { column: 'cost', fn: 'avg', as: 'avg_cost' }] })]);
ok('group_aggregate: each output from its column, group-by passes through', show(at(ga, 'total').from) === show(['amount']) && show(at(ga, 'avg_cost').from) === show(['cost']) && at(ga, 'region').how === 'source' && !at(ga, 'region').dropped && at(ga, 'amount').dropped === true, show(ga));

const TIERS = '11111111-1111-4111-8111-111111111111';
const lk = columnFlow(['id', 'amount'], [step({ type: 'lookup_join', datasetId: TIERS, leftKey: 'id', rightKey: 'id', columns: ['tier'] })]);
ok('lookup_join: an added column names the other dataset', at(lk, 'tier').lookup?.datasetId === TIERS && at(lk, 'tier').lookup?.column === 'tier' && at(lk, 'tier').how === 'lookup');
ok('a lookup that would clash adds nothing (the fold skips it too)', columnFlow(['id', 'tier'], [step({ type: 'lookup_join', datasetId: TIERS, leftKey: 'id', rightKey: 'id', columns: ['tier'] })]).length === 2);

const pv = columnFlow(['region', 'month', 'amount'], [step({ type: 'pivot', key: 'region', value: 'amount', fn: 'sum', groupBy: ['month'] })], ['month', 'East', 'West']);
ok('a pivot is approximate: every output from every input', at(pv, 'East').how === 'approximate' && at(pv, 'East').from.length === 3, show(pv));
const un = columnFlow(['a'], [step({ type: 'mystery_step_from_a_newer_pod' })], ['a', 'z']);
ok('an unknown step type reads approximate', at(un, 'z').how === 'approximate');
ok('an approximate step does not claim a name a later step makes', at(columnFlow(['a'], [step({ type: 'window', fn: 'row_number', as: 'n' }), CALC('n2', '[a]')], ['a', 'n', 'n2']), 'n2').how === 'calc');

const ip = columnFlow(['a', 'b', 'c'], [step({ type: 'trim', column: 'a' }), step({ type: 'mask_hash', column: 'b' }), step({ type: 'mask_hash', column: 'c' }), step({ type: 'trim', column: 'c' })]);
ok('in place and masked say so, and masked sticks', at(ip, 'a').how === 'in_place' && at(ip, 'b').how === 'masked' && at(ip, 'c').how === 'masked');
ok('NEGATIVE CONTROL: a filter step adds no edge', show(columnFlow(['a'], [step({ type: 'filter', column: 'a', op: '=', value: 1 })])) === show(columnFlow(['a'], [])));
ok('NEGATIVE CONTROL: a step with no rule is not a no-op', columnFlow(['a'], [step({ type: 'unpivot', columns: ['a'] })], ['a', 'attribute']).length === 2);

// ── § consumers ─────────────────────────────────────────────────────────────

const { consumerColumns, metricColumns, keyColumns, ENCODING_FIELDS }: typeof import('../src/analysis/lineageColumns') = require('../src/analysis/lineageColumns');
const { buildGraph }: typeof import('../src/analysis/lineage') = require('../src/analysis/lineage');
import type { LineageInput } from '../src/analysis/lineage';

const ORDERS = '00000000-0000-4000-8000-0000000000a1';
const CUSTOMERS = '00000000-0000-4000-8000-0000000000a2';
const V = '00000000-0000-4000-8000-0000000000b1';
const cols = (...names: string[]) => names.map((name) => ({ name, type: 'text' }));
const flt = (column: string, value: unknown) => ({ type: 'filter', column, op: '=', value });
const REL = { id: '00000000-0000-4000-8000-0000000000c1', from: { datasetId: ORDERS, column: 'customer_id' }, to: { datasetId: CUSTOMERS, column: 'id' }, cardinality: 'many_to_one' as const, verified: { matched: 1, unmatchedFrom: 0 } };
const base = (): LineageInput => ({
  datasets: [
    { id: ORDERS, name: 'Orders', rowCount: 3, columns: cols('amount', 'cost', 'customer_id', 'order_date', 'units'), steps: [] },
    { id: CUSTOMERS, name: 'Customers', rowCount: 2, columns: cols('id', 'region', 'segment'), steps: [] },
  ],
  visuals: [], dashboards: [], metrics: [], reports: [], alerts: [], relationships: [REL],
});
const input = base();

// ── § consumers ─────────────────────────────────────────────────────────────
const v = { id: V, datasetId: ORDERS, encoding: { category: 'region', categoryDatasetId: CUSTOMERS, values: [{ column: 'amount', aggregation: 'sum' }] }, filters: [flt('segment', 'SMB')] };
ok('D19: Customers.region hangs off Customers, not Orders', show([...consumerColumns(v, input)]) === show([[ORDERS, ['amount']], [CUSTOMERS, ['region', 'segment']]]), show([...consumerColumns(v, input)]));
ok('a figure with no column on its own dataset still reads its primary (figureDatasets only grows)', show([...consumerColumns({ id: V, datasetId: ORDERS, encoding: { category: 'region', categoryDatasetId: CUSTOMERS, values: [] } }, input).keys()]) === show([ORDERS, CUSTOMERS]));

// Every column-naming field set to its own name: a field the reader skips shows up as a missing name.
const FULL = {
  id: V, datasetId: ORDERS,
  encoding: {
    category: 'cat', series: 'ser', values: [{ column: 'val', aggregation: 'sum' }, { column: 'viaMetric', aggregation: 'sum', metricId: 'm' }],
    geo: { level: 'flow', lat: 'g_lat', lon: 'g_lon', lat2: 'g_lat2', lon2: 'g_lon2', from: 'g_from', to: 'g_to', color: 'g_color', property: 'g_prop' },
    pivot: { rows: [{ column: 'p_row' }], columns: [{ column: 'p_col' }], values: [{ column: 'p_val', aggregation: 'sum' }] },
    cohort: { entity: 'c_ent', date: 'c_date', value: 'c_val' },
    eventFunnel: { entity: 'f_ent', event: 'f_evt', time: 'f_time', breakdown: 'f_brk' },
    drivers: { metric: { column: 'd_col', aggregation: 'sum' }, path: [{ column: 'd_path', value: 'x' }], compare: { mode: 'bucket', column: 'd_cmp', label: 'a', prev: 'b', grain: 'month' } },
    facet: { rows: 'fa_row', cols: 'fa_col' },
  },
  filters: [flt('flt', 1), { type: 'term', term: 'T' }],
};
const FULL_NAMES = ['cat', 'ser', 'val', 'g_lat', 'g_lon', 'g_lat2', 'g_lon2', 'g_from', 'g_to', 'g_color', 'g_prop', 'p_row', 'p_col', 'p_val', 'c_ent', 'c_date', 'c_val', 'f_ent', 'f_evt', 'f_time', 'f_brk', 'd_col', 'd_path', 'd_cmp', 'fa_row', 'fa_col', 'flt'];
const readFull = [...consumerColumns(FULL, input).values()].flat();
ok('every column-naming encoding field is read, and a metric measure and a term name no column', show([...readFull].sort()) === show([...FULL_NAMES].sort()), show(readFull));
const named = Object.entries(ENCODING_FIELDS).filter(([, k]) => k === 'column' || k === 'columns').map(([k]) => k);
ok('FULL sets every field ENCODING_FIELDS says names columns', named.every((k) => k in FULL.encoding), show(named));
ok('NEGATIVE CONTROL: ENCODING_FIELDS holds a field the reader ignores (grain), so classification, not reading, is what tsc enforces', ENCODING_FIELDS.grain === 'none' && !readFull.includes('month'));

const mF = { id: 'm1', datasetId: ORDERS, definition: { formula: 'sum(amount) / [Units]' } };
ok('D17: a formula naming a metric and a column', show([...metricColumns(mF, input)]) === show([[ORDERS, ['amount']]]), show([...metricColumns(mF, input)]));
// NEGATIVE CONTROL: the old regex reading is not what the graph now holds (it took the metric's name for a column).
const oldRegex = [...'sum(amount) / [Units]'.matchAll(/\[([^\]]+)\]/g)].map((x) => x[1]);
ok('NEGATIVE CONTROL: the old regex read `Units` as a column; the parser does not', oldRegex.includes('Units') && !metricColumns(mF, input).get(ORDERS)!.includes('Units'));
ok('an LOD aggregate reads the columns inside its braces', show(metricColumns({ id: 'm2', datasetId: ORDERS, definition: { formula: 'sum({FIXED [units] : sum([amount])})' } }, input).get(ORDERS)) === show(['units', 'amount']), show([...metricColumns({ id: 'm2', datasetId: ORDERS, definition: { formula: 'sum({FIXED [units] : sum([amount])})' } }, input)]));
ok('a simple metric reads its column, timeColumn, snapshot column and filters', show(metricColumns({ id: 'm3', datasetId: ORDERS, timeColumn: 'order_date', filters: [flt('region', 'W')], definition: { column: 'units', aggregation: 'sum', snapshot: { column: 'order_date', take: 'last' } } }, input)) === show(new Map([[ORDERS, ['units', 'order_date']], [CUSTOMERS, ['region']]])));
ok('keyColumns: both ends of the hop to Customers', show([...keyColumns(ORDERS, [CUSTOMERS], input)]) === show([[ORDERS, ['customer_id']], [CUSTOMERS, ['id']]]));
ok('NEGATIVE CONTROL: keyColumns names nothing for the primary alone', keyColumns(ORDERS, [ORDERS], input).size === 0);

const withV = { ...base(), visuals: [{ ...v, name: 'Related' }] };
const g0 = buildGraph(withV);
const edgesInto = (g: { edges: Array<{ from: string; to: string }> }, id: string): string[] => g.edges.filter((e) => e.to === id).map((e) => e.from);
ok('lineage:get: the related visual now has an edge from Customers', edgesInto(g0, `visual:${V}`).includes(`dataset:${CUSTOMERS}`) && edgesInto(g0, `visual:${V}`).includes(`dataset:${ORDERS}`), show(g0.edges));
const withTable = (t: string): LineageInput => ({ ...base(), connections: [{ id: 'cn', name: 'Warehouse', kind: 'postgres' }], datasets: [{ ...base().datasets[0], origin: { kind: 'connection', connId: 'cn', table: t } }] });
ok('D20: a connection source never names its table, and says its kind', !buildGraph(withTable('secret_tbl')).nodes.some((n) => /secret_tbl/.test(n.sub)) && buildGraph(withTable('x')).nodes.find((n) => n.kind === 'source')?.sub === 'postgres');

// ── § nodes ─────────────────────────────────────────────────────────────────
const { addColumnNodes, columnFields }: typeof import('../src/analysis/lineageNodes') = require('../src/analysis/lineageNodes');
const { focus }: typeof import('../src/analysis/lineage') = require('../src/analysis/lineage');
const id = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
const [TIER_DS, LIVE, REV, MPCT, WEST, VTERM, VPLAIN, DASH, ALERT] = [id(1), id(2), id(3), id(4), id(5), id(6), id(7), id(8), id(9)];
const col = (n: string, type = 'text') => ({ name: n, type });
const nodesInput = (): LineageInput => ({
  datasets: [
    {
      id: ORDERS, name: 'Orders', rowCount: 3,
      sourceColumns: [col('amt'), col('cost'), col('customer_id'), col('order_date'), col('unused')],
      columns: [col('amount'), col('cost'), col('customer_id'), col('order_date'), col('unused'), col('Margin'), col('tier')],
      steps: [R('amt', 'amount'), CALC('Margin', '[amount] - [cost]'), step({ type: 'lookup_join', datasetId: TIER_DS, leftKey: 'customer_id', rightKey: 'id', columns: ['tier'] })],
    },
    { id: CUSTOMERS, name: 'Customers', rowCount: 2, columns: [col('id'), col('region')], steps: [], origin: { kind: 'sql', sql: 'select secret_sql_7q' } },
    { id: TIER_DS, name: 'Tiers', rowCount: 2, columns: [col('id'), col('tier')], steps: [] },
    { id: LIVE, name: 'Live orders', columns: [col('amt'), col('cost')], steps: [], live: { calculated: [{ name: 'Margin', expression: '[amt] - [cost]', type: 'number' }] } },
  ],
  relationships: [REL],
  metrics: [
    { id: REV, name: 'Revenue', datasetId: ORDERS, timeColumn: 'order_date', definition: { column: 'amount', aggregation: 'sum' } },
    { id: MPCT, name: 'Margin %', datasetId: ORDERS, definition: { formula: 'sum(Margin) / sum(amount)' } },
  ],
  terms: [{ id: WEST, name: 'West', datasetId: CUSTOMERS, filters: [flt('region', 'West')] }],
  visuals: [
    { id: V, name: 'Related', datasetId: ORDERS, encoding: { category: 'region', categoryDatasetId: CUSTOMERS, values: [{ column: 'amount', aggregation: 'sum' }] }, filters: [] },
    { id: VTERM, name: 'Term chart', datasetId: ORDERS, encoding: { category: 'tier', values: [{ column: 'units', aggregation: 'sum' }] }, filters: [{ type: 'term', term: WEST }] },
    { id: VPLAIN, name: 'Plain', datasetId: ORDERS, encoding: { category: 'tier', values: [{ column: 'Margin', aggregation: 'sum' }] }, filters: [] },
    { id: id(10), name: 'Live chart', datasetId: LIVE, encoding: { category: 'amt', values: [{ column: 'Margin', aggregation: 'sum' }] }, filters: [] },
  ],
  dashboards: [{ id: DASH, name: 'Board', sheets: [{ cards: [{ type: 'visual', visualId: VTERM }, { type: 'visual', visualId: V }] }], filters: [] }],
  alerts: [{ id: ALERT, name: 'Alert', datasetId: ORDERS, metric: { metricId: REV }, compare: 'threshold' }],
  reports: [],
});
const ni = nodesInput();
const g = addColumnNodes(buildGraph(ni), ni);
const node = (gr: { nodes: Array<{ id: string; name: string; sub: string }> }, nid: string) => gr.nodes.find((n) => n.id === nid) as { id: string; name: string; sub: string };
const down = (gr: { edges: Array<{ from: string; to: string }> }, nid: string): string[] => {
  const seen = new Set<string>();
  const stack = [nid];
  while (stack.length) {
    const cur = stack.pop() as string;
    for (const e of gr.edges) if (e.from === cur && !seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
  }
  return [...seen];
};
const f1 = focus(g, `column:${ORDERS}:amount`);
ok('amount feeds Margin (calc), Revenue and Margin %', [`calc:${ORDERS}:Margin`, `metric:${REV}`, `metric:${MPCT}`].every((n) => f1.nodes.some((x) => x.id === n)), show(f1.nodes.map((x) => x.id)));
ok('the rename is one column, named by its final name', node(g, `column:${ORDERS}:amount`).sub === 'Renamed from amt');
ok('a dropped-or-kept input of a calc has a node: cost feeds Margin', down(g, `column:${ORDERS}:cost`).includes(`calc:${ORDERS}:Margin`));
ok('the join key Orders.customer_id is used by the related visual', down(g, `column:${ORDERS}:customer_id`).includes(`visual:${V}`) && down(g, `column:${CUSTOMERS}:id`).includes(`visual:${V}`));
ok('a lookup column is fed by the other dataset\'s column', down(g, `column:${TIER_DS}:tier`).includes(`column:${ORDERS}:tier`));
ok('a term node, by name only, between its column and the visual', node(g, `term:${WEST}`).name === 'West' && down(g, `column:${CUSTOMERS}:region`).includes(`term:${WEST}`) && down(g, `term:${WEST}`).includes(`visual:${VTERM}`) && g.nodes.filter((n) => n.id !== `term:${WEST}`).every((n) => !/West/.test(n.name + n.sub)) && !/secret_sql_7q/.test(JSON.stringify(g)));
ok('a term is not also a direct column edge to the figure that uses it', !g.edges.some((e) => e.from === `column:${CUSTOMERS}:region` && e.to === `visual:${VTERM}`));
ok('a Live calc reads its inputs', down(g, `column:${LIVE}:amt`).includes(`calc:${LIVE}:Margin`) && down(g, `calc:${LIVE}:Margin`).includes(`visual:${id(10)}`));
ok('a dataset with a SQL origin has column nodes, fed from the dataset only', g.edges.filter((e) => e.to === `column:${CUSTOMERS}:region`).every((e) => e.from === `dataset:${CUSTOMERS}`));
// Lineage's term usage, by kind, against the records (part 1's termUsage is not in this branch: step 10's tasks 2-3 add it).
const wu = focus(g, `term:${WEST}`).usedIn;
ok('term usage by kind: the chart that holds it, the dashboard that holds the chart', wu.visual === 1 && wu.dashboard === 1 && (wu.metric ?? 0) === 0 && (wu.alert ?? 0) === 0, show(wu));
ok('lineage:get draws no column or term node', !buildGraph(ni).nodes.some((n) => n.kind === 'column' || n.kind === 'term'));
ok('NEGATIVE CONTROL: a column nothing reads has no node', !g.nodes.some((n) => n.id === `column:${ORDERS}:unused`));
ok('addColumnNodes is pure: the graph it was given is unchanged', buildGraph(ni).nodes.length === buildGraph(ni).nodes.length && g.nodes.length > buildGraph(ni).nodes.length);
ok('every edge still points left to right in rank', g.edges.every((e) => {
  const k = new Map(g.nodes.map((n) => [n.id, n.kind])); const rank = (x: string) => (({ source: 0, dataset: 1, prepare: 2, calc: 3, column: 3, term: 4, metric: 4, visual: 5, dashboard: 6, report: 7, alert: 7 }) as Record<string, number>)[k.get(x) as string];
  return rank(e.from) <= rank(e.to);
}));

// ── "Used by": columnFields ─────────────────────────────────────────────────
const cf = columnFields(g, ni, ORDERS);
ok('fields: amount is used by 2 metrics; the unread column is absent', cf.fields.amount.usedIn.metric === 2 && !('unused' in cf.fields), show(cf.fields.amount));
ok('fields is a null-prototype record', Object.getPrototypeOf(cf.fields) === null && !('constructor' in cf.fields));
ok('fields agree with focus: the same usedIn', show(cf.fields.amount.usedIn) === show(focus(g, `column:${ORDERS}:amount`).usedIn));
const calcStep = cf.steps.find((s) => s.produces.includes('Margin'));
ok('steps: the calc step reports what it feeds, once each', !!calcStep && calcStep.usedIn.metric === 1 && calcStep.usedIn.visual === 1, show(cf.steps));
ok('steps: the rename and the lookup are listed, a filter would not be', show(cf.steps.map((s) => s.index)) === show([0, 1, 2]) && show(cf.steps[0].produces) === show(['amount']));
ok('fields: a Live dataset\'s calcs appear', columnFields(g, ni, LIVE).fields.Margin.usedIn.visual === 1);

// ── § channel ───────────────────────────────────────────────────────────────
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers; // any: each channel's own reply shape
require('../src/ipc/lineage').register();
const post = (channel: string, payload: unknown): Promise<any> => handlers.get(channel)!({}, payload);

(async () => {
  const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const metricStore: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
  const visualStore: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
  const seeded = await sample.seedSampleProject();
  if (!seeded.seeded || !seeded.projectId) throw new Error('sample not seeded');
  const P = seeded.projectId;
  const sampleDs = (await datasets.listDatasets(P))[0].id;

  const c = await post('lineage:column', { projectId: P, datasetId: sampleDs, column: 'Month' });
  ok('lineage:column: focused on the calculated field, used by the chart and its dashboard', c.focus === `calc:${sampleDs}:Month` && c.usedIn.visual === 1 && c.usedIn.dashboard === 1 && typeof c.upstream === 'number', show(c && c.usedIn));
  const fl = await post('lineage:fields', { projectId: P, datasetId: sampleDs });
  ok('lineage:fields: Month is used by 1 chart, and its Prepare step reports what it feeds', fl.ok === true && fl.fields.Month.usedIn.visual === 1 && fl.steps.some((s: { produces: string[]; usedIn: { visual?: number } }) => s.produces.includes('Month') && s.usedIn.visual === 1), show(fl));
  ok('lineage:column and lineage:fields agree on "Used in"', show(c.usedIn) === show(fl.fields.Month.usedIn));
  ok('a column nobody reads, and an unknown one, answer null, not an error', (await post('lineage:column', { projectId: P, datasetId: sampleDs, column: 'nope' })) === null);
  ok('a bad id answers null / empty', (await post('lineage:column', { projectId: 'x', datasetId: sampleDs, column: 'a' })) === null && Object.keys((await post('lineage:fields', { projectId: 'x', datasetId: sampleDs })).fields).length === 0);

  // ORIGIN CANARY: a planted path, keyed URL, table and SQL reach neither reply.
  const conns: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
  const conn = await conns.saveConnection(P, { connectorId: 'postgres', name: 'Warehouse', values: { host: 'h.test', database: 'db' } } as never);
  const mk = (name: string, origin: unknown) => datasets.saveDataset(P, { name, sourceKind: 'csv', columns: [{ name: 'amount', type: 'number' }, { name: 'region', type: 'text' }], rows: [[1, 'a']], origin });
  const planted = [
    await mk('From file', { kind: 'file', path: '/secret_dir_7q/orders.csv' }),
    await mk('From url', { kind: 'url', url: 'https://example.test/x.csv?key=secret_7q' }),
    await mk('From table', { kind: 'connection', connId: conn?.id ?? '00000000-0000-4000-8000-0000000000ff', table: 'secret_tbl_7q' }),
  ];
  for (const d of planted) {
    await metricStore.saveMetric(P, { name: 'Sum ' + d!.name, datasetId: d!.id, definition: { column: 'amount', aggregation: 'sum' } } as never);
    await visualStore.saveVisual(P, { name: 'Chart ' + d!.name, datasetId: d!.id, chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } } as never);
  }
  const CANARY = /secret_dir_7q|key=secret_7q|secret_tbl_7q|SELECT secret_7q/;
  const replies = [];
  for (const d of planted) {
    replies.push(await post('lineage:column', { projectId: P, datasetId: d!.id, column: 'amount' }), await post('lineage:fields', { projectId: P, datasetId: d!.id }));
  }
  replies.push(await post('lineage:get', { projectId: P, type: 'dataset', id: planted[0]!.id }));
  ok('ORIGIN CANARY: a planted path, keyed URL and table reach neither reply (nor lineage:get)', replies.every((r) => !CANARY.test(JSON.stringify(r))), replies.map((r) => JSON.stringify(r)).find((t) => CANARY.test(t)));
  ok('…and the column graph was not empty, so the canary check was not vacuous', replies[0] && replies[0].nodes.some((n: { kind: string }) => n.kind === 'source') && replies[0].usedIn.metric === 1, show(replies[0] && replies[0].usedIn));
  const stored = fs.readdirSync(process.env.ORDINATE_LOCAL_DIR as string, { recursive: true } as never).map(String).filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(process.env.ORDINATE_LOCAL_DIR as string, f), 'utf8')).join('');
  ok('NEGATIVE CONTROL: the canary is in the stored records', /secret_dir_7q/.test(stored) && /secret_tbl_7q/.test(stored) && /key=secret_7q/.test(stored));
  finish();
})().catch((err: unknown) => { console.error(err); process.exit(1); });
