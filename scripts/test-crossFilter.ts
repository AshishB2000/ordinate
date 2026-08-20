// Self-check for src/dashboardFilters.toggleCrossFilter — the PURE half of
// click-to-filter: given a clicked category value, what predicate does the sheet
// get? Tested here rather than only through a chart click, because a click test
// proves the WIRING and says nothing about the step it produces.
//
// No Electron, no fs, no framework — same shape as test-dashboardFilters.ts.

export {}; // module scope — sibling test scripts share top-level names

// ponytail: compiled siblings of the real pure modules (built by pretest).
const { toggleCrossFilter, mergeDashboardFilters }: typeof import('../src/dashboardFilters') =
  require('../src/dashboardFilters');
type FilterStep = import('../src/data/transforms').FilterStep;

let failures = 0;
function ok(label: string, cond: boolean, extra?: string) {
  if (cond) console.log('ok   ' + label + (extra ? '  ' + extra : ''));
  else { console.error('FAIL ' + label + (extra ? '  ' + extra : '')); failures++; }
}

const F = (column: string, value: string): FilterStep =>
  ({ type: 'filter', column, op: '=', value } as FilterStep);
const j = (v: unknown): string => JSON.stringify(v);

// ── One click, one equality predicate ───────────────────────────────────────
const one = toggleCrossFilter([], 'region', 'EMEA');
ok('a click on an empty sheet produces one equality predicate',
  j(one) === j([{ type: 'filter', column: 'region', op: '=', value: 'EMEA' }]), j(one));

// ── Toggling ────────────────────────────────────────────────────────────────
ok('clicking the same value again removes it — the second click is the undo',
  j(toggleCrossFilter(one, 'region', 'EMEA')) === j([]));

// Two `=` predicates on one column match NO rows, which reads as a broken chart
// rather than as a second filter — so a new value replaces rather than stacks.
const swapped = toggleCrossFilter(one, 'region', 'APAC');
ok('clicking a different value on the same column REPLACES, never stacks',
  swapped.length === 1 && swapped[0].value === 'APAC', j(swapped));

// ── Different columns are additive ──────────────────────────────────────────
const twoCols = toggleCrossFilter(one, 'segment', 'Retail');
ok('a different column is additive — two axes narrow together',
  twoCols.length === 2 && j(twoCols.map((s) => s.column).sort()) === j(['region', 'segment']),
  j(twoCols));

// ── Existing filters are preserved, and the input is not mutated ────────────
const pre = [F('year', '2024')];
const kept = toggleCrossFilter(pre, 'region', 'EMEA');
ok('unrelated filters survive a toggle',
  kept.length === 2 && kept.some((s) => s.column === 'year' && s.value === '2024'), j(kept));
ok('…and the caller\'s array is not mutated', j(pre) === j([F('year', '2024')]));

// ── Value normalisation ─────────────────────────────────────────────────────
// A chart label can arrive as a number; the filter value is text everywhere else
// in the pipeline, so one click and its string form must be the SAME step.
const numeric = toggleCrossFilter([], 'year', 2024 as unknown as string);
ok('a numeric label is stringified', numeric[0].value === '2024', j(numeric));
ok('…so clicking its string form toggles the same step off, not a second one',
  j(toggleCrossFilter(numeric, 'year', '2024')) === j([]));
ok('a null click becomes the empty string, never a null predicate',
  toggleCrossFilter([], 'region', null)[0].value === '');

// ── Defensive input ─────────────────────────────────────────────────────────
ok('a missing column is a no-op, not a filter on ""',
  j(toggleCrossFilter([F('year', '2024')], '', 'x')) === j([F('year', '2024')]));
ok('a non-array filter list is tolerated',
  j(toggleCrossFilter(null, 'region', 'EMEA')) === j([F('region', 'EMEA')]));
ok('non-filter steps are dropped rather than carried through',
  j(toggleCrossFilter([{ type: 'dedupe' }] as unknown as FilterStep[], 'region', 'EMEA'))
    === j([F('region', 'EMEA')]));

// ── The handoff to the merge every card already goes through ────────────────
// The step is only useful if mergeDashboardFilters keeps it, so assert the seam
// rather than assuming it.
const merged = mergeDashboardFilters(one, [F('year', '2024')]);
ok('the produced step survives the per-card merge, dashboard-first',
  merged.length === 2 && merged[0].column === 'region', j(merged));
ok('…and an identical card-level filter is de-duped, not applied twice',
  mergeDashboardFilters(one, one).length === 1);

if (failures) { console.error('\n' + failures + ' crossFilter check(s) FAILED'); process.exit(1); }
console.log('\nAll crossFilter checks passed.');
