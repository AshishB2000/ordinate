// Self-check for click-to-filter's PURE half (src/analysis/dashboardFilters.ts):
// given a clicked mark, what does the sheet's selection become, and which filter
// steps does each card get? Tested here rather than only through a chart click,
// because a click test proves the WIRING and says nothing about the steps.
//
//   toggleClickFilter   plain click, ⌘/Ctrl-click, a series chart, take-over
//   clickFilterSteps    `=` / `in`, and the origin card's exemption
//   clickFilterOn       the sheet's switch against the visual's own setting
//   sanitizePage        the switch survives the whitelist; absent stays absent
//
// The web mirror (web/src/features/analyses/editor/filters.ts) is held to these
// same functions by filters.test.ts. No fs, no framework.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

// ponytail: compiled siblings of the real pure modules (built by pretest).
const { toggleClickFilter, clickFilterSteps, clickFilterOn, mergeDashboardFilters }: typeof import('../src/analysis/dashboardFilters') =
  require('../src/analysis/dashboardFilters');
const { sanitizePage }: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');
type FilterStep = import('../src/data/transforms').FilterStep;
type ClickFilter = import('../src/analysis/dashboardFilters').ClickFilter;

const F = (column: string, value: string): FilterStep =>
  ({ type: 'filter', column, op: '=', value } as FilterStep);
const j = (v: unknown): string => JSON.stringify(v);
const A = 'card-a';
const B = 'card-b';
const region = (value: unknown) => ({ column: 'region', value });

// ── One click, one value ────────────────────────────────────────────────────
const one = toggleClickFilter([], A, region('EMEA'));
ok('a click on an untouched sheet selects that one value, attributed to its card',
  j(one) === j([{ origin: A, column: 'region', values: ['EMEA'] }]), j(one));
ok('…which is one equality predicate',
  j(clickFilterSteps(one)) === j([F('region', 'EMEA')]), j(clickFilterSteps(one)));

// ── Plain click: toggle and replace ─────────────────────────────────────────
ok('clicking the only selected value again clears it — the second click is the undo',
  j(toggleClickFilter(one, A, region('EMEA'))) === j([]));
const swapped = toggleClickFilter(one, A, region('APAC'));
ok('a plain click on a different value REPLACES, never stacks',
  j(swapped) === j([{ origin: A, column: 'region', values: ['APAC'] }]), j(swapped));

// ── Multi-select (⌘/Ctrl-click) ─────────────────────────────────────────────
const two = toggleClickFilter(one, A, region('APAC'), true);
ok('an additive click adds a value, in click order',
  j(two) === j([{ origin: A, column: 'region', values: ['EMEA', 'APAC'] }]), j(two));
ok('…and several values are ONE `in` step, not two `=` that match nothing',
  j(clickFilterSteps(two)) === j([{ type: 'filter', column: 'region', op: 'in', values: ['EMEA', 'APAC'] }]), j(clickFilterSteps(two)));
ok('an additive click on a selected value takes just that one away',
  j(toggleClickFilter(two, A, region('EMEA'), true)) === j([{ origin: A, column: 'region', values: ['APAC'] }]));
ok('…and on the last one clears the filter',
  j(toggleClickFilter(one, A, region('EMEA'), true)) === j([]));
ok('a plain click inside a multi-selection narrows to that one value (it is not the only one, so it does not clear)',
  j(toggleClickFilter(two, A, region('EMEA'))) === j([{ origin: A, column: 'region', values: ['EMEA'] }]));
// Negative control: the additive flag is what stacks — the same click without it replaces.
ok('negative control: without the modifier the second value replaces the first',
  j(toggleClickFilter(one, A, region('APAC'))) !== j(two));

// ── A series chart: category and series together ────────────────────────────
const cell = (value: string, series: string) => ({ column: 'region', value, seriesColumn: 'segment', series });
const pair = toggleClickFilter([], A, cell('EMEA', 'Retail'));
ok('a click on a stacked segment selects its category AND its series',
  j(pair) === j([{ origin: A, column: 'region', values: ['EMEA'] }, { origin: A, column: 'segment', values: ['Retail'] }]), j(pair));
ok('…as two predicates the other cards get together',
  j(clickFilterSteps(pair)) === j([F('region', 'EMEA'), F('segment', 'Retail')]));
ok('the same segment again clears both',
  j(toggleClickFilter(pair, A, cell('EMEA', 'Retail'))) === j([]));
ok('another segment of the same bar replaces the series, keeps the category',
  j(clickFilterSteps(toggleClickFilter(pair, A, cell('EMEA', 'Online')))) === j([F('region', 'EMEA'), F('segment', 'Online')]));
const grown = toggleClickFilter(pair, A, cell('APAC', 'Retail'), true);
ok('an additive click on another bar of the same series adds the category only',
  j(grown) === j([{ origin: A, column: 'region', values: ['EMEA', 'APAC'] }, { origin: A, column: 'segment', values: ['Retail'] }]), j(grown));
ok('…and an additive click on a selected segment takes its category away, the series stays',
  j(toggleClickFilter(grown, A, cell('EMEA', 'Retail'), true)) === j([{ origin: A, column: 'region', values: ['APAC'] }, { origin: A, column: 'segment', values: ['Retail'] }]));
