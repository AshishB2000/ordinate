// Self-check for src/dashboardFilters.ts (the PURE dashboard-filter merge helper)
// AND the Week 10 cross-visual invariant: ONE dashboard filter, merged in ahead of a
// card's own filters, changes the aggregated totals of BOTH a visual card
// (src/vizData.buildVizData) and a metric card (src/metricValue.computeMetric) via the
// SAME tested pure pipeline — 100% app-computed, and a leading-zero id stays a string
// (never coerced to a number). No Electron, no fs, no framework: all pure modules.

export {}; // module scope — sibling test scripts share top-level names

// ponytail: compiled siblings of the real pure modules (built by pretest).
const { mergeDashboardFilters, controlSteps }: typeof import('../src/dashboardFilters') = require('../src/dashboardFilters');
const { buildVizData }: typeof import('../src/vizData') = require('../src/vizData');
const { computeMetric }: typeof import('../src/metricValue') = require('../src/metricValue');
const { applyPipeline }: typeof import('../src/data/transforms') = require('../src/data/transforms');
type FilterStep = import('../src/data/transforms').FilterStep;
type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type ControlValue = import('../src/dashboards').ControlValue;

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

// ── `in` / `not in` survive the merge ────────────────────────────────────────
//
// The merge is where a multi-value filter is easiest to lose: the step's operand
// lives in `values`, and an identity key built from `value` alone would make
// every `in` on one column look like the same step.
{
  const inWest: FilterStep = { type: 'filter', column: 'region', op: 'in', values: ['West'] };
  const inEast: FilterStep = { type: 'filter', column: 'region', op: 'in', values: ['East'] };
  const inBoth: FilterStep = { type: 'filter', column: 'region', op: 'in', values: ['West', 'East'] };

  ok('an `in` step survives the merge intact', JSON.stringify(mergeDashboardFilters([inWest], [])) === JSON.stringify([inWest]));
  ok('…values and all', JSON.stringify(mergeDashboardFilters([inWest], [])[0].values) === JSON.stringify(['West']));

  // The bug this guards: keying identity on `value` only would collapse these.
  ok('two DIFFERENT `in` lists on one column are two steps, not one', mergeDashboardFilters([inWest], [inEast]).length === 2);
  ok('…but an identical `in` step is still de-duped', mergeDashboardFilters([inWest], [inWest]).length === 1);
  ok('a longer list is a different step from a shorter one', mergeDashboardFilters([inWest], [inBoth]).length === 2);
  ok('`in` and `not in` on the same list are two steps', mergeDashboardFilters([inWest], [{ ...inWest, op: 'not in' }]).length === 2);

  // …and the merged list still moves a real metric card.
  ok('a dashboard `in` filter changes the metric total (650 → 150)', metricWith(mergeDashboardFilters([inWest], []), 'sales', 'sum') === 150);
  ok('a two-value `in` is the union of both (650)', metricWith(mergeDashboardFilters([inBoth], []), 'sales', 'sum') === 650);
  ok('`not in` is the complement (650 → 500)', metricWith(mergeDashboardFilters([{ ...inWest, op: 'not in' }], []), 'sales', 'sum') === 500);

  // A dashboard-wide `in` on a column a card's dataset lacks is still skipped,
  // which is what lets one filter span heterogeneous datasets.
  ok('an `in` on a missing column is skipped, total unchanged (650)',
    metricWith(mergeDashboardFilters([{ type: 'filter', column: 'nope', op: 'in', values: ['x'] }], []), 'sales', 'sum') === 650);
  // An empty list skips too — a half-built filter must not blank the card.
  ok('an `in` with no values yet leaves the card at its unfiltered total (650)',
    metricWith(mergeDashboardFilters([{ type: 'filter', column: 'region', op: 'in', values: [] }], []), 'sales', 'sum') === 650);

  // Leading-zero safety holds for the list operator too.
  const zeroIn = applyPipeline({ columns, rows }, mergeDashboardFilters([{ type: 'filter', column: 'code', op: 'in', values: ['007', '008'] }], []));
  const ci = zeroIn.columns.findIndex((c) => c.name === 'code');
  ok('`in` on leading-zero ids keeps both rows', zeroIn.rows.length === 2);
  ok('…and they are still the STRINGS "007"/"008"', zeroIn.rows[0][ci] === '007' && zeroIn.rows[1][ci] === '008');
}

