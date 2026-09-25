// Self-check for src/ai/answerSpec.ts — the gate between a model's answer spec
// and a chart the app computes.
//
// Three groups, one per thing the spec is trusted for:
//   1. COLUMN RESOLUTION — every name the model writes is matched to a real
//      column, loosely (case, spaces, underscores) but never ambiguously.
//   2. SPEC VALIDATION — anything that does not resolve rejects the WHOLE spec,
//      with a reason; a filter is never silently dropped (it would change the
//      answer's meaning while looking right).
//   3. CHIPS PER SPEC SHAPE — the follow-ups the app offers are a pure function
//      of the spec, so each shape's chip set is pinned.
// Plus the relative periods (resolved against the DATA's latest date) and the
// action-line whitelist for the new `answer` kind.
//
//   npm run build:ts && node scripts/test-answerSpec.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const path: typeof import('path') = require('path');
const os: typeof import('os') = require('os');
const Module: any = require('module');

// analysisPlan.ts (for the chart vocabulary drift guard below) pulls in electron.
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: () => path.join(os.tmpdir(), 'ordinate-answerspec') }, ipcMain: { handle: () => {} } };
  return origLoad.apply(this, [request, ...rest]);
};

const A: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const sa: typeof import('../src/ai/suggestedAction') = require('../src/ai/suggestedAction');
const plan: typeof import('../src/analysis/analysisPlan') = require('../src/analysis/analysisPlan');

type ParsedColumn = import('../src/data/parse').ParsedColumn;
type Cell = import('../src/data/transforms').Cell;

const COLS: ParsedColumn[] = [
  { name: 'order_date', type: 'date' },
  { name: 'region', type: 'text' },
  { name: 'category', type: 'text' },
  { name: 'Sub Category', type: 'text' },
  { name: 'revenue', type: 'number' },
  { name: 'profit', type: 'number' },
];
const DS = { id: '11111111-1111-4111-8111-111111111111', name: 'Retail orders', columns: COLS };
const OTHER = { id: '22222222-2222-4222-8222-222222222222', name: 'Budget', columns: [{ name: 'region', type: 'text' as const }] };

// ── 1. Column resolution ────────────────────────────────────────────────────

const res = (n: unknown): string | null => { const c = A.resolveColumn(n, COLS); return c ? c.name : null; };
ok('resolve: exact', res('revenue') === 'revenue');
ok('resolve: case-insensitive', res('Revenue') === 'revenue');
ok('resolve: spaces for underscores ("order date")', res('order date') === 'order_date');
ok('resolve: underscores for spaces ("sub_category")', res('sub_category') === 'Sub Category');
ok('resolve: punctuation ignored ("Order-Date")', res('Order-Date') === 'order_date');
ok('resolve: unknown → null', res('margin') === null);
ok('resolve: empty / non-string → null', res('') === null && res(42) === null && res(null) === null);
const ambiguous: ParsedColumn[] = [{ name: 'Order Date', type: 'date' }, { name: 'order_date', type: 'date' }];
ok('resolve: two columns squashing to one key resolve to NEITHER', A.resolveColumn('orderdate', ambiguous) === null);
ok('resolve: …but an exact name still wins', A.resolveColumn('order_date', ambiguous)?.name === 'order_date');

// ── 2. Spec validation ──────────────────────────────────────────────────────

const v = (spec: unknown, opts: any = {}) => A.validateAnswerSpec(spec, [DS, OTHER], opts);
const good = v({ dataset: 'Retail orders', category: 'Region', measures: [{ column: 'Revenue', aggregation: 'sum' }] });
ok('valid: names resolve to the real columns', good.ok && good.spec.category === 'region'
  && good.spec.measures[0].column === 'revenue' && good.spec.datasetId === DS.id, JSON.stringify(good));
ok('valid: a categorical answer defaults to a column chart', good.ok && good.spec.chartType === 'column');
ok('valid: the title falls back to an app-written one', good.ok && good.spec.title === 'Revenue by region', good.ok ? good.spec.title : '');

