// What Chart.js draws for an Ordinate chart id — the id → (Chart.js type +
// option flags + the boolean traits every family block branches on) resolution,
// decided once, before any data is touched.
//
// This is the FIRST thing buildChart does and the only thing that reads the raw
// chart id string. Thirty-one ids collapse onto twelve Chart.js types plus a
// handful of flags (`gauge`, `funnel`, `histogram`, `combo`, `pct`, `stacked`,
// `fill`, `markers`, `indexAxis`), and every later block asks the RESULT — is
// this round? is it horizontal? — never the id again. Splitting the resolution
// out is what let buildChart's per-family blocks become functions: they take
// the resolved spec instead of re-deriving it from locals.
//
// `opts` is deliberately mutable and open. The dataset builders write per-family
// state back onto it (_gaugeValue, _matrixCols, _funnelVals, …) which the scales
// and the inline plugins then read; that is the one channel between them, and it
// is why the three run in that order.
//
// Loads after chartTraits/chartPalette, before chartDatasets/chartScales/
// chartRender. Depends on nothing. Classic global-scope script — NO import/export.

// The resolved shape. `opts` is `any` for the reason above: its key set grows
// per chart family at runtime and a nominal type would be a second, weaker copy
// of a contract the family blocks own.
interface ChartTypeSpec {
  chartType: string;
  opts: any;
  isRound: boolean;
  isGauge: boolean;
  isScatter: boolean;
  isBubble: boolean;
  isTreemap: boolean;
  isMatrix: boolean;
  isFunnel: boolean;
  isHistogram: boolean;
  isSankey: boolean;
  isCandlestick: boolean;
  isBoxplot: boolean;
  isLine: boolean;
  isHoriz: boolean;
  /** A PIVOT TABLE, which Chart.js never draws — see the note on the case below. */
  isPivot: boolean;
  /** The five families chartFamiliesExtra.js draws — see isExtraFamily there. */
  isWaterfall: boolean;
  isBullet: boolean;
  isCalendar: boolean;
  isRadar: boolean;
  isPareto: boolean;
  /** A word cloud, drawn by wordCloudRender.js on the same canvas — no Chart.js type. */
  isWordCloud: boolean;
  /**
   * The Analytics-pane overlays this type draws (chartAnnotations.js). Decided
   * per id below, the five #177 families included explicitly; main keeps a
   * copy (src/analysis/analytics.ts OVERLAY_ACCEPT) that scripts/test-analytics
   * checks against this one, id by id.
   */
  overlayKinds: string[];
}

// The overlay sets. ALL: a value axis and an ordered category axis. FLAT: a
// value axis but no axis a trend or a forecast could run along.
const OVERLAYS_ALL = ['reference', 'band', 'target', 'trend', 'moving_average', 'forecast', 'annotation', 'highlight'];
const OVERLAYS_FLAT = ['reference', 'band', 'target', 'annotation', 'highlight'];
const OVERLAY_KINDS_BY_TYPE: Record<string, string[]> = {
  column: OVERLAYS_ALL, clustered_column: OVERLAYS_ALL, line: OVERLAYS_ALL, line_markers: OVERLAYS_ALL,
  area: OVERLAYS_ALL, combo: OVERLAYS_ALL,
  bar: OVERLAYS_FLAT, clustered_bar: OVERLAYS_FLAT, stacked_column: OVERLAYS_FLAT, stacked_bar: OVERLAYS_FLAT,
  stacked_area: OVERLAYS_FLAT,
  pct_stacked_column: ['annotation', 'highlight'], pct_stacked_bar: ['annotation', 'highlight'],
  histogram: ['reference', 'band', 'annotation', 'highlight'],
  scatter: ['reference', 'band'], bubble: ['reference', 'band'],
  candlestick: ['reference', 'band', 'annotation'], boxplot: ['reference', 'band'],
  // #177: a waterfall's bars are deltas and a Pareto sorts itself (no trend
  // axis); a bullet draws its own target; a calendar is a matrix and a radar is
  // radial — neither has a value axis to draw a line across.
  waterfall: OVERLAYS_FLAT, pareto: OVERLAYS_FLAT,
  bullet: ['reference', 'band', 'annotation', 'highlight'],
  calendar: [], radar: [],
  word_cloud: [], // no axes: a word's place in the cloud is layout, not a value
};