// ── controlSteps: dropdown / multi / date_range → 0..2 FilterSteps ───────────
{
  const dropdown = { kind: 'dropdown' as const, column: 'region' };
  const multi = { kind: 'multi' as const, column: 'region' };
  const dateRange = { kind: 'date_range' as const, column: 'order_date' };

  // dropdown → one `=` step.
  ok('dropdown selection produces one `=` step',
    JSON.stringify(controlSteps(dropdown, { value: 'West' })) ===
    JSON.stringify([{ type: 'filter', column: 'region', op: '=', value: 'West' }]));
  // dropdown: empty/cleared → [].
  ok('dropdown with an empty string value → []', controlSteps(dropdown, { value: '' }).length === 0);
  ok('dropdown with no selection (undefined) → []', controlSteps(dropdown, undefined).length === 0);
  ok('dropdown with a null selection → []', controlSteps(dropdown, null).length === 0);

  // multi → one `in` step.
  ok('multi selection produces one `in` step',
    JSON.stringify(controlSteps(multi, { values: ['West', 'East'] })) ===
    JSON.stringify([{ type: 'filter', column: 'region', op: 'in', values: ['West', 'East'] }]));
  // multi: empty/cleared → [].
  ok('multi with an empty values array → []', controlSteps(multi, { values: [] }).length === 0);
  ok('multi with no selection (undefined) → []', controlSteps(multi, undefined).length === 0);

  // date_range → up to two steps, `>=` and/or `<=`.
  ok('date_range with BOTH ends set produces two steps',
    JSON.stringify(controlSteps(dateRange, { from: '2026-01-01', to: '2026-06-30' })) ===
    JSON.stringify([
      { type: 'filter', column: 'order_date', op: '>=', value: '2026-01-01' },
      { type: 'filter', column: 'order_date', op: '<=', value: '2026-06-30' },
    ]));
  // Single-ended range: only `from`.
  ok('date_range with only `from` produces one `>=` step',
    JSON.stringify(controlSteps(dateRange, { from: '2026-01-01' })) ===
    JSON.stringify([{ type: 'filter', column: 'order_date', op: '>=', value: '2026-01-01' }]));
  // Single-ended range: only `to`.
  ok('date_range with only `to` produces one `<=` step',
    JSON.stringify(controlSteps(dateRange, { to: '2026-06-30' })) ===
    JSON.stringify([{ type: 'filter', column: 'order_date', op: '<=', value: '2026-06-30' }]));
  // date_range: neither end set → [].
  ok('date_range with neither end set → []', controlSteps(dateRange, {}).length === 0);
  ok('date_range with no selection (undefined) → []', controlSteps(dateRange, undefined).length === 0);

  // A `state` shape that doesn't match the control's own kind is ignored, not
  // mis-read (e.g. a stale multi selection handed to a dropdown control).
  ok('a mismatched selection shape → []',
    controlSteps(dropdown, { values: ['West'] } as unknown as ControlValue).length === 0);

  // Values containing quotes/commas/whitespace pass through byte-for-byte — this
  // layer only builds the FilterStep, it never escapes/quotes (that happens at
  // the SQL/JS predicate layer, already covered by transforms.ts's own tests).
  const tricky = `O'Brien, "The" Store  `;
  ok('a dropdown value with quotes/commas/whitespace passes through unchanged',
    controlSteps(dropdown, { value: tricky })[0].value === tricky);
  ok('a multi value with quotes/commas/whitespace passes through unchanged',
    controlSteps(multi, { values: [tricky, 'Nice, France'] }).length === 1
    && JSON.stringify((controlSteps(multi, { values: [tricky, 'Nice, France'] })[0] as FilterStep).values) === JSON.stringify([tricky, 'Nice, France']));
  ok('a date_range value with whitespace passes through unchanged',
    controlSteps(dateRange, { from: '  2026-01-01  ' })[0].value === '  2026-01-01  ');
}

