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
}

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
    case 'waterfall':        chartType = 'bar'; opts.waterfall = true; break;
    case 'bullet':           chartType = 'bar'; opts.bullet = true; opts.indexAxis = 'y'; break;
    case 'pareto':           chartType = 'bar'; opts.pareto = true; break;
    case 'calendar':         chartType = 'matrix'; opts.calendar = true; break;
    case 'radar':            chartType = 'radar'; break;
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
  };
}
