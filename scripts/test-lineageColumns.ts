// Self-check for column-level lineage (semantic layer part 8, D16-D20): the flow through Prepare, what each
// consumer reads on its own dataset, column and term nodes, and the lineage:column / lineage:fields channels.
//
//   npm run build:ts && node scripts/test-lineageColumns.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

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

finish();