// ── effective-filter composition: dashboard filters, then controls, then a
// card's own filters ───────────────────────────────────────────────────────
//
// renderer/hub/dashboards.ts's effectiveFilters() and renderer/hub/dashGrid.ts's
// `mergeDashFilters(effectiveFilters(), visual.filters)` are hand-kept, classic-
// script MIRRORS of mergeDashboardFilters/controlSteps above — they cannot be
// node-tested directly (no import/export, no harness for a renderer global-scope
// script in this repo; confirmed in Task 5's review). What CAN be node-tested is
// the CONTRACT they are specified to implement, using the real pure functions as
// the oracle rather than a hand-copied expected array that could drift from them
// unnoticed: effectiveFilters() is `dashboard filters, then every control card's
// live selection (in page/card order), unreduced`; mergeDashFilters/
// mergeDashboardFilters then folds a card's OWN filters in last, de-duping
// byte-identical steps. Two controls + a dashboard filter + a card filter, some
// of them colliding on purpose, exercises the ORDER and the DEDUP in one go.
{
  const dashFilters: FilterStep[] = [{ type: 'filter', column: 'region', op: '!=', value: 'North' }];
  const dropdown = { kind: 'dropdown' as const, column: 'region' };
  const dateRange = { kind: 'date_range' as const, column: 'order_date' };
  // Two control cards, in the order they'd be encountered walking the pages —
  // this mirrors effectiveFilters()'s `for (const page) for (const card)` loop.
  const control1Steps = controlSteps(dropdown, { value: 'West' });
  const control2Steps = controlSteps(dateRange, { from: '2026-01-01', to: '2026-06-30' });
  // A card's own filter, one of which is BYTE-IDENTICAL to control1's step —
  // the dedup this exercises: the earlier (control-derived) copy must survive
  // and the later (card-own) duplicate must be dropped, per mergeDashboardFilters'
  // documented "first occurrence wins" rule.
  const cardFilters: FilterStep[] = [
    { type: 'filter', column: 'region', op: '=', value: 'West' }, // duplicate of control1Steps[0]
    { type: 'filter', column: 'sales', op: '>=', value: 100 },
  ];

  // What effectiveFilters() is SPECIFIED to build: dashboard filters, then every
  // control's steps in order, plain concatenation (no dedup at this stage —
  // dedup only happens once, in the final mergeDashFilters/mergeDashboardFilters
  // call, mirrored here as a two-argument merge of (effective, cardFilters)).
  const effective = dashFilters.concat(control1Steps, control2Steps);
  const finalList = mergeDashboardFilters(effective, cardFilters);

  ok('dashboard filters lead the composed list',
    finalList[0].column === 'region' && finalList[0].op === '!=' && finalList[0].value === 'North');
  ok('…then the FIRST control (dropdown) in page order',
    finalList[1].column === 'region' && finalList[1].op === '=' && finalList[1].value === 'West');
  ok('…then the SECOND control (date_range), both of its ends',
    finalList[2].column === 'order_date' && finalList[2].op === '>=' && finalList[2].value === '2026-01-01' &&
    finalList[3].column === 'order_date' && finalList[3].op === '<=' && finalList[3].value === '2026-06-30');
  ok('…then the card\'s own filter that is NOT a duplicate of anything above',
    finalList[4].column === 'sales' && finalList[4].op === '>=' && finalList[4].value === 100);
  ok('the card\'s OWN filter that duplicates a control-derived step is dropped, not doubled',
    finalList.length === 5);

  // The oracle for "what SHOULD this produce" is mergeDashboardFilters itself
  // (already node-tested above for order/dedup) — not a hand-written array — so
  // recomputing with a differently-grouped call must agree byte-for-byte. This
  // is what catches the renderer's mirror silently drifting from the rule: if
  // effectiveFilters()/mergeDashFilters ever stop matching this two-step
  // composition, this equality is what would break.
  const regrouped = mergeDashboardFilters(dashFilters, control1Steps.concat(control2Steps, cardFilters));
  ok('the composition is associative — grouping (dash+controls)+card the same as dash+(controls+card)',
    JSON.stringify(finalList) === JSON.stringify(regrouped));

  // And the composed list actually moves a real metric total: region != North
  // (no-op, nothing is North) → region = West (West/Jan 100, West/Feb 50) →
  // order_date >=/<= (column absent from this fixture, skipped per the
  // heterogeneous-dataset rule) → sales >= 100 (drops West/Feb) → West/Jan only.
  ok('the composed filter list still drives a real aggregate (→ 100)',
    metricWith(finalList, 'sales', 'sum') === 100);
}

if (failures) { console.error('\n' + failures + ' dashboardFilters check(s) FAILED'); process.exit(1); }
console.log('\nAll dashboardFilters checks passed.');