const byDate = v({ dataset: 'retail ORDERS', category: 'order date', measures: ['sum(revenue)'] }, { title: 'revenue over time' });
ok('valid: dataset by loose name, measure as "sum(col)", a date axis defaults to a line',
  byDate.ok && byDate.spec.chartType === 'line' && byDate.spec.measures[0].aggregation === 'sum', JSON.stringify(byDate));
ok('valid: the question becomes the title, capitalised', byDate.ok && byDate.spec.title === 'Revenue over time');

const defaults = v({ dataset: DS.id, category: 'region', measures: ['profit', 'region'] });
ok('valid: default aggregation — number summed, text counted',
  defaults.ok && defaults.spec.measures[0].aggregation === 'sum' && defaults.spec.measures[1].aggregation === 'count', JSON.stringify(defaults));

ok('valid: the dataset in context is the default',
  (() => { const r = v({ category: 'region', measures: ['revenue'] }, { defaultDatasetId: DS.id }); return r.ok && r.spec.datasetId === DS.id; })());
ok('reject: no dataset named, two in the project, none in context', !v({ category: 'region', measures: ['revenue'] }).ok);
ok('valid: one dataset in the project needs no name',
  (() => { const r = A.validateAnswerSpec({ category: 'region', measures: ['revenue'] }, [DS]); return r.ok; })());

const rejects: [string, unknown, RegExp][] = [
  ['unknown dataset', { dataset: 'Nope', category: 'region', measures: ['revenue'] }, /Unknown dataset/],
  ['unknown category', { dataset: DS.id, category: 'state', measures: ['revenue'] }, /category/],
  ['unknown measure', { dataset: DS.id, category: 'region', measures: ['margin'] }, /measure/],
  ['no measure', { dataset: DS.id, category: 'region', measures: [] }, /no measure/],
  ['sum of a text column', { dataset: DS.id, category: 'region', measures: [{ column: 'category', aggregation: 'sum' }] }, /cannot be summed/],
  ['avg of a date column', { dataset: DS.id, category: 'region', measures: [{ column: 'order_date', aggregation: 'average' }] }, /averaged/],
  ['unknown aggregation', { dataset: DS.id, category: 'region', measures: [{ column: 'revenue', aggregation: 'median' }] }, /aggregation/],
  ['unknown filter column', { dataset: DS.id, category: 'region', measures: ['revenue'], filters: [{ column: 'state', op: '=', value: 'CA' }] }, /filter column/],
  ['unknown filter operator', { dataset: DS.id, category: 'region', measures: ['revenue'], filters: [{ column: 'region', op: 'like', value: 'W' }] }, /operator/],
  ['a text value on a number filter', { dataset: DS.id, category: 'region', measures: ['revenue'], filters: [{ column: 'revenue', op: '>', value: 'lots' }] }, /does not fit/],
  ['a period on a text column', { dataset: DS.id, category: 'region', measures: ['revenue'], filters: [{ column: 'region', period: 'last_quarter' }] }, /not a date/],
  ['an unknown period', { dataset: DS.id, category: 'region', measures: ['revenue'], filters: [{ column: 'order_date', period: 'last_decade' }] }, /period/],
  ['a split equal to the category', { dataset: DS.id, category: 'region', series: 'Region', measures: ['revenue'] }, /split/],
  ['not an object', 'revenue by region', /no spec/],
];
for (const [label, spec, re] of rejects) {
  const r = v(spec);
  ok('reject: ' + label, !r.ok && re.test(r.reason), JSON.stringify(r));
}

const filtered = v({
  dataset: DS.id, category: 'region', measures: ['revenue'],
  filters: [
    { column: 'Region', op: 'in', values: ['West', 'East'] },
    { column: 'revenue', op: 'gte', value: '100' },
    { column: 'order_date', period: 'last_quarter' },
  ],
});
ok('filters: op aliases, an `in` list, a number coerced, a period kept as a period',
  filtered.ok && JSON.stringify(filtered.spec.filters) === JSON.stringify([
    { column: 'region', op: 'in', values: ['West', 'East'] },
    { column: 'revenue', op: '>=', value: 100 },
    { column: 'order_date', period: 'last_quarter' },
  ]), JSON.stringify(filtered));

