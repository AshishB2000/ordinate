// Self-check for src/vizData.ts — the PURE visualization bridge. No Electron / fs
// stub needed (buildVizData is pure). Verifies aggregation correctness (sum/avg/
// count/min/max by category, all app-computed), the emitted shape has exactly the
// fields buildChart needs, a leading-zero category stays intact, non-numeric cells
// become null, the split/pivot grid, geo item derivation, and an empty encoding
// yields a sane empty shape instead of throwing. No framework.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

type ParsedColumn = import('../src/data/parse').ParsedColumn;

// ponytail: compiled sibling of ../src/vizData.ts.
const vizData: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
const { buildVizData } = vizData;


const cols: ParsedColumn[] = [
  { name: 'city', type: 'text' },
  { name: 'amount', type: 'number' },
];
const rows: (string | number | null)[][] = [
  ['Paris', 10],
  ['Berlin', 20],
  ['Paris', 5],
  ['Berlin', 20],
];

// ── (A) aggregated: sum / avg / count / min / max by category ─────────────────
function agg(fn: 'sum' | 'avg' | 'count' | 'min' | 'max') {
  return buildVizData(cols, rows, { category: 'city', values: [{ column: 'amount', aggregation: fn }] });
}

const sum = agg('sum');
ok('sum: labels are the two cities (first-seen order)', JSON.stringify(sum.data.labels) === JSON.stringify(['Paris', 'Berlin']));
ok('sum: one series', sum.data.series.length === 1);
ok('sum: Paris=15, Berlin=40 (app-computed)', JSON.stringify(sum.data.series[0].values) === JSON.stringify([15, 40]));

const avg = agg('avg');
ok('avg: Paris=7.5, Berlin=20', JSON.stringify(avg.data.series[0].values) === JSON.stringify([7.5, 20]));

const count = agg('count');
ok('count: 2 non-empty per city', JSON.stringify(count.data.series[0].values) === JSON.stringify([2, 2]));

const min = agg('min');
ok('min: Paris=5, Berlin=20', JSON.stringify(min.data.series[0].values) === JSON.stringify([5, 20]));

const max = agg('max');
ok('max: Paris=10, Berlin=20', JSON.stringify(max.data.series[0].values) === JSON.stringify([10, 20]));

// ── tiny SALES dataset: category=region, measure=amount (sum) ────────────────
// Spec check — per-region totals are app-computed, the emitted shape carries the
// exact fields buildChart consumes, and a leading-zero region code stays a string.
const salesCols: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'amount', type: 'number' },
];
const salesRows: (string | number | null)[][] = [
  ['North', 100],
  ['South', 250],
  ['North', 50],
  ['0East', 40], // leading-zero region code, stored as text
  ['South', 250],
];
const sales = buildVizData(salesCols, salesRows, {
  category: 'region',
  values: [{ column: 'amount', aggregation: 'sum' }],
});
ok('sales: regions in first-seen order', JSON.stringify(sales.data.labels) === JSON.stringify(['North', 'South', '0East']));
ok('sales: per-region totals North=150, South=500, 0East=40', JSON.stringify(sales.data.series[0].values) === JSON.stringify([150, 500, 40]));
ok('sales: leading-zero region "0East" stays a string', sales.data.labels[2] === '0East');
ok('sales: shape has labels + series[].name + parallel numeric values', Array.isArray(sales.data.labels)
  && Array.isArray(sales.data.series)
  && typeof sales.data.series[0].name === 'string'
  && sales.data.series[0].values.length === sales.data.labels.length
  && sales.data.series[0].values.every((v) => typeof v === 'number' || v === null));
ok('sales: recommendedShape + warnings present', typeof sales.recommendedShape === 'string' && Array.isArray(sales.warnings));

// ── emitted shape: exactly what buildChart consumes ──────────────────────────
ok('shape: data.labels is an array', Array.isArray(sum.data.labels));
ok('shape: data.series is an array', Array.isArray(sum.data.series));
ok('shape: series[0] has string name', typeof sum.data.series[0].name === 'string' && sum.data.series[0].name.length > 0);
ok('shape: series[0].values is an array parallel to labels', sum.data.series[0].values.length === sum.data.labels.length);
ok('shape: every value cell is a number or null', sum.data.series[0].values.every((v) => typeof v === 'number' || v === null));
ok('result carries a recommendedShape string', typeof sum.recommendedShape === 'string' && sum.recommendedShape.length > 0);
ok('result carries a warnings array', Array.isArray(sum.warnings));