ok('a series that is the category column itself is not filtered twice',
  j(toggleClickFilter([], A, { column: 'region', value: 'EMEA', seriesColumn: 'region', series: 'EMEA' })) === j(one));
ok('a mark with no series value (several measures, not a split) filters the category alone',
  j(toggleClickFilter([], A, { column: 'region', value: 'EMEA', seriesColumn: 'segment' })) === j(one));

// ── Origin and exemption ────────────────────────────────────────────────────
const both = toggleClickFilter(one, B, { column: 'segment', value: 'Retail' });
ok('a different card on a different column is additive — two axes narrow together',
  j(clickFilterSteps(both)) === j([F('region', 'EMEA'), F('segment', 'Retail')]), j(both));
ok('the clicked card is exempt from its OWN filter, and still gets the others',
  j(clickFilterSteps(both, A)) === j([F('segment', 'Retail')]) && j(clickFilterSteps(both, B)) === j([F('region', 'EMEA')]));
ok('a series chart is exempt from both of its predicates',
  j(clickFilterSteps(pair, A)) === j([]));
// Negative control: the exemption is by origin — a card that clicked nothing keeps every step.
ok('negative control: any other card is exempt from nothing',
  j(clickFilterSteps(both, 'card-c')) === j(clickFilterSteps(both)) && clickFilterSteps(both, 'card-c').length === 2);
const taken = toggleClickFilter(one, B, region('APAC'));
ok('a click on a column another card selected TAKES IT OVER — one column, one click-filter',
  j(taken) === j([{ origin: B, column: 'region', values: ['APAC'] }]), j(taken));

// ── The caller's state is not mutated ───────────────────────────────────────
const frozen: ClickFilter[] = [{ origin: A, column: 'region', values: ['EMEA'] }];
toggleClickFilter(frozen, A, region('APAC'), true);
const stepsOut = clickFilterSteps(two);
(stepsOut[0].values as string[]).push('x');
ok('the input list and its value arrays are left alone',
  j(frozen) === j([{ origin: A, column: 'region', values: ['EMEA'] }]) && two[0].values.length === 2);

// ── Value normalisation ─────────────────────────────────────────────────────
// A chart label can arrive as a number; the filter value is text everywhere else
// in the pipeline, so one click and its string form must be the SAME value.
const numeric = toggleClickFilter([], A, { column: 'year', value: 2024 });
ok('a numeric label is stringified', numeric[0].values[0] === '2024', j(numeric));
ok('…so clicking its string form toggles the same value off, not a second one',
  j(toggleClickFilter(numeric, A, { column: 'year', value: '2024' })) === j([]));
ok('a null click becomes the empty string, never a null predicate',
  toggleClickFilter([], A, region(null))[0].values[0] === '');

// ── Defensive input ─────────────────────────────────────────────────────────
ok('a missing column is a no-op, not a filter on ""',
  j(toggleClickFilter(one, A, { column: '', value: 'x' })) === j(one));
ok('a missing origin is a no-op — a filter nobody can be exempted from is never made',
  j(toggleClickFilter(one, '', region('APAC'))) === j(one));
ok('a non-array selection is tolerated',
  j(toggleClickFilter(null, A, region('EMEA'))) === j(one) && j(clickFilterSteps(undefined)) === j([]));
ok('an entry with no values is dropped rather than turned into a filter',
  j(clickFilterSteps([{ origin: A, column: 'region', values: [] }])) === j([]));

// ── The handoff to the merge every card already goes through ────────────────
const merged = mergeDashboardFilters([F('year', '2024')], clickFilterSteps(two));
ok('the produced steps survive the per-card merge, after the dashboard\'s own',
  merged.length === 2 && merged[0].column === 'year' && merged[1].op === 'in', j(merged));
ok('…and a click identical to an author\'s filter is de-duped, not applied twice',
  mergeDashboardFilters([F('region', 'EMEA')], clickFilterSteps(one)).length === 1);

// ── The switch: sheet-wide, with the visual's own setting as the opt-out ────
ok('sheet on: every visual filters unless it opted out',
  clickFilterOn(true, undefined) && clickFilterOn(true, true) && !clickFilterOn(true, false));
ok('sheet absent (saved before the switch): only a visual that opted in — as before',
  !clickFilterOn(undefined, undefined) && clickFilterOn(undefined, true) && !clickFilterOn(undefined, false));
ok('sheet off behaves as absent', !clickFilterOn(false, undefined) && clickFilterOn(false, true));
ok('negative control: a truthy non-boolean is not "on"', !clickFilterOn('true', undefined) && !clickFilterOn(1, undefined));

const sheet = { id: '3f2b8c1e-9d4a-4c7b-8e21-5a6f7b8c9d0e', name: 'S', cards: [] };
ok('sanitizePage keeps the switch as written, on or off',
  sanitizePage({ ...sheet, clickFilter: true }).clickFilter === true && sanitizePage({ ...sheet, clickFilter: false }).clickFilter === false);
ok('an absent switch stays ABSENT — no existing sheet turns it on by being re-saved',
  !('clickFilter' in sanitizePage(sheet)));
ok('negative control: a non-boolean is not kept', !('clickFilter' in sanitizePage({ ...sheet, clickFilter: 'yes' })));

if (failureCount()) { console.error('\n' + failureCount() + ' crossFilter check(s) FAILED'); process.exit(1); }
console.log('\nAll crossFilter checks passed.');