function resolveChartType(type: string): ChartTypeSpec {
  let chartType: string, opts: any = {};
  switch (type) {
    case 'bar':              chartType = 'bar';  opts.indexAxis = 'y'; break;
    case 'column':           chartType = 'bar';  break;
    case 'stacked_bar':      chartType = 'bar';  opts.indexAxis = 'y'; opts.stacked = true; break;
    case 'stacked_column':   chartType = 'bar';  opts.stacked = true; break;
    case 'clustered_bar':    chartType = 'bar';  opts.indexAxis = 'y'; break;
    case 'clustered_column': chartType = 'bar';  break;
    case 'pct_stacked_bar':  chartType = 'bar';  opts.indexAxis = 'y'; opts.stacked = true; opts.pct = true; break;
    case 'pct_stacked_column': chartType = 'bar'; opts.stacked = true; opts.pct = true; break;
    case 'line':             chartType = 'line'; break;
    case 'area':             chartType = 'line'; opts.fill = true; break;
    case 'stacked_area':     chartType = 'line'; opts.fill = true; opts.stacked = true; break;
    case 'pie':              chartType = 'pie';  break;
    case 'donut':            chartType = 'doughnut'; break;
    case 'scatter':          chartType = 'scatter'; break;
    case 'gauge':            chartType = 'doughnut'; opts.gauge = true; break;
    case 'combo':            chartType = 'bar';  opts.combo = true; break;
    case 'line_markers':     chartType = 'line'; opts.markers = true; break;
    case 'bubble':           chartType = 'bubble'; break;
    case 'treemap':          chartType = 'treemap'; break;
    case 'heatmap':          chartType = 'matrix'; break;
    case 'funnel':           chartType = 'bar'; opts.funnel = true; opts.indexAxis = 'y'; opts.stacked = true; break;
    case 'histogram':        chartType = 'bar'; opts.histogram = true; break;
    case 'sankey':           chartType = 'sankey'; break;
    case 'candlestick':      chartType = 'candlestick'; break;
    case 'boxplot':          chartType = 'boxplot'; break;
    // A pivot is a <table>: renderResult dispatches it to pivotRender BEFORE
    // buildChart is reached, so no Chart.js type here is ever used. The case
    // exists so the flag is set — anything that DOES reach buildChart with a
    // pivot id (an old override, a hand-edited record) falls back to a bar
    // rather than silently becoming one under the default branch.
    case 'pivot':            chartType = 'bar'; opts.pivot = true; break;
    // Drawn as DOM by cohortRender.js; these are what buildChart makes of their
    // `{labels, series}` anywhere else (an export picture, a thumbnail): the
    // retention curve, and the per-step counts as a funnel.
    case 'cohort':           chartType = 'line'; break;
    case 'event_funnel':     chartType = 'bar'; opts.funnel = true; opts.indexAxis = 'y'; opts.stacked = true; break;
    case 'waterfall':        chartType = 'bar'; opts.waterfall = true; break;
    case 'bullet':           chartType = 'bar'; opts.bullet = true; opts.indexAxis = 'y'; break;
    case 'pareto':           chartType = 'bar'; opts.pareto = true; break;
    case 'calendar':         chartType = 'matrix'; opts.calendar = true; break;
    case 'radar':            chartType = 'radar'; break;
    case 'word_cloud':       chartType = 'word_cloud'; opts.wordCloud = true; break;
    default:                 chartType = 'bar';  break;
  }

  return {
    chartType,
    opts,
    isRound:       chartType === 'pie' || chartType === 'doughnut',
    isGauge:       opts.gauge === true,       // half-circle doughnut gauge
    isScatter:     chartType === 'scatter',
    isBubble:      chartType === 'bubble',
    isTreemap:     chartType === 'treemap',   // chartjs-chart-treemap plugin
    isMatrix:      chartType === 'matrix' && !opts.calendar, // chartjs-chart-matrix plugin (heatmap)
    isFunnel:      opts.funnel === true,      // centered stacked-bar funnel
    isHistogram:   opts.histogram === true,   // binned single-series distribution
    isSankey:      chartType === 'sankey',      // chartjs-chart-sankey plugin
    isCandlestick: chartType === 'candlestick', // chartjs-chart-financial plugin
    isBoxplot:     chartType === 'boxplot',     // chartjs-chart-boxplot plugin
    isLine:        chartType === 'line',
    isHoriz:       opts.indexAxis === 'y',  // horizontal bar/column
    isPivot:       opts.pivot === true,     // a <table>, drawn by pivotRender.js
    isWaterfall:   opts.waterfall === true, // floating bars + connectors
    isBullet:      opts.bullet === true,    // horizontal bar over qualitative bands
    isCalendar:    opts.calendar === true,  // a matrix laid out week × weekday
    isRadar:       chartType === 'radar',   // Chart.js built-in radar
    isPareto:      opts.pareto === true,    // sorted bars + cumulative % line
    isWordCloud:   opts.wordCloud === true, // wordCloudRender.js, not Chart.js
    overlayKinds:  OVERLAY_KINDS_BY_TYPE[type] || [],
  };
}
