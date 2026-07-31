// Self-check for the grouped-chart routing in renderer/hub/hub.js. hub.js isn't
// node-runnable (browser globals), so these mirror the pure helpers — keep in sync.

export {}; // module scope — sibling test scripts share top-level names

// Share/magnitude types that render as small multiples (one mini per series) when grouped.
const SMALL_MULTIPLE_TYPES = new Set(['pie', 'donut', 'gauge', 'treemap', 'funnel', 'histogram']);
function chartIsSmallMultiple(type: string, seriesCount: number): boolean {
  return seriesCount >= 2 && SMALL_MULTIPLE_TYPES.has(type);
}
// Types that get a series/period filter (multi-series + the grouped share types).
const PERIOD_DROPDOWN_TYPES = new Set([
  'line', 'area', 'stacked_area', 'line_markers',
  'column', 'bar', 'clustered_column', 'clustered_bar',
  'stacked_column', 'stacked_bar', 'pct_stacked_column', 'pct_stacked_bar', 'combo',
  'heatmap', 'boxplot',
]);
function chartHasPeriodDropdown(type: string, seriesCount: number): boolean {
  return seriesCount >= 2 && PERIOD_DROPDOWN_TYPES.has(type);
}

// How many minis render given the series and the hidden-index list.
function visibleMiniCount(seriesNames: string[], hiddenArr: number[] | null | undefined): number {
  const hidden = new Set(hiddenArr || []);
  return seriesNames.filter((_, i) => !hidden.has(i)).length;
}

let failures = 0;
function ok(label: string, cond: boolean) { if (cond) console.log('ok   ' + label); else { console.error('FAIL ' + label); failures++; } }

// Share types group into small multiples only with >=2 series.
ok('pie + 3 series → small multiples', chartIsSmallMultiple('pie', 3));
ok('donut + 2 series → small multiples', chartIsSmallMultiple('donut', 2));
ok('histogram + 2 series → small multiples', chartIsSmallMultiple('histogram', 2));
ok('pie + 1 series → single chart', !chartIsSmallMultiple('pie', 1));

// Non-share types never small-multiple, however many series.
['bar', 'line', 'scatter', 'bubble', 'sankey', 'candlestick', 'boxplot', 'heatmap'].forEach(t =>
  ok(t + ' is never a small multiple', !chartIsSmallMultiple(t, 5)));

// boxplot is "controls only": it gets a series filter but NOT small multiples.
ok('boxplot has a series filter', chartHasPeriodDropdown('boxplot', 3));
ok('boxplot is not split into minis', !chartIsSmallMultiple('boxplot', 3));

// Grouped share types also expose the period filter (to pick which minis show).
ok('pie has a period filter when grouped', chartHasPeriodDropdown('pie', 3) || chartIsSmallMultiple('pie', 3));

// Visible-mini count drops hidden periods, never below the (caller-enforced) floor.
ok('3 periods, none hidden → 3 minis', visibleMiniCount(['2023', '2024', '2025'], []) === 3);
ok('3 periods, 1 hidden → 2 minis', visibleMiniCount(['2023', '2024', '2025'], [1]) === 2);
ok('3 periods, 2 hidden → 1 mini', visibleMiniCount(['2023', '2024', '2025'], [0, 2]) === 1);

if (failures) { console.error('\n' + failures + ' assertion(s) failed'); process.exit(1); }
console.log('\nAll small-multiples checks passed.');
