// Chart rendering — the Chart.js engine (buildChart + its inline value-label
// plugins), the series/legend/value-label helpers, the palette-derivation
// color helpers, and the data-table builder. Extracted from hub.js as a pure
// structural move (no logic changes). Classic script sharing global scope:
// the Chart.js UMD globals load earlier; hub.js's _fmtVal/histogramBins resolve
// at call time; the chartInstances/mapInstances WeakMaps are defined here and
// used cross-file by mapRender.js and hub.js.

// ── Chart rendering ────────────────────────────────────────────────────────
const CHART_PALETTE = ['#2563eb', '#0e7490', '#14b8a6', '#6366f1', '#64748b'];

// Treemap/matrix/sankey/financial UMD bundles self-register with the global Chart;
// the boxplot plugin does not, so register it here (no-op if already registered).
if (window.Chart && window.ChartBoxPlot && window.ChartBoxPlot.BoxPlotController) {
  try { window.Chart.register(window.ChartBoxPlot.BoxPlotController, window.ChartBoxPlot.BoxAndWiskers); } catch (_) {}
}

// WeakMap tracks Chart.js instances per viz-area div for destruction on re-render.
const chartInstances = new WeakMap();
// WeakMap tracks MapLibre GL map instances for clean destruction on switch. This one
// matters more than chartInstances: a leaked map holds a live WebGL context, and a
// browser only grants a handful before it starts dropping the oldest.
const mapInstances = new WeakMap();

// The plottable series for a chart: those with a non-empty values array.
// buildChart and the period dropdown share this so hidden-series indices align.
function chartSeries(data) {
  return Array.isArray(data && data.series)
    ? data.series.filter(s => Array.isArray(s.values) && s.values.length > 0)
    : [];
}

// Chart types whose series can be filtered by the period dropdown. The bar/line
// families draw one dataset per series; heatmap maps each series to a column and
// filters them by rebuilding its cells.
const PERIOD_DROPDOWN_TYPES = new Set([
  'line', 'area', 'stacked_area', 'line_markers',
  'column', 'bar', 'clustered_column', 'clustered_bar',
  'stacked_column', 'stacked_bar', 'pct_stacked_column', 'pct_stacked_bar', 'combo',
  'heatmap', 'boxplot',
]);
function chartHasPeriodDropdown(type, seriesCount) {
  return seriesCount >= 2 && PERIOD_DROPDOWN_TYPES.has(type);
}

// Share/magnitude types that can't stack several series into one chart. When the
// data is grouped (>=2 series) we render a small-multiples grid — one mini chart
// per period (series) — instead of silently dropping all but series[0]. The
// Periods dropdown filters which minis show; Values/Customize apply to all.
const SMALL_MULTIPLE_TYPES = new Set(['pie', 'donut', 'gauge', 'treemap', 'funnel', 'histogram']);
function chartIsSmallMultiple(type, seriesCount) {
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
function legendOnByDefault(type, ser) {
  if (NO_LEGEND_TYPES.has(type)) return false;
  if (type === 'pie' || type === 'donut') return true;
  return (ser || []).length > 1 || (ser || []).some(s => s && s.name);
}

// Which data points the Values menu labels, given a mode and the 2-D value grid
// (`values[seriesIdx][catIdx]`; hidden series passed as all-null so they can't win).
// Returns a Set of "seriesIdx:catIdx" keys.
//   all    → every non-null cell
//   single series → the one global max / min over categories
//   multi series  → per category column, the max series (and/or min series)  [per-group]
//   maxmin → union of max and min
function valueLabelKeys(mode, values) {
  const keys = new Set();
  if (!mode || mode === 'off' || !Array.isArray(values) || !values.length) return keys;
  const S = values.length;
  const C = Math.max(0, ...values.map(r => (Array.isArray(r) ? r.length : 0)));
  const num = (s, c) => { const v = values[s] && values[s][c]; return typeof v === 'number' ? v : null; };
  const add = (s, c) => keys.add(s + ':' + c);
  if (mode === 'all') {
    for (let s = 0; s < S; s++) for (let c = 0; c < C; c++) if (num(s, c) != null) add(s, c);
    return keys;
  }
  const wantMax = mode === 'max' || mode === 'maxmin';
  const wantMin = mode === 'min' || mode === 'maxmin';
  // One max and one min per series — each line/bar's own peak and trough across
  // categories (so N series → up to N maxes + N mins).
  for (let s = 0; s < S; s++) {
    let maxC = -1, minC = -1, maxV = -Infinity, minV = Infinity;
    for (let c = 0; c < C; c++) {
      const v = num(s, c); if (v == null) continue;
      if (v > maxV) { maxV = v; maxC = c; }
      if (v < minV) { minV = v; minC = c; }
    }
    if (wantMax && maxC >= 0) add(s, maxC);
    if (wantMin && minC >= 0) add(s, minC);
  }
  return keys;
}

function getCSSVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ── Color helpers (for deriving a full palette from one chosen swatch) ──────
function hexToHsl(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  let r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  const d = max - min;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s, l };
}
function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}
// A harmonious n-color palette seeded from one hex: index 0 is the exact seed,
// the rest rotate hue ±32°, ±64°, … around it (same S/L) so series stay distinct
// yet clearly related to the chosen color. Falls back to [seed] if hex is unparseable.
function paletteFromSeed(hex, n) {
  const base = hexToHsl(hex);
  if (!base) return Array.from({ length: n }, () => hex);
  const seed = '#' + /^#?([0-9a-f]{6})$/i.exec(hex)[1].toLowerCase();   // canonical seed
  const s = Math.max(0.35, Math.min(0.85, base.s));   // keep colors lively, not washed/neon
  const l = Math.max(0.42, Math.min(0.62, base.l));
  const offsets = [0, 32, -32, 64, -64, 96, -96, 128, -128];
  return Array.from({ length: n }, (_, i) => {
    if (i === 0) return seed;                          // series 1 = the exact chosen color
    return hslToHex(base.h + (offsets[i] || (i * 40)), s, l);
  });
}