// ── multiple measures → multiple series ──────────────────────────────────────
const multi = buildVizData(cols, rows, {
  category: 'city',
  values: [{ column: 'amount', aggregation: 'sum' }, { column: 'amount', aggregation: 'max' }],
});
ok('two measures → two series', multi.data.series.length === 2);
ok('measure series names differ', multi.data.series[0].name !== multi.data.series[1].name);
ok('sum series correct', JSON.stringify(multi.data.series[0].values) === JSON.stringify([15, 40]));
ok('max series correct', JSON.stringify(multi.data.series[1].values) === JSON.stringify([10, 20]));

// ── leading-zero category stays intact (never coerced to a number) ───────────
const zeroCols: ParsedColumn[] = [{ name: 'code', type: 'text' }, { name: 'n', type: 'number' }];
const zeroRows: (string | number | null)[][] = [['007', 3], ['012', 4], ['007', 1]];
const zero = buildVizData(zeroCols, zeroRows, { category: 'code', values: [{ column: 'n', aggregation: 'sum' }] });
ok('leading-zero label "007" kept as a string', zero.data.labels[0] === '007');
ok('leading-zero label "012" kept as a string', zero.data.labels[1] === '012');
ok('leading-zero grouped sum: 007=4, 012=4', JSON.stringify(zero.data.series[0].values) === JSON.stringify([4, 4]));

// ── (C) raw, no aggregation: each row is a point ─────────────────────────────
const raw = buildVizData(cols, rows, { category: 'city', values: [{ column: 'amount', aggregation: 'none' }] });
ok('raw: labels are the raw category cells', JSON.stringify(raw.data.labels) === JSON.stringify(['Paris', 'Berlin', 'Paris', 'Berlin']));
ok('raw: values are the raw numeric cells', JSON.stringify(raw.data.series[0].values) === JSON.stringify([10, 20, 5, 20]));

// non-numeric raw measure → all null (never a string)
const rawText = buildVizData(cols, rows, { category: 'amount', values: [{ column: 'city', aggregation: 'none' }] });
ok('raw text measure → every value null', rawText.data.series[0].values.every((v) => v === null));

// ── (B) split/pivot: category × series → grid, missing combo → null ──────────
const pivotCols: ParsedColumn[] = [
  { name: 'city', type: 'text' },
  { name: 'year', type: 'text' },
  { name: 'amount', type: 'number' },
];
const pivotRows: (string | number | null)[][] = [
  ['Paris', '2023', 10],
  ['Paris', '2024', 20],
  ['Berlin', '2023', 5],
];
const pivot = buildVizData(pivotCols, pivotRows, {
  category: 'city',
  series: 'year',
  values: [{ column: 'amount', aggregation: 'sum' }],
});
ok('pivot: labels are distinct categories', JSON.stringify(pivot.data.labels) === JSON.stringify(['Paris', 'Berlin']));
ok('pivot: one series per distinct series-value', pivot.data.series.length === 2);
ok('pivot: 2023 series = [10, 5]', JSON.stringify(pivot.data.series[0].values) === JSON.stringify([10, 5]));
ok('pivot: 2024 series = [20, null] (missing Berlin/2024 → null)', JSON.stringify(pivot.data.series[1].values) === JSON.stringify([20, null]));

// ── geo: region items derived from the first series ──────────────────────────
const geo = buildVizData(cols, rows, {
  category: 'city',
  values: [{ column: 'amount', aggregation: 'sum' }],
  geo: { level: 'country' },
});
ok('geo: data.geo present with the level', geo.data.geo !== undefined && geo.data.geo.level === 'country');
ok('geo: items derived from labels + first series', JSON.stringify(geo.data.geo!.items) === JSON.stringify([
  { name: 'Paris', value: 15 },
  { name: 'Berlin', value: 40 },
]));
ok('geo: single series omits dataShape', geo.data.dataShape === undefined);

// geo + split (2+ series) → keeps labels/series + dataShape time_series
const geoSplit = buildVizData(pivotCols, pivotRows, {
  category: 'city',
  series: 'year',
  values: [{ column: 'amount', aggregation: 'sum' }],
  geo: { level: 'country' },
});
ok('geo split: dataShape=time_series when 2+ series', geoSplit.data.dataShape === 'time_series');
ok('geo split: keeps labels+series for period stepping', geoSplit.data.series.length === 2 && geoSplit.data.labels.length === 2);

// ── empty / degenerate encodings → sane empty shape, never a throw ───────────
const noCat = buildVizData(cols, rows, { category: '', values: [{ column: 'amount', aggregation: 'sum' }] });
ok('empty category → empty labels', noCat.data.labels.length === 0);
ok('empty category → empty series', noCat.data.series.length === 0);
ok('empty category → a warning', noCat.warnings.length > 0);
ok('empty category → still a recommendedShape', typeof noCat.recommendedShape === 'string');

