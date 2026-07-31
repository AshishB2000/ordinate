// Self-check for src/dashboardFilters.ts (the PURE dashboard-filter merge helper)
// AND the Week 10 cross-visual invariant: ONE dashboard filter, merged in ahead of a
// card's own filters, changes the aggregated totals of BOTH a visual card
// (src/vizData.buildVizData) and a metric card (src/metricValue.computeMetric) via the
// SAME tested pure pipeline — 100% app-computed, and a leading-zero id stays a string
// (never coerced to a number). No Electron, no fs, no framework: all pure modules.

export {}; // module scope — sibling test scripts share top-level names

// ponytail: compiled siblings of the real pure modules (built by pretest).
const { mergeDashboardFilters }: typeof import('../src/dashboardFilters') = require('../src/dashboardFilters');
const { buildVizData }: typeof import('../src/vizData') = require('../src/vizData');
const { computeMetric }: typeof import('../src/metricValue') = require('../src/metricValue');
const { applyPipeline }: typeof import('../src/transforms') = require('../src/transforms');
type FilterStep = import('../src/transforms').FilterStep;
type Cell = import('../src/transforms').Cell;
type ParsedColumn = import('../src/parse').ParsedColumn;

let failures = 0;
function ok(label: string, cond: boolean) {
  if (cond) console.log('ok   ' + label);
  else { console.error('FAIL ' + label); failures++; }
}

// A tiny dataset. `code` is a leading-zero id STORED AS TEXT — it must stay a string
// throughout filtering (the strict-number rule: "007" never becomes 7).
const columns: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'month', type: 'text' },
  { name: 'sales', type: 'number' },
  { name: 'code', type: 'text' },
];
const rows: Cell[][] = [
  ['West', 'Jan', 100, '007'],
  ['West', 'Feb', 50, '008'],
  ['East', 'Jan', 200, '009'],
  ['East', 'Feb', 300, '010'],
];

// ── mergeDashboardFilters: order, dedupe, empties, filter-only ────────────────
const dashF: FilterStep[] = [{ type: 'filter', column: 'region', op: '=', value: 'West' }];
const cardF: FilterStep[] = [{ type: 'filter', column: 'sales', op: '>=', value: 60 }];

const merged = mergeDashboardFilters(dashF, cardF);
ok('merge concatenates dashboard + card filters', merged.length === 2);
ok('merge puts the DASHBOARD filter first', merged[0].column === 'region' && merged[1].column === 'sales');

const dup = mergeDashboardFilters(
  [{ type: 'filter', column: 'region', op: '=', value: 'West' }],
  [{ type: 'filter', column: 'region', op: '=', value: 'West' }],
);
ok('merge de-dupes byte-identical steps', dup.length === 1);
const nearDup = mergeDashboardFilters(
  [{ type: 'filter', column: 'region', op: '=', value: 'West' }],
  [{ type: 'filter', column: 'region', op: '=', value: 'East' }],
);
ok('merge keeps steps that differ only by value', nearDup.length === 2);

ok('merge of empty/nullish inputs is []', mergeDashboardFilters([], []).length === 0
  && mergeDashboardFilters(null, undefined).length === 0);
ok('merge with no card filters is just the dashboard filters', mergeDashboardFilters(dashF, []).length === 1);
ok('merge drops a non-filter step defensively',
  mergeDashboardFilters([{ type: 'group_aggregate' } as any], dashF).length === 1);

// ── A dashboard filter changes a VISUAL card's aggregated totals ──────────────
const encoding = { category: 'region', values: [{ column: 'sales', aggregation: 'sum' as const }] };

function seriesTotal(res: ReturnType<typeof buildVizData>): number {
  let t = 0;
  for (const s of res.data.series) for (const v of s.values) if (typeof v === 'number') t += v;
  return t;
}

// No dashboard filter, no card filter → full totals (West 150 + East 500 = 650).
const vizAll = buildVizData(columns, rows, encoding, mergeDashboardFilters(null, null));
ok('visual card total with NO filter is the full 650', seriesTotal(vizAll) === 650);

// A single dashboard filter month='Jan' drives the visual card → West 100 + East 200 = 300.
const dashJan: FilterStep[] = [{ type: 'filter', column: 'month', op: '=', value: 'Jan' }];
const vizJan = buildVizData(columns, rows, encoding, mergeDashboardFilters(dashJan, []));
ok('a dashboard filter changes the visual card aggregated total (650 → 300)', seriesTotal(vizJan) === 300);

// Dashboard filter + a card's OWN filter compose (Jan AND West) → West-Jan 100.
const cardWest: FilterStep[] = [{ type: 'filter', column: 'region', op: '=', value: 'West' }];
const vizJanWest = buildVizData(columns, rows, encoding, mergeDashboardFilters(dashJan, cardWest));
ok('dashboard + card filters compose on the visual card (→ 100)', seriesTotal(vizJanWest) === 100);

// ── The SAME dashboard filter changes a METRIC card's total ───────────────────
// Metric cards have no own filters; the dashboard filter is applied via the pipeline
// (exactly what the dashboard:metric IPC now does) before computeMetric.
function metricWith(filters: FilterStep[], column: string, aggregation: 'sum' | 'count'): number | null {
  const t = filters.length ? applyPipeline({ columns, rows }, filters) : { columns, rows };
  return computeMetric(t.columns, t.rows, { column, aggregation });
}
ok('metric card sum(sales) with NO filter is 650', metricWith(mergeDashboardFilters(null, null), 'sales', 'sum') === 650);
ok('a dashboard filter region=West changes the metric card total (650 → 150)',
  metricWith(mergeDashboardFilters([{ type: 'filter', column: 'region', op: '=', value: 'West' }], []), 'sales', 'sum') === 150);

// A dashboard filter on a column the dataset LACKS is skipped, not fatal (spans
// heterogeneous datasets) → total unchanged.
ok('a dashboard filter on a missing column is skipped, total unchanged (650)',
  metricWith(mergeDashboardFilters([{ type: 'filter', column: 'nope', op: '=', value: 'x' }], []), 'sales', 'sum') === 650);

// ── Leading-zero safety: "007" stays a string through filtering ───────────────
// Filter by the text value "007" — it must match the string cell, keep exactly one
// row, and the surviving `code` cell must still be the STRING "007" (never number 7).
const zeroFilter = mergeDashboardFilters([{ type: 'filter', column: 'code', op: '=', value: '007' }], []);
const zeroTable = applyPipeline({ columns, rows }, zeroFilter);
const codeIdx = zeroTable.columns.findIndex((c) => c.name === 'code');
ok('leading-zero filter keeps exactly the one matching row', zeroTable.rows.length === 1);
ok('leading-zero id stays the STRING "007" after filtering (not coerced to 7)',
  zeroTable.rows[0][codeIdx] === '007');
ok('the code column stays type text after a dashboard filter', zeroTable.columns[codeIdx].type === 'text');
ok('sum(sales) over the leading-zero-filtered subset is the one row (100)',
  computeMetric(zeroTable.columns, zeroTable.rows, { column: 'sales', aggregation: 'sum' }) === 100);

if (failures) { console.error('\n' + failures + ' dashboardFilters check(s) FAILED'); process.exit(1); }
console.log('\nAll dashboardFilters checks passed.');