const typed = v({ dataset: DS.id, category: 'region', measures: ['revenue'], chartType: 'pie', top: 5 });
ok('chart type: a whitelisted one is kept; top is kept', typed.ok && typed.spec.chartType === 'pie' && typed.spec.top === 5);
const bogus = v({ dataset: DS.id, category: 'region', measures: ['revenue'], chartType: 'map_choropleth', top: 500 });
ok('chart type: a map falls back to the default; top is clamped to 50',
  bogus.ok && bogus.spec.chartType === 'column' && bogus.spec.top === 50, JSON.stringify(bogus));
const topOnDate = v({ dataset: DS.id, category: 'order_date', measures: ['revenue'], top: 3 });
ok('top: never on a date axis', topOnDate.ok && topOnDate.spec.top === undefined);

const METRICS = [
  { id: '33333333-3333-4333-8333-333333333333', name: 'Revenue', datasetId: DS.id, column: 'revenue', aggregation: 'sum' },
  { id: '44444444-4444-4444-8444-444444444444', name: 'Net sales', datasetId: DS.id, column: 'revenue', aggregation: 'sum', hasFilters: true },
];
const byMetric = v({ dataset: DS.id, category: 'region', measures: ['revenue'] }, { metrics: METRICS });
ok('metric: a COLUMN name still resolves to the column, not the metric', byMetric.ok && !byMetric.spec.measures[0].metricId);
const gross = v({ dataset: DS.id, category: 'region', measures: [{ metric: 'Turnover' }] }, {
  metrics: [{ ...METRICS[0], name: 'Gross take' }, METRICS[1]] });
ok('metric: an unknown name that is not a metric is still unknown', !gross.ok);
const namedMetric = v({ dataset: DS.id, category: 'region', measures: ['Gross take'] }, {
  metrics: [{ ...METRICS[0], name: 'Gross take' }] });
ok('metric: a defined metric by NAME becomes its column + aggregation + metricId',
  namedMetric.ok && namedMetric.spec.measures[0].column === 'revenue' && namedMetric.spec.measures[0].metricId === METRICS[0].id,
  JSON.stringify(namedMetric));
const filteredMetric = v({ dataset: DS.id, category: 'region', measures: ['Net sales'] }, { metrics: METRICS });
ok('metric: one with its own row filters never becomes a bare chart measure', !filteredMetric.ok);

ok('vocabulary: every answer chart type is a type the app draws',
  [...A.ANSWER_CHART_TYPES].every((t) => plan.CHART_TYPE_IDS.has(t)));

// ── Stored specs are re-sanitised on read ───────────────────────────────────

const stored = A.sanitizeStoredSpec({
  datasetId: DS.id, category: 'region', measures: [{ column: 'revenue', aggregation: 'sum' }, { column: 'x', aggregation: 'evil' }],
  filters: [{ column: 'region', op: '=', value: 'West' }, { column: 'region', op: 'drop table' }, { column: 'order_date', period: 'last_year', yearsBack: 2 }],
  chartType: 'column', title: 'Revenue', top: 7, grain: 'month', extra: 'dropped',
});
ok('stored: known fields kept, unknown aggregation / operator dropped, extra keys gone',
  !!stored && stored.measures.length === 1 && stored.filters.length === 2 && stored.top === 7 && stored.grain === 'month'
  && !('extra' in stored), JSON.stringify(stored));
ok('stored: a non-UUID dataset id is refused', A.sanitizeStoredSpec({ datasetId: '../x', category: 'a', measures: [{ column: 'b', aggregation: 'sum' }] }) === undefined);

// ── Periods: against the DATA's latest date ─────────────────────────────────