const noMeasure = buildVizData(cols, rows, { category: 'city', values: [] });
ok('no measure → empty shape', noMeasure.data.labels.length === 0 && noMeasure.data.series.length === 0);
ok('no measure → a warning', noMeasure.warnings.length > 0);

const badCat = buildVizData(cols, rows, { category: 'nope', values: [{ column: 'amount', aggregation: 'sum' }] });
ok('unknown category column → empty shape + warning', badCat.data.labels.length === 0 && badCat.warnings.length > 0);

// ── filters applied BEFORE aggregation (transforms filter steps) ─────────────
type FilterStep = import('../src/data/transforms').FilterStep;

// A filter narrows the rows first; the SAME app-computed aggregation then runs over
// the subset — so the total equals the hand-computed subtotal, not the grand total.
const fCols: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'country', type: 'text' },
  { name: 'amount', type: 'number' },
];
const fRows: (string | number | null)[][] = [
  ['North', 'US', 100],
  ['South', 'US', 250],
  ['North', 'CA', 50],
  ['South', 'CA', 40],
];

// No filter → grand totals per region (North=150, South=290).
const unfiltered = buildVizData(fCols, fRows, { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] });
ok('unfiltered: North=150, South=290', JSON.stringify(unfiltered.data.series[0].values) === JSON.stringify([150, 290]));

// filter country=US → only US rows survive; North=100, South=250.
const usOnly: FilterStep[] = [{ type: 'filter', column: 'country', op: '=', value: 'US' }];
const filtered = buildVizData(fCols, fRows, { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, usOnly);
ok('filter country=US changes the aggregation (North=100, South=250)',
  JSON.stringify(filtered.data.series[0].values) === JSON.stringify([100, 250]));
ok('filtered labels are only the surviving regions', JSON.stringify(filtered.data.labels) === JSON.stringify(['North', 'South']));

// A numeric filter (amount > 60) drops the 50 and 40 rows → only North(US) & South(US).
const bigOnly: FilterStep[] = [{ type: 'filter', column: 'amount', op: '>', value: 60 }];
const big = buildVizData(fCols, fRows, { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, bigOnly);
ok('numeric filter amount>60 → North=100, South=250',
  JSON.stringify(big.data.series[0].values) === JSON.stringify([100, 250]));

// Empty/omitted filters → identical to the unfiltered result (Week 7 behavior).
const emptyFilters = buildVizData(fCols, fRows, { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, []);
ok('empty filters === unfiltered', JSON.stringify(emptyFilters.data.series[0].values) === JSON.stringify([150, 290]));

// Unknown filter column → the step is skipped with a warning (never throws).
const badFilter: FilterStep[] = [{ type: 'filter', column: 'nope', op: '=', value: 'x' }];
const badFiltered = buildVizData(fCols, fRows, { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, badFilter);
ok('unknown filter column surfaces a warning', badFiltered.warnings.some((w) => w.includes('nope')));
ok('unknown filter column leaves rows unchanged', JSON.stringify(badFiltered.data.series[0].values) === JSON.stringify([150, 290]));

// ── strict number rule holds through a filtered + aggregated viz ─────────────
// A leading-zero id ("007") is a TEXT category; filtering then summing must keep
// the label a string AND compute the subtotal from finite numbers only.
const lzCols: ParsedColumn[] = [
  { name: 'code', type: 'text' },
  { name: 'active', type: 'text' },
  { name: 'n', type: 'number' },
];
const lzRows: (string | number | null)[][] = [
  ['007', 'yes', 3],
  ['007', 'no', 100],
  ['012', 'yes', 4],
  ['007', 'yes', 1],
];
const lzKeep: FilterStep[] = [{ type: 'filter', column: 'active', op: '=', value: 'yes' }];
const lz = buildVizData(lzCols, lzRows, { category: 'code', values: [{ column: 'n', aggregation: 'sum' }] }, lzKeep);
ok('filtered+aggregated: leading-zero label "007" stays a string', lz.data.labels[0] === '007');
ok('filtered+aggregated: 007 subtotal excludes the filtered-out 100 (007=4, 012=4)',
  JSON.stringify(lz.data.series[0].values) === JSON.stringify([4, 4]));
ok('filtered+aggregated: every value is a number or null', lz.data.series[0].values.every((v) => typeof v === 'number' || v === null));

// fully malformed encoding (nulls) must not throw
let threw = false;
try {
  buildVizData(cols, rows, { category: null as any, values: null as any });
} catch (_) {
  threw = true;
}
ok('malformed encoding does not throw', threw === false);

if (failureCount()) { console.error('\n' + failureCount() + ' vizData check(s) FAILED'); process.exit(1); }
console.log('\nAll vizData checks passed.');
