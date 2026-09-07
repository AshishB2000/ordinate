// What Chart.js draws for an Ordinate chart id — the id → (Chart.js type +
// option flags + the boolean traits every family block branches on) resolution,
// decided once, before any data is touched.
//
// This is the FIRST thing buildChart does and the only thing that reads the raw
// chart id string. Twenty-five ids collapse onto nine Chart.js types plus a
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
    isMatrix:      chartType === 'matrix',    // chartjs-chart-matrix plugin (heatmap)
    isFunnel:      opts.funnel === true,      // centered stacked-bar funnel
    isHistogram:   opts.histogram === true,   // binned single-series distribution
    isSankey:      chartType === 'sankey',      // chartjs-chart-sankey plugin
    isCandlestick: chartType === 'candlestick', // chartjs-chart-financial plugin
    isBoxplot:     chartType === 'boxplot',     // chartjs-chart-boxplot plugin
    isLine:        chartType === 'line',
    isHoriz:       opts.indexAxis === 'y',  // horizontal bar/column
  };
}
