// The additivity rule (semantic layer part 1, D7): whether a measure can be added up across categories and
// across time, derived from what the measure IS and never typed in. A running total, a percent of total and a
// moving sum add; a chart that asks one of them of a measure that does not add is refused with a sentence.
//
//   npm run build:ts && node scripts/test-additivity.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const A: typeof import('../src/analysis/additivity') = require('../src/analysis/additivity');
const msg: typeof import('../src/analysis/metricCheckMessages') = require('../src/analysis/metricCheckMessages');
type Additivity = import('../src/analysis/additivity').Additivity;
type Metric = import('../src/analysis/metrics').Metric;

const DS = 'ds-1';

// ── rules ────────────────────────────────────────────────────────────────────────────────────────────────────────
const same = (a: Additivity, c: boolean, t: boolean) => Object.is(a.categories, c) && Object.is(a.time, t);
for (const [agg, want] of [['sum', true], ['count', true], ['none', true], ['avg', false], ['min', false], ['max', false]] as const)
  ok(`aggregation ${agg}`, same(A.aggregationAdditivity(agg), want, want));
const COLS = [{ name: 'revenue', type: 'number' }, { name: 'cost', type: 'number' }, { name: 'day', type: 'date' }, { name: 'units', type: 'number' }] as never as import('../src/data/parse').ParsedColumn[];
const M = (name: string, definition: object) => ({ id: name, name, datasetId: DS, definition, filters: [] }) as never as Metric;
const ms = [M('Revenue', { column: 'revenue', aggregation: 'sum' }), M('Cost', { column: 'cost', aggregation: 'sum' }), M('Avg price', { column: 'revenue', aggregation: 'avg' })];
const byName = new Map(ms.map((m) => [m.name.toLowerCase(), m]));
for (const [formula, want] of [['[Revenue] - [Cost]', true], ['sum(revenue) + sum(cost)', true], ['2 * [Revenue]', true],
  ['[Revenue] / [Cost]', false], ['[Revenue] + [Avg price]', false], ['sum(revenue) + 5', false], ['[Missing] + [Revenue]', false]] as const)
  ok(`formula ${formula}`, same(A.additivityOf(M('F', { formula }), COLS, byName), want, want));
ok('snapshot sum: across categories yes, across time no', same(A.additivityOf(M('Stock', { column: 'units', aggregation: 'sum', snapshot: { column: 'day', take: 'last' } }), COLS, byName), true, false));
ok('snapshot avg: neither', same(A.additivityOf(M('Lvl', { column: 'units', aggregation: 'avg', snapshot: { column: 'day', take: 'last' } }), COLS, byName), false, false));
for (const k of ['running_total', 'pct_of_total', 'moving_sum'] as const) ok(`${k} adds`, A.calcNeedsAdditive(k, false) === 'categories' && A.calcNeedsAdditive(k, true) === 'time');
for (const k of ['diff', 'pct_diff', 'rank_dense', 'rank_competition', 'percentile', 'moving_avg', 'yoy', 'index'] as const)
  ok(`${k} adds nothing`, A.calcNeedsAdditive(k, false) === null && A.calcNeedsAdditive(k, true) === null);
ok('avg running total → refused', A.calcRefusal('Avg price', 'running_total', { categories: false, time: false }, false) === msg.calcNotAdditive('Avg price', 'a running total'));
ok('snapshot along dates → the time sentence', A.calcRefusal('Stock', 'running_total', { categories: true, time: false }, true) === msg.calcNotAdditiveOverTime('Stock', 'a running total'));
ok('snapshot across regions → allowed', A.calcRefusal('Stock', 'pct_of_total', { categories: true, time: false }, false) === null);
ok('sum along dates → allowed', A.calcRefusal('Revenue', 'moving_sum', { categories: true, time: true }, true) === null);

finish();