const latest = { y: 2024, m: 12, d: 30 };
ok('period: last quarter of data ending 2024-12-30 is 2024-Q4', A.resolvePeriod('last_quarter', latest).label === '2024-Q4');
ok('period: …a year back is 2023-Q4', A.resolvePeriod('last_quarter', latest, 1).label === '2023-Q4');
ok('period: last month / last year', A.resolvePeriod('last_month', latest).label === '2024-12' && A.resolvePeriod('last_year', latest).label === '2024');
ok('period bounds: a quarter, a year-end month, a leap February',
  JSON.stringify(A.periodBounds('quarter', A.resolvePeriod('last_quarter', latest).bucket)) === '{"from":"2024-10-01","to":"2024-12-31"}'
  && JSON.stringify(A.periodBounds('month', A.resolvePeriod('last_month', latest).bucket)) === '{"from":"2024-12-01","to":"2024-12-31"}'
  && A.periodBounds('month', A.resolvePeriod('last_month', { y: 2024, m: 2, d: 10 }).bucket).to === '2024-02-29');

const ROWS: Cell[][] = [
  ['2024-09-30', 'West', 'Tech', 'A', 10, 1],
  ['2024-10-01', 'West', 'Tech', 'A', 20, 2],
  ['2024-12-30', 'East', 'Furn', 'B', 30, 3],
  ['2023-11-11', 'East', 'Furn', 'B', 40, 4],
];
const iso = A.specFilterSteps({ filters: [{ column: 'order_date', period: 'last_quarter' }] }, COLS, ROWS);
ok('steps: a period over plain ISO days becomes two bounds',
  JSON.stringify(iso.steps) === JSON.stringify([
    { type: 'filter', column: 'order_date', op: '>=', value: '2024-10-01' },
    { type: 'filter', column: 'order_date', op: '<=', value: '2024-12-31' },
  ]) && iso.labels[0] === 'order_date: 2024-Q4', JSON.stringify(iso));