// Expand a small base palette to n DISTINCT colors by interpolating through the
// base colors (a gradient walk). Keeps the app's restrained color family — no
// rainbow — while giving per-category charts (pie/donut/treemap/funnel) a unique
// color per slice, so the legend genuinely maps one color to one category.
function interpolatePalette(base, n) {
  if (n <= base.length) return base.slice(0, n);
  const parse = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const hex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (base.length - 1);
    const lo = Math.floor(t), hi = Math.min(base.length - 1, lo + 1), f = t - lo;
    const [r1, g1, b1] = parse(base[lo]);
    const [r2, g2, b2] = parse(base[hi]);
    out.push('#' + hex(r1 + f * (r2 - r1)) + hex(g1 + f * (g2 - g1)) + hex(b1 + f * (b2 - b1)));
  }
  return out;
}

function buildDataTable(table, data) {
  const labels = Array.isArray(data.labels) ? data.labels : [];
  const series = Array.isArray(data.series) ? data.series : [];
  table.innerHTML = '';
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const thLabel = document.createElement('th');
  thLabel.textContent = 'Label';
  headerRow.appendChild(thLabel);
  series.forEach((s, si) => {
    const th = document.createElement('th');
    const sw = document.createElement('span');
    sw.className = 'cv-swatch';
    sw.style.background = CHART_PALETTE[si % CHART_PALETTE.length];
    th.appendChild(sw);
    th.append(s.name || '');
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  labels.forEach((label, i) => {
    const row = document.createElement('tr');
    const tdLabel = document.createElement('td');
    tdLabel.textContent = label;
    row.appendChild(tdLabel);
    series.forEach(s => {
      const td = document.createElement('td');
      td.textContent = (s.values && s.values[i] != null) ? s.values[i] : '';
      row.appendChild(td);
    });
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
}

// Build a Chart.js instance for the given data + type id. Returns instance or null.
// overrides: optional per-chart customization { title, color, valueMode, hiddenSeries,
//            showLegend, showGridlines, xAxisLabel, yAxisLabel }
//            (legacy showValues:true is still read as valueMode 'all')
function buildChart(canvas, data, type, overrides) {
  overrides = overrides || {};
  let labels = Array.isArray(data.labels) ? data.labels : [];
  let series = chartSeries(data);
  if (!labels.length || !series.length || !canvas) return null;

  // Number formatter for display (axis ticks, value labels, tooltips). When the
  // `numberFormat` override is absent, fmt === _fmtVal, so output is byte-identical
  // to before this control existed (the capture flow never sets numberFormat).
  const fmt = overrides.numberFormat ? (v) => fmtWith(v, overrides.numberFormat) : _fmtVal;

  // Values menu mode: off | all | max | min | maxmin. Back-compat: legacy showValues:true ⇒ all.
  const valueMode = overrides.valueMode || (overrides.showValues ? 'all' : 'maxmin');
  // Line smoothing: curved (default) vs straight segments.
  const lineTension = overrides.smooth === false ? 0 : 0.35;

  // ── Theme tokens ────────────────────────────────────────────────────────
  const palette = [
    getCSSVar('--chart-1') || CHART_PALETTE[0],
    getCSSVar('--chart-2') || CHART_PALETTE[1],
    getCSSVar('--chart-3') || CHART_PALETTE[2],
    getCSSVar('--chart-4') || CHART_PALETTE[3],
    getCSSVar('--chart-5') || CHART_PALETTE[4],
  ];
  // Color override seeds a harmonious palette: every series (and pie/donut slice,
  // which uses palette[i % len]) recolors to a distinct hue derived from the pick,
  // with series 1 = the exact chosen color. Single-series → just the chosen color.
  if (overrides.color) {
    const seeded = paletteFromSeed(overrides.color, palette.length);
    for (let i = 0; i < palette.length; i++) palette[i] = seeded[i];
  }
  const textColor  = getCSSVar('--muted');
  const gridColor  = getCSSVar('--border');
  const surfColor  = getCSSVar('--surface');
  const titleColor = getCSSVar('--text-strong');
  const fontFamily = getCSSVar('--font-ui') || 'system-ui, sans-serif';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animDuration = reduceMotion ? 0 : 480;

  // ── Chart type resolution ───────────────────────────────────────────────
  let chartType, opts: any = {};
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

  const isRound       = chartType === 'pie' || chartType === 'doughnut';
  const isGauge       = opts.gauge === true;       // half-circle doughnut gauge
  const isScatter     = chartType === 'scatter';
  const isBubble      = chartType === 'bubble';
  const isTreemap     = chartType === 'treemap';   // chartjs-chart-treemap plugin
  const isMatrix      = chartType === 'matrix';    // chartjs-chart-matrix plugin (heatmap)
  const isFunnel      = opts.funnel === true;      // centered stacked-bar funnel
  const isHistogram   = opts.histogram === true;   // binned single-series distribution
  const isSankey      = chartType === 'sankey';      // chartjs-chart-sankey plugin
  const isCandlestick = chartType === 'candlestick'; // chartjs-chart-financial plugin
  const isBoxplot     = chartType === 'boxplot';     // chartjs-chart-boxplot plugin
  const isLine        = chartType === 'line';
  const isHoriz    = opts.indexAxis === 'y';  // horizontal bar/column

  // ── Sort by value (bar/column families + pie/donut) ───────────────────────
  // Reorders categories by their total across series; line/area/funnel/histogram
  // keep their natural order (sorting would scramble a time axis / fixed sequence).
  const canSort = (chartType === 'bar' && !isFunnel && !isHistogram) || isRound;
  if (canSort && (overrides.sort === 'asc' || overrides.sort === 'desc')) {
    const totals = labels.map((_, i) =>
      series.reduce((sum, s) => sum + (typeof s.values[i] === 'number' ? s.values[i] : 0), 0));
    const order = labels.map((_, i) => i)
      .sort((a, b) => overrides.sort === 'asc' ? totals[a] - totals[b] : totals[b] - totals[a]);
    labels = order.map(i => labels[i]);
    series = series.map(s => Object.assign({}, s, { values: order.map(i => s.values[i]) }));
  }

  // ── Gradient helpers ────────────────────────────────────────────────────
  // Bar: gradient along the bar's length, darkest at the value end.
  function makeBarGradient(color) {
    return (ctx) => {
      const chart = ctx.chart;
      const { ctx: cx, chartArea } = chart;
      if (!chartArea) return color + 'e0';
      let g;
      if (isHoriz) {
        // horizontal bars: subtle fade on left (base), full on right (value end)
        g = cx.createLinearGradient(chartArea.left, 0, chartArea.right, 0);
        g.addColorStop(0, color + 'b0');
        g.addColorStop(1, color + 'f2');
      } else {
        // vertical bars: full on top (value end), subtle fade at base
        g = cx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
        g.addColorStop(0, color + 'f2');
        g.addColorStop(1, color + 'b0');
      }
      return g;
    };
  }

  // Area fill: opaque near the line, transparent at the bottom.
  function makeAreaGradient(color) {
    return (ctx) => {
      const chart = ctx.chart;
      const { ctx: cx, chartArea } = chart;
      if (!chartArea) return color + '28';
      const g = cx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
      g.addColorStop(0, color + '50');
      g.addColorStop(1, color + '00');
      return g;
    };
  }

  // ── Datasets ────────────────────────────────────────────────────────────
  let datasets;
  let chartLabels = labels;
  if (isGauge) {
    // Half-circle gauge: the first numeric value drawn against a sensible max,
    // as a 2-slice doughnut (filled arc + faint track). Single_metric finally
    // gets a visual. Degrades to value-vs-1 / value-vs-niceCeil when no total.
    const niceCeil = (v) => {
      if (!(v > 0)) return 1;
      const mag = Math.pow(10, Math.floor(Math.log10(v)));
      const n = v / mag;
      const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
      return step * mag;
    };
    const gv = series[0].values.find(v => typeof v === 'number');
    const value = gv == null ? 0 : gv;
    const gmax = (value >= 0 && value <= 1) ? 1 : niceCeil(Math.abs(value));
    const filled = Math.max(0, Math.min(value, gmax));
    datasets = [{
      data: [filled, Math.max(gmax - filled, 0)],
      backgroundColor: [palette[0], gridColor],
      borderColor: surfColor,
      borderWidth: 0,
      hoverOffset: 0,
    }];
    chartLabels = [series[0].name || 'Value', ''];
    opts._gaugeValue = value;   // for the center-label plugin
    opts._gaugeLabel = series[0].name || (labels && labels[0]) || '';   // metric name
  } else if (isTreemap) {
    // Flat treemap of the first series: rectangle area ∝ value, labelled inside.
    const tree = labels.map((lab, i) => ({
      _label: lab,
      value: typeof series[0].values[i] === 'number' ? Math.abs(series[0].values[i]) : 0,
    }));
    const treePalette = interpolatePalette(palette, tree.length);
    datasets = [{
      tree,
      key: 'value',
      borderWidth: 1,
      borderColor: surfColor,
      spacing: 1,
      backgroundColor: (ctx) => ctx.type === 'data' ? treePalette[ctx.dataIndex % treePalette.length] : 'transparent',
      labels: {
        display: true,
        color: '#ffffff',
        font: { family: fontFamily, size: 11, weight: '600' },
        formatter: (ctx) => {
          const d = ctx.raw && ctx.raw._data;
          return d ? [String(d._label), fmt(d.value)] : '';
        },
      },
    }];
  } else if (isMatrix) {
    // Heatmap: rows = labels, cols = series; cell color = value intensity (accent alpha).
    // Period dropdown filters columns by dropping hidden series before building cells.
    const hiddenSet = new Set(Array.isArray(overrides.hiddenSeries) ? overrides.hiddenSeries : []);
    const visSeries = series.filter((_, j) => !hiddenSet.has(j));
    const useSeries = visSeries.length ? visSeries : series;   // never empty
    const cols = useSeries.map(s => s.name || '');
    let vmin = Infinity, vmax = -Infinity;
    useSeries.forEach(s => s.values.forEach(v => { if (typeof v === 'number') { if (v < vmin) vmin = v; if (v > vmax) vmax = v; } }));
    if (!isFinite(vmin)) { vmin = 0; vmax = 1; }
    const span = (vmax - vmin) || 1;
    const accent = getCSSVar('--accent') || palette[0];
    const alphaHex = (f) => Math.round(Math.max(0, Math.min(1, f)) * 255).toString(16).padStart(2, '0');
    const heat = (v) => (typeof v === 'number') ? accent + alphaHex(0.15 + 0.85 * ((v - vmin) / span)) : gridColor;
    const cells = [];
    useSeries.forEach((s, j) => labels.forEach((lab, i) => cells.push({ x: cols[j], y: lab, v: s.values[i] })));
    datasets = [{
      data: cells,
      backgroundColor: (ctx) => heat(ctx.raw && ctx.raw.v),
      borderColor: surfColor,
      borderWidth: 1,
      width: (ctx) => { const a = ctx.chart.chartArea; return a ? a.width / cols.length - 2 : 20; },
      height: (ctx) => { const a = ctx.chart.chartArea; return a ? a.height / labels.length - 2 : 20; },
    }];
    opts._matrixCols = cols;
    opts._matrixRows = labels;
    opts._matrixGrid = useSeries.map(s => s.values);   // [colIdx][rowIdx] for value labels
    opts._matrixVmin = vmin;
    opts._matrixVmax = vmax;
  } else if (isRound) {
    datasets = [{
      data: series[0].values,
      backgroundColor: interpolatePalette(palette, labels.length),
      borderColor: surfColor,
      borderWidth: 3,
      hoverOffset: 6,
    }];
  } else if (isScatter) {
    if (series.length >= 2) {
      const xVals = series[0].values, yVals = series[1].values;
      datasets = [{
        label: series[0].name + ' vs ' + series[1].name,
        data: xVals.map((x, i) => ({ x, y: yVals[i] || 0 })),
        backgroundColor: palette[0] + 'cc', borderColor: palette[0], pointRadius: 5,
      }];
    } else {
      datasets = [{
        label: series[0].name || '',
        data: series[0].values.map((y, i) => ({ x: i, y })),
        backgroundColor: palette[0] + 'cc', borderColor: palette[0], pointRadius: 5,
      }];
    }
  } else if (isBubble) {
    // 3-var relational: x=series0, y=series1, r=scaled(series2). Degrades to a
    // scatter-with-size when only 2 series, or value-vs-index with one.
    const sx = series[0].values;
    const sy = series[1] ? series[1].values : null;
    const sz = series[2] ? series[2].values : null;
    const sizes = (sz || []).filter(v => typeof v === 'number');
    // reduce, not Math.min/max(...sizes): a raw scatter/bubble over a >130k-row
    // combined dataset passes one value per row, and argument-spread that wide
    // throws RangeError (chart fails to render). Same guard as transforms/metricValue.
    const zmin = sizes.length ? sizes.reduce((a, b) => (b < a ? b : a)) : 0;
    const zmax = sizes.length ? sizes.reduce((a, b) => (b > a ? b : a)) : 0;
    const rOf = (v) => {
      if (typeof v !== 'number') return 8;
      if (zmax === zmin) return 14;
      return 6 + ((v - zmin) / (zmax - zmin)) * 20;  // px radius 6–26
    };
    const pts = labels.map((_, i) => ({
      x: sy ? (typeof sx[i] === 'number' ? sx[i] : 0) : i,
      y: sy ? (typeof sy[i] === 'number' ? sy[i] : 0)
            : (typeof sx[i] === 'number' ? sx[i] : 0),
      r: sz ? rOf(sz[i]) : 12,
    }));
    datasets = [{
      label: series.map(s => s.name).filter(Boolean).join(' · ') || '',
      data: pts,
      backgroundColor: palette[0] + 'cc',
      borderColor: palette[0],
    }];
  } else if (isFunnel) {
    // Centered funnel: a transparent left "spacer" stack pushes each value bar to
    // the middle, so widths read as a funnel narrowing down the stages.
    const vals = series[0].values.map(v => typeof v === 'number' ? Math.abs(v) : 0);
    const maxV = vals.reduce((a, b) => (b > a ? b : a), 0) || 1; // reduce, not spread (see zmin/zmax above)
    datasets = [
      { data: vals.map(v => (maxV - v) / 2), backgroundColor: 'transparent', borderWidth: 0, stack: 'f' },
      {
        label: series[0].name || 'Value',
        data: vals,
        backgroundColor: vals.map((_, i) => palette[i % palette.length]),
        borderWidth: 0, borderRadius: 4, stack: 'f',
      },
    ];
    opts._funnelMax = maxV;
    opts._funnelVals = vals;
  } else if (isHistogram) {
    // Distribution of the first numeric series, binned into touching columns.
    const bins = histogramBins(series[0].values.filter(v => typeof v === 'number'));
    chartLabels = bins.labels;
    datasets = [{
      label: 'Count',
      data: bins.counts,
      backgroundColor: makeBarGradient(palette[0]),
      borderColor: 'transparent', borderWidth: 0, borderRadius: 3,
      barPercentage: 1.0, categoryPercentage: 1.0,
    }];
  } else if (isSankey) {
    // We don't carry true flow data, so render a fan-in: each category flows into
    // a single "Total" node, widths ∝ value. Like maps, a grouped (multi-series)
    // sankey shows ONE period at a time (default: latest) — switched via the period
    // dropdown, not split into small multiples.
    const pIdx = Number.isInteger(overrides.periodIdx)
      ? Math.max(0, Math.min(overrides.periodIdx, series.length - 1))
      : series.length - 1;
    const vals = (series[pIdx] || series[0]).values;
    const flows = labels
      .map((lab, i) => ({ from: String(lab), to: 'Total', flow: typeof vals[i] === 'number' ? Math.abs(vals[i]) : 0 }))
      .filter(f => f.flow > 0);
    datasets = [{
      data: flows,
      colorFrom: (c) => palette[c.dataIndex % palette.length],
      colorTo: () => palette[palette.length - 1],
      colorMode: 'gradient',
      borderWidth: 0,
    }];
  } else if (isCandlestick) {
    // OHLC if there are >=4 series (open/high/low/close); otherwise synthesize a
    // candle from the single series + its previous value so it still renders.
    const get = (idx, i) => (series[idx] && typeof series[idx].values[i] === 'number') ? series[idx].values[i] : null;
    const pts = labels.map((lab, i) => {
      let o, h, l, c;
      if (series.length >= 4) { o = get(0, i); h = get(1, i); l = get(2, i); c = get(3, i); }
      else {
        c = get(0, i);
        const prev = i > 0 ? get(0, i - 1) : c;
        o = (prev == null) ? c : prev;
        h = Math.max(o == null ? 0 : o, c == null ? 0 : c);
        l = Math.min(o == null ? 0 : o, c == null ? 0 : c);
      }
      return { x: String(lab), o, h, l, c };
    });
    const up = getCSSVar('--ok') || '#16a34a';
    const down = getCSSVar('--error') || '#dc2626';
    datasets = [{
      label: 'OHLC',
      data: pts,
      color: { up, down, unchanged: palette[0] },
      borderColor: { up, down, unchanged: palette[0] },
    }];
  } else if (isBoxplot) {
    // One box per series, computed from that series' values across all rows. The
    // Series dropdown filters boxes; boxplot is a single dataset, so (like the
    // heatmap) we drop hidden series here rather than via setDatasetVisibility.
    const hiddenSet = new Set(Array.isArray(overrides.hiddenSeries) ? overrides.hiddenSeries : []);
    const visSeries = series.filter((_, j) => !hiddenSet.has(j));
    const useSeries = visSeries.length ? visSeries : series;
    const cols = useSeries.map(s => s.name || '');
    chartLabels = cols;
    datasets = [{
      label: 'Distribution',
      data: useSeries.map(s => s.values.filter(v => typeof v === 'number')),
      backgroundColor: palette[0] + '55',
      borderColor: palette[0],
      borderWidth: 1,
      itemRadius: 2,
      outlierBackgroundColor: palette[4 % palette.length],
    }];
  } else if (isLine) {
    datasets = series.map((s, i) => ({
      label: s.name || '',
      data: s.values,
      borderColor: palette[i % palette.length],
      backgroundColor: opts.fill ? makeAreaGradient(palette[i % palette.length]) : 'transparent',
      borderWidth: 2.2,
      fill: opts.fill ? (opts.stacked && i > 0 ? '-1' : true) : false,
      tension: lineTension,
      pointRadius: opts.markers ? 3 : 0,
      pointHoverRadius: 5,
      pointHoverBackgroundColor: palette[i % palette.length],
      pointHoverBorderColor: surfColor,
      pointHoverBorderWidth: 2,
    }));
  } else {
    // bars / columns (including pct-stacked)
    const buildBarData = (s, i) => {
      if (opts.pct) {
        const totals = labels.map((_, j) => series.reduce((sum, ss) => sum + (ss.values[j] || 0), 0));
        return s.values.map((v, j) => totals[j] ? Math.round((v / totals[j]) * 100) : 0);
      }
      return s.values;
    };
    if (opts.combo && series.length >= 2) {
      // Mixed chart: first series as columns, the rest as lines on a 2nd y-axis.
      datasets = series.map((s, i) => i === 0
        ? {
            label: s.name || '',
            data: buildBarData(s, i),
            backgroundColor: makeBarGradient(palette[0]),
            borderColor: 'transparent', borderWidth: 0, borderRadius: 7,
            barPercentage: 0.65, categoryPercentage: 0.8, order: 2,
          }
        : {
            type: 'line',
            label: s.name || '',
            data: s.values,
            yAxisID: 'y1',
            borderColor: palette[i % palette.length],
            backgroundColor: palette[i % palette.length],
            borderWidth: 2.2, tension: lineTension,
            pointRadius: 3, pointHoverRadius: 5,
            fill: false, order: 1,
          });
    } else {
      datasets = series.map((s, i) => ({
        label: s.name || '',
        data: buildBarData(s, i),
        backgroundColor: makeBarGradient(palette[i % palette.length]),
        borderColor: 'transparent',
        borderWidth: 0,
        borderRadius: 7,
        barPercentage: 0.65,
        categoryPercentage: 0.8,
      }));
    }
  }

  const defaultShowLegend = legendOnByDefault(type, series);
  const showLegend = overrides.showLegend !== undefined ? overrides.showLegend : defaultShowLegend;
  const showGridlines = overrides.showGridlines !== false; // default on
  const tickFont   = { family: fontFamily, size: 10 };

  // ── Axis helpers ────────────────────────────────────────────────────────
  // Value axis: faint horizontal gridlines, no frame border.
  const makeValueAxis = (stacked, pct) => ({
    stacked: stacked || false,
    ticks: {
      color: textColor, font: tickFont, padding: 6,
      // Readable axis numbers: thousands separators + K/M/B abbreviations.
      callback: pct ? (v => v + '%') : (v => fmt(v)),
    },
    grid: { color: gridColor, lineWidth: 1, display: showGridlines },
    border: { display: false },
    ...(pct ? { min: 0, max: 100 } : {}),
  });

  // Category axis: no gridlines, no frame border.
  // Tick labels drop a redundant " County" suffix for legibility; tooltips and
  // the data table still show the full label (they read data.labels directly).
  const makeCategoryAxis = (stacked, rotate) => ({
    stacked: stacked || false,
    ticks: {
      color: textColor, font: tickFont, padding: 4,
      ...(rotate ? { maxRotation: 40 } : {}),
      callback(value) {
        const label = (this as any).getLabelForValue(value); // ponytail: Chart.js scale `this`
        return typeof label === 'string' ? label.replace(/ County$/i, '') : label;
      },
    },
    grid: { display: false },
    border: { display: false },
  });

  let scales;
  if (isRound || isTreemap || isSankey) {
    scales = {};
  } else if (isCandlestick) {
    // category x (avoids needing a date adapter) + linear value axis
    scales = {
      x: { type: 'category', labels, offset: true, grid: { display: false },
           ticks: { color: textColor, font: tickFont, maxRotation: 40 }, border: { display: false } },
      y: makeValueAxis(false, false),
    };
  } else if (isMatrix) {
    // category axes; offset centers the cells, reverse puts the first row on top
    const catTick = { color: textColor, font: tickFont, padding: 4 };
    scales = {
      x: { type: 'category', labels: opts._matrixCols, offset: true, grid: { display: false }, ticks: catTick, border: { display: false } },
      y: { type: 'category', labels: opts._matrixRows, offset: true, reverse: true, grid: { display: false }, ticks: catTick, border: { display: false } },
    };
  } else if (isFunnel) {
    // hidden value axis (fixed to max so bars stay centered); category axis = stages
    scales = {
      x: { stacked: true, max: opts._funnelMax, display: false, grid: { display: false }, border: { display: false } },
      y: makeCategoryAxis(false, false),
    };
  } else if (isScatter || isBubble) {
    // scatter / bubble: both axes are value axes with light grid
    const valTick = { color: textColor, font: tickFont, padding: 6, callback: v => fmt(v) };
    scales = {
      x: { ticks: valTick, grid: { color: gridColor, lineWidth: 1 }, border: { display: false } },
      y: { ticks: valTick, grid: { color: gridColor, lineWidth: 1 }, border: { display: false } },
    };
  } else if (isHoriz) {
    // horizontal bars: x = value axis (gridlines useful), y = category axis
    scales = {
      x: makeValueAxis(opts.stacked, opts.pct),
      y: makeCategoryAxis(opts.stacked, false),
    };
  } else {
    // vertical bars / lines: x = category axis, y = value axis
    scales = {
      x: makeCategoryAxis(opts.stacked, true),
      y: makeValueAxis(opts.stacked, opts.pct),
    };
    if (opts.combo && series.length >= 2) {
      // secondary axis on the right for the line series; no gridlines of its own
      scales.y1 = {
        position: 'right',
        ticks: { color: textColor, font: tickFont, padding: 6, callback: v => fmt(v) },
        grid: { drawOnChartArea: false, display: false },
        border: { display: false },
      };
    }
  }

  // Y-axis "start at zero" override → the value axis (y for vertical, x for horizontal).
  if (overrides.yZero !== undefined) {
    const valueAxis = isHoriz ? scales.x : scales.y;
    if (valueAxis) {
      valueAxis.beginAtZero = !!overrides.yZero;
      if (overrides.yZero) valueAxis.min = 0; else delete valueAxis.min;
    }
  }

  // ── Tooltip ─────────────────────────────────────────────────────────────
  const tooltipConfig: any = {
    backgroundColor: surfColor,
    titleColor,
    bodyColor: textColor,
    borderColor: gridColor,
    borderWidth: 1,
    cornerRadius: 9,
    padding: { x: 11, y: 9 },
    boxWidth: 9,
    boxHeight: 9,
    boxPadding: 5,
    callbacks: {
      labelColor: (ctx) => {
        // Round charts color per slice (an interpolated array) — read the actual slice
        // color so the tooltip swatch matches it; others color per dataset.
        let color;
        if (isRound) {
          const bg = ctx.chart.data.datasets[ctx.datasetIndex].backgroundColor;
          color = Array.isArray(bg) ? bg[ctx.dataIndex] : bg;
        } else {
          color = palette[ctx.datasetIndex % palette.length];
        }
        return { borderColor: color, backgroundColor: color, borderWidth: 0, borderRadius: 2 };
      },
    },
  };
  if (isMatrix) {
    tooltipConfig.callbacks.title = (items) => { const r = items[0] && items[0].raw; return r ? `${r.y} · ${r.x}` : ''; };
    tooltipConfig.callbacks.label = (item) => { const r = item.raw; return r && typeof r.v === 'number' ? fmt(r.v) : 'n/a'; };
  }
  if (isTreemap) {
    tooltipConfig.callbacks.title = (items) => { const d = items[0] && items[0].raw && items[0].raw._data; return d ? String(d._label) : ''; };
    tooltipConfig.callbacks.label = (item) => { const d = item.raw && item.raw._data; return d ? fmt(d.value) : ''; };
  }
  if (isFunnel) {
    tooltipConfig.filter = (item) => item.datasetIndex !== 0;   // hide the spacer stack
    tooltipConfig.callbacks.label = (item) => {
      const v = opts._funnelVals[item.dataIndex];
      const top = opts._funnelVals[0] || 0;
      const pct = top ? Math.round((v / top) * 100) : null;
      return pct != null ? `${fmt(v)} (${pct}% of top)` : fmt(v);
    };
  }

  // Tooltip reach: line/area families default to intersect:true in Chart.js, so the
  // popup only appears on an exact-pixel point hit — which is why bars (fat targets)
  // seemed to be the only ones with tooltips. Use nearest + intersect:false for the
  // cartesian families so the popup shows whenever you hover near a point, just like
  // bars. Plugin types (treemap/heatmap/sankey/funnel/gauge/candlestick/boxplot) and
  // pie/donut keep Chart.js defaults, where per-element hover already works.
  const cartesianHover = !isRound && !isTreemap && !isMatrix && !isSankey
    && !isFunnel && !isGauge && !isCandlestick && !isBoxplot;
  const interactionConfig = cartesianHover
    ? { mode: 'nearest', intersect: false, axis: 'xy' } : undefined;

  // ── Per-chart inline plugins ─────────────────────────────────────────────
  const inlinePlugins = [];

  if (isGauge) {
    // Print the actual value at the hub of the half-circle.
    inlinePlugins.push({
      id: 'gaugeCenter',
      afterDraw(chart) {
        const { ctx, chartArea } = chart;
        if (!chartArea) return;
        const v = opts._gaugeValue;
        const txt = (v >= 0 && v <= 1) ? Math.round(v * 100) + '%' : fmt(v);
        const cx = (chartArea.left + chartArea.right) / 2;
        const cy = (chartArea.top + chartArea.bottom) / 2 + 4;
        ctx.save();
        ctx.textAlign = 'center';
        ctx.font = `700 22px ${fontFamily}`;
        ctx.fillStyle = titleColor;
        ctx.textBaseline = 'top';
        ctx.fillText(txt, cx, cy);
        // Name the metric below the value so the gauge isn't a context-free number.
        // (Skipped in small multiples — the per-mini caption already shows the name.)
        const label = opts._gaugeLabel;
        if (label && !overrides._smallMultiple) {
          ctx.font = `500 11px ${fontFamily}`;
          ctx.fillStyle = textColor;
          ctx.fillText(label, cx, cy + 26);
        }
        ctx.restore();
      },
    });
  }

  if (isFunnel) {
    // Always print each stage's value, centered on its bar.
    inlinePlugins.push({
      id: 'funnelLabels',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        const meta = chart.getDatasetMeta(1);   // the value dataset
        if (!meta) return;
        const vals = opts._funnelVals;
        meta.data.forEach((el, i) => {
          if (vals[i] == null) return;
          const pos = el.tooltipPosition();
          ctx.save();
          ctx.font = `600 11px ${fontFamily}`;
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(fmt(vals[i]), pos.x, pos.y);
          ctx.restore();
        });
      },
    });
  }

  // Reads a numeric value out of a Chart.js data point (handles {x,y} scatter points).
  const numOf = (raw) => {
    const v = (raw && typeof raw === 'object') ? raw.y : raw;
    return typeof v === 'number' ? v : null;
  };

  if (valueMode !== 'off' && !isRound && !isTreemap && !isMatrix && !isFunnel
      && !isSankey && !isCandlestick && !isBoxplot) {
    // Draw the data value near selected bars/points after the chart renders.
    inlinePlugins.push({
      id: 'valueLabels',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        // Build the value grid from visible datasets only (hidden → all-null row).
        const grid = chart.data.datasets.map((ds, di) =>
          chart.getDatasetMeta(di).hidden ? [] : (ds.data || []).map(numOf));
        const keys = valueLabelKeys(valueMode, grid);
        // Place each label in the first free vertical slot near its point so labels never
        // overlap. Sparse max/min modes nudge a collision into a small stack (keeping every
        // series' peak/trough visible even when lines nearly coincide); dense 'all' mode
        // just drops overlaps. Nudged slots stay inside the plot; the natural slot doesn't.
        const placed = [];
        const overlaps = (x, y, w, h) => placed.some(r =>
          x < r.x + r.w + 2 && x + w + 2 > r.x && y < r.y + r.h + 2 && y + h + 2 > r.y);
        // Drop duplicate labels: identical value at the same x (e.g. several near-equal
        // series peaking at the same category) collapses to one, so it never piles up.
        const seen = new Set();
        const area = chart.chartArea;
        const h = 12;
        const offsets = valueMode === 'all'
          ? [0]
          : [0, -(h + 1), h + 1, -2 * (h + 1), 2 * (h + 1), -3 * (h + 1), 3 * (h + 1), -4 * (h + 1), 4 * (h + 1)];
        ctx.save();
        ctx.font = `600 10px ${fontFamily}`;
        ctx.fillStyle = titleColor;
        ctx.textAlign = 'center';
        chart.data.datasets.forEach((dataset, di) => {
          const meta = chart.getDatasetMeta(di);
          if (meta.hidden) return;
          meta.data.forEach((element, j) => {
            if (!keys.has(di + ':' + j)) return;
            let displayVal = numOf(dataset.data[j]);
            if (displayVal == null) return;
            // Stacked charts position each point at the cumulative top, so label the running
            // total (visible series 0..di) — otherwise the raw number won't match the axis.
            if (opts.stacked) {
              let cum = 0;
              for (let d = 0; d <= di; d++) {
                if (chart.getDatasetMeta(d).hidden) continue;
                const dv = numOf(chart.data.datasets[d].data[j]);
                if (typeof dv === 'number') cum += dv;
              }
              displayVal = cum;
            }
            const pos = element.tooltipPosition();
            const formatted = overrides.numberFormat ? fmt(displayVal)
              : (Math.abs(displayVal) >= 10000 ? _fmtVal(displayVal) : String(displayVal));
            const w = ctx.measureText(formatted).width;
            const tx = isHoriz ? pos.x + 8 : pos.x;
            const ty0 = isHoriz ? pos.y : pos.y - 4;
            const bx = isHoriz ? tx : tx - w / 2;
            const dedupeKey = formatted + '@' + Math.round(tx);
            if (seen.has(dedupeKey)) return;
            for (const dy of offsets) {
              const ty = ty0 + dy;
              const by = isHoriz ? ty - h / 2 : ty - h;
              if (dy !== 0 && area && (by < area.top || by + h > area.bottom)) continue;
              if (overlaps(bx, by, w, h)) continue;
              placed.push({ x: bx, y: by, w, h });
              seen.add(dedupeKey);
              ctx.textBaseline = isHoriz ? 'middle' : 'bottom';
              ctx.fillText(formatted, tx, ty);
              break;
            }
          });
        });
        ctx.restore();
      },
    });
  }

  if (isRound) {
    // Pie/donut have no axes, so label each big-enough slice with its category name
    // directly (always on — readable without hovering or colour-matching the legend);
    // small slices fall back to the legend. When Values is on, the slice's value is
    // added below the name. White text + shadow keeps it legible on any slice colour.
    inlinePlugins.push({
      id: 'roundLabels',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        const meta = chart.getDatasetMeta(0);
        const ds = chart.data.datasets[0];
        const row = ((ds && ds.data) || []).map(numOf);
        const total = row.reduce((a, v) => a + (typeof v === 'number' ? Math.abs(v) : 0), 0) || 1;
        const cats = chart.data.labels || [];
        const valueKeys = valueMode !== 'off' ? valueLabelKeys(valueMode, [row]) : new Set();
        const clip = (s) => (s.length > 14 ? s.slice(0, 13) + '…' : s);
        meta.data.forEach((el, j) => {
          if (!el) return;
          const val = row[j];
          const frac = (typeof val === 'number' ? Math.abs(val) : 0) / total;
          const name = cats[j] == null ? '' : String(cats[j]);
          const showName = frac >= 0.06 && name !== '';   // only slices big enough to read
          const showVal = val != null && valueKeys.has('0:' + j);
          if (!showName && !showVal) return;
          const lines = [];
          if (showName) lines.push(clip(name));
          if (showVal) lines.push(overrides.numberFormat ? fmt(val)
            : (Math.abs(val) >= 10000 ? _fmtVal(val) : String(val)));
          const pos = el.tooltipPosition();
          const lh = 12;
          const y0 = pos.y - ((lines.length - 1) * lh) / 2;
          ctx.save();
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.shadowColor = 'rgba(0,0,0,0.5)';
          ctx.shadowBlur = 3;
          ctx.fillStyle = '#ffffff';
          lines.forEach((ln, k) => {
            ctx.font = `${(k === 0 && showName) ? 600 : 500} 10px ${fontFamily}`;
            ctx.fillText(ln, pos.x, y0 + k * lh);
          });
          ctx.restore();
        });
      },
    });
  }

  if (valueMode !== 'off' && isMatrix) {
    inlinePlugins.push({
      id: 'matrixValueLabels',
      afterDatasetsDraw(chart) {
        const { ctx } = chart;
        const meta = chart.getDatasetMeta(0);
        const rows = (opts._matrixRows || []).length;
        if (!rows) return;
        const keys = valueLabelKeys(valueMode, opts._matrixGrid || []);   // [colIdx][rowIdx]
        meta.data.forEach((el, k) => {
          const colIdx = Math.floor(k / rows), rowIdx = k % rows;
          if (!keys.has(colIdx + ':' + rowIdx)) return;
          const v = numOf((chart.data.datasets[0].data[k] || {}).v);
          if (v == null) return;
          const pos = el.getCenterPoint ? el.getCenterPoint() : { x: el.x, y: el.y };
          const formatted = overrides.numberFormat ? fmt(v)
            : (Math.abs(v) >= 10000 ? _fmtVal(v) : String(v));
          // Ink picked by cell darkness (the same accent-alpha ramp the cell is filled
          // with) — replaces the old halo stroke, which left a smudge behind the digits.
          const span = (opts._matrixVmax - opts._matrixVmin) || 1;
          const cellAlpha = 0.15 + 0.85 * ((v - opts._matrixVmin) / span);
          ctx.save();
          ctx.font = `600 10px ${fontFamily}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = cellAlpha >= 0.55 ? '#ffffff' : titleColor;
          ctx.fillText(formatted, pos.x, pos.y);
          ctx.restore();
        });
      },
    });
  }

  // ── Axis titles from overrides ────────────────────────────────────────────
  if (!isRound && !isScatter && scales.x && overrides.xAxisLabel) {
    scales.x.title = { display: true, text: overrides.xAxisLabel, color: textColor, font: tickFont };
  }
  if (!isRound && scales.y && overrides.yAxisLabel) {
    scales.y.title = { display: true, text: overrides.yAxisLabel, color: textColor, font: tickFont };
  }
  if (isScatter) {
    if (overrides.xAxisLabel) scales.x.title = { display: true, text: overrides.xAxisLabel, color: textColor, font: tickFont };
    if (overrides.yAxisLabel) scales.y.title = { display: true, text: overrides.yAxisLabel, color: textColor, font: tickFont };
  }

  // ── Series filter (period multi-select) ────────────────────────────────────
  // Hide deselected series. Indices align with `series` (both use chartSeries()).
  // Guard skips single-dataset types (pie/scatter/bubble/…) where 1 dataset ≠ N series.
  const hiddenSeries = new Set(Array.isArray(overrides.hiddenSeries) ? overrides.hiddenSeries : []);
  if (hiddenSeries.size && datasets.length === series.length) {
    datasets.forEach((ds, i) => { if (hiddenSeries.has(i)) ds.hidden = true; });
  }

  // ── Build chart ──────────────────────────────────────────────────────────
  try {
    return new window.Chart(canvas, {
      type: chartType,
      data: { labels: chartLabels, datasets },
      plugins: inlinePlugins,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // Export capture passes devicePixelRatio:2 (crisp PNG) + noAnimate (draw the
        // final frame immediately so toDataURL isn't a mid-animation snapshot).
        devicePixelRatio: overrides.devicePixelRatio || undefined,
        animation: overrides.noAnimate ? false : { duration: animDuration, easing: 'easeOutQuart' },
        indexAxis: opts.indexAxis || 'x',
        ...(interactionConfig ? { interaction: interactionConfig } : {}),
        layout: { padding: { top: overrides.title ? 6 : 10, right: 12, bottom: 4, left: 6 } },
        ...(isGauge ? { cutout: '72%', rotation: 270, circumference: 180 }
           : chartType === 'doughnut' ? { cutout: '62%' } : {}),
        plugins: {
          title: overrides.title
            ? { display: true, text: overrides.title, color: titleColor,
                font: { family: fontFamily, size: 13, weight: '600' }, padding: { bottom: 8 } }
            : { display: false },
          legend: {
            display: showLegend,
            position: overrides.legendPosition || 'bottom',
            labels: {
              color: textColor,
              font: { family: fontFamily, size: 10 },
              boxWidth: 10,
              boxHeight: 10,
              padding: 12,
              // Pie/donut legend maps each colour to a category — circle markers read
              // cleaner than squares for a many-slice list.
              usePointStyle: isRound,
              pointStyle: 'circle',
              // Line/area swatches default to a hollow box (transparent fill). Paint each
              // with its line color so every legend entry reads as a solid colored box.
              generateLabels(chart) {
                const items = window.Chart.defaults.plugins.legend.labels.generateLabels(chart);
                items.forEach((it) => {
                  const ds = chart.data.datasets[it.datasetIndex];
                  if (chart.config.type === 'line' || (ds && ds.type === 'line')) {
                    it.fillStyle = it.strokeStyle;
                    it.lineWidth = 0;
                  }
                });
                return items;
              },
            },
          },
          // Absent means ON: every chart drawn before this key existed had
          // tooltips, and a missing override must not silently turn them off.
          tooltip: overrides.showTooltips === false
            ? { enabled: false }
            : tooltipConfig,
        },
        scales,
      },
    });
  } catch (_) {
    return null;
  }
}
