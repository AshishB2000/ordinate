// Chart-type traits — what a chart id IS, decided by lookup, not by branching.
//
// These sets are FACTS ABOUT CHART IDS: which ids can be period-filtered, which
// have to become small multiples when the data is grouped, which draw one
// Chart.js dataset per series, which print their own values, which get a legend.
// Nothing here touches Chart.js, a canvas or a dataset — it is a vocabulary, and
// it is read by four different files (chartRender, chartControls, renderResult,
// and through them the export paths).
//
// WHY ITS OWN FILE, not folded into renderResult.ts (which already owns chart ids
// via VIZ_LABELS = 29, and was the other candidate):
//
//   1. renderResult.ts is 634 lines — already past the 500-line smell line in
//      .claude/rules/file-size.md. Moving 47 lines INTO it to get chartRender
//      under the cap trades one oversized file for two, which is the opposite of
//      what this split is for.
//   2. It would invent a dependency. chartControls.ts reads four of these sets
//      and otherwise has no reason to know renderResult exists; a leaf file with
//      no dependencies of its own can be read by anyone without dragging the
//      render dispatcher in behind it.
//   3. One file = one job. renderResult.ts's job is DISPATCHING a render — pick
//      the surface, pick the renderer, draw. These are static facts consulted
//      during that dispatch. Different jobs.
//
// Loads FIRST of the chart scripts (see index.html): it depends on nothing, and
// everything else here depends on it. Classic global-scope script — NO
// import/export.
//
// `ChartSeriesShape` below is declared in chartRender.ts. That is a compile-time
// reference only: interfaces and type aliases emit no JavaScript, so it creates
// no runtime dependency and no load-order constraint. The shapes stay with the
// file that defines the pipeline they describe.

// Chart types whose series can be filtered by the period dropdown. The bar/line
// families draw one dataset per series; heatmap maps each series to a column and
// filters them by rebuilding its cells.
const PERIOD_DROPDOWN_TYPES = new Set([
  'line', 'area', 'stacked_area', 'line_markers',
  'column', 'bar', 'clustered_column', 'clustered_bar',
  'stacked_column', 'stacked_bar', 'pct_stacked_column', 'pct_stacked_bar', 'combo',
  'heatmap', 'boxplot',
]);
function chartHasPeriodDropdown(type: string, seriesCount: number): boolean {
  return seriesCount >= 2 && PERIOD_DROPDOWN_TYPES.has(type);
}

// Share/magnitude types that can't stack several series into one chart. When the
// data is grouped (>=2 series) we render a small-multiples grid — one mini chart
// per period (series) — instead of silently dropping all but series[0]. The
// Periods dropdown filters which minis show; Values/Customize apply to all.
const SMALL_MULTIPLE_TYPES = new Set(['pie', 'donut', 'gauge', 'treemap', 'funnel', 'histogram']);
function chartIsSmallMultiple(type: string, seriesCount: number): boolean {
  return seriesCount >= 2 && SMALL_MULTIPLE_TYPES.has(type);
}

// Chart types that draw one Chart.js dataset per series, so the period filter can
// hide them live via setDatasetVisibility. Others (heatmap) rebuild instead.
const PER_SERIES_DATASET_TYPES = new Set([
  'line', 'area', 'stacked_area', 'line_markers',
  'column', 'bar', 'clustered_column', 'clustered_bar',
  'stacked_column', 'stacked_bar', 'pct_stacked_column', 'pct_stacked_bar', 'combo',
]);

// Types whose renderers don't draw value labels (gauge prints its own center value;
// treemap/funnel already print values in place).
const NO_VALUE_LABEL_TYPES = new Set([
  'treemap', 'funnel', 'sankey', 'candlestick', 'boxplot', 'gauge',
]);

// Legend on by default for every chart except plugin/synthetic types whose Chart.js
// legend would be a single meaningless entry. A single-series chart only gets one if
// the series is named (otherwise the legend swatch would be blank).
const NO_LEGEND_TYPES = new Set([
  'gauge', 'bubble', 'treemap', 'heatmap', 'funnel', 'histogram',
  'sankey', 'candlestick', 'boxplot',
]);
function legendOnByDefault(type: string, ser: ChartSeriesShape[]): boolean {
  if (NO_LEGEND_TYPES.has(type)) return false;
  if (type === 'pie' || type === 'donut') return true;
  return (ser || []).length > 1 || (ser || []).some((s: ChartSeriesShape) => s && !!s.name);
}