const US = ROWS.map((r) => [String(r[0]).replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2/$3/$1'), ...r.slice(1)]);
const us = A.specFilterSteps({ filters: [{ column: 'order_date', period: 'last_quarter' }] }, COLS, US);
ok('steps: any other date text becomes an `in` list of the cells in the period',
  us.steps.length === 1 && us.steps[0].op === 'in' && JSON.stringify(us.steps[0].values) === '["10/01/2024","12/30/2024"]', JSON.stringify(us));
const none = A.specFilterSteps({ filters: [{ column: 'order_date', period: 'last_year', yearsBack: 5 }] }, COLS, US);
ok('steps: a period with no rows matches NOTHING (never "all time")',
  none.steps[0].op === 'in' && (none.steps[0].values || []).length === 1 && none.steps[0].values![0] === '\u0000');

// ── 3. Chips per spec shape ─────────────────────────────────────────────────

const base = good.ok ? good.spec : (null as never);
const labels = (chips: { label: string }[]) => chips.map((c) => c.label).join(' | ');
const cat = A.answerChips(base, { columns: COLS, splitCandidates: ['category', 'region'] });
ok('chips: category answer → split, same for last year, table',
  labels(cat) === 'Split by category | Same for last year | Show as table', labels(cat));
ok('chips: split re-runs with a series and a stacked chart', cat[0].spec.series === 'category' && cat[0].spec.chartType === 'stacked_column');
ok('chips: "last year" on an all-time answer narrows to the latest year',
  JSON.stringify(cat[1].spec.filters) === '[{"column":"order_date","period":"last_year"}]');
ok('chips: table is the same spec as a table', cat[2].spec.chartType === 'table' && cat[2].spec.category === 'region');
ok('chips: the spec they came from is untouched', base.filters.length === 0 && !base.series && base.chartType === 'column');

const period = filtered.ok ? A.answerChips(filtered.spec, { columns: COLS, splitCandidates: ['category'] }) : [];
const shifted = period.find((c) => c.label === 'Same for last year');
ok('chips: a period answer moves its period back a year, keeping the other filters',
  !!shifted && JSON.stringify(shifted.spec.filters[2]) === '{"column":"order_date","period":"last_quarter","yearsBack":1}'
  && shifted.spec.filters.length === 3);
const again = shifted ? A.answerChips(shifted.spec, { columns: COLS, splitCandidates: [] }) : [];
ok('chips: …and again, two years', JSON.stringify((again.find((c) => c.label === 'Same for last year')!.spec.filters[2] as any).yearsBack) === '2');

const split = A.answerChips({ ...base, series: 'category' }, { columns: COLS, splitCandidates: ['category'] });
ok('chips: an already-split answer offers no second split', !labels(split).includes('Split by'));
const table = A.answerChips({ ...base, chartType: 'table' }, { columns: COLS, splitCandidates: [] });
ok('chips: a table answer offers no "Show as table"', labels(table) === 'Same for last year', labels(table));
const trend = byDate.ok ? A.answerChips(byDate.spec, { columns: COLS, splitCandidates: ['region'] }) : [];
ok('chips: a date-axis answer splits into lines and has no "last year" (it IS the timeline)',
  labels(trend) === 'Split by region | Show as table' && trend[0].spec.chartType === 'line', labels(trend));
const noDates = A.answerChips(base, { columns: COLS.filter((c) => c.type !== 'date'), splitCandidates: [] });
ok('chips: no date column → no "last year"', labels(noDates) === 'Show as table');

ok('split candidates: 2–12 distinct text values, fewest first, category excluded',
  JSON.stringify(A.splitCandidates(COLS, ROWS, 'region')) === JSON.stringify(['category', 'Sub Category']));

// ── The action line ─────────────────────────────────────────────────────────

const act = sa.validateAction({ kind: 'answer', intent: 'revenue by region', spec: { category: 'region', measures: ['revenue'] } });
ok('action: "answer" survives the whitelist with its spec', act.kind === 'answer' && !!act.spec && act.spec.category === 'region');
ok('action: an answer without a spec is no action', sa.validateAction({ kind: 'answer', intent: 'x' }).kind === 'none');
ok('action: an answer whose spec is an array is no action', sa.validateAction({ kind: 'answer', intent: 'x', spec: [1] }).kind === 'none');
ok('action: a runaway spec is no action',
  sa.validateAction({ kind: 'answer', intent: 'x', spec: { category: 'a'.repeat(sa.MAX_SPEC_CHARS) } }).kind === 'none');
ok('action: a spec never rides along on another kind', !('spec' in sa.validateAction({ kind: 'chart', intent: 'x', spec: {} })));
const line = sa.splitAction('Here is revenue by region.\n@@ACTION {"kind":"answer","intent":"revenue by region","spec":{"dataset":"Retail orders","category":"region","measures":[{"column":"revenue","aggregation":"sum"}]}}');
ok('action: a marked answer line parses and never reaches the prose',
  line.action.kind === 'answer' && line.text === 'Here is revenue by region.' && (line.action.spec as any).measures.length === 1, JSON.stringify(line));
ok('action: "story" (the dashboard action\'s sibling) survives the whitelist, with no spec',
  sa.validateAction({ kind: 'story', intent: 'a regional write-up', spec: {} }).kind === 'story'
  && !('spec' in sa.validateAction({ kind: 'story', intent: 'x', spec: {} })));
ok('prompt: offers "story" as a WRITTEN piece, distinct from a dashboard', /"story" when they want a WRITTEN/.test(sa.CHAT_SYSTEM_PROMPT));
ok('prompt: offers "answer" and describes its spec', /"answer"/.test(sa.CHAT_SYSTEM_PROMPT) && /"spec":\{"dataset"/.test(sa.CHAT_SYSTEM_PROMPT)
  && /NEVER contains a computed number/.test(sa.CHAT_SYSTEM_PROMPT));

finish();
