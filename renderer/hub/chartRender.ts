// Chart rendering — buildChart: resolve the chart id, read the theme off the
// canvas, and assemble the one Chart.js config the four family modules fill in.
// Classic script sharing global scope: the Chart.js UMD globals load earlier;
// hub.js's _fmtVal/histogramBins resolve at call time; the chartInstances/
// mapInstances WeakMaps are defined here and used cross-file by mapRender.js
// and hub.js.
//
// Six neighbours load BEFORE it (index.html), in this order:
//   chartTraits.js      — what a chart id is (period-filterable, small-multiple, …)
//   chartPalette.js     — CHART_PALETTE, getCSSVar, the hex/HSL derivation helpers
//   chartTable.js       — buildDataTable, which renders a <table>, not a chart
//   chartTypeSpec.js    — chart id → Chart.js type + option flags + traits
//   chartValueLabels.js — which points get labelled, and the plugins that draw them
//   chartDatasets.js    — the per-family Chart.js dataset shapes
//   chartScales.js      — the per-family axis sets
//
// THE PARAMETER OBJECT. buildChart used to be one 870-line function whose
// per-family blocks all read the same locals, which is exactly why it sat on the
// file-size allowlist: the blocks could not move without something to carry
// (palette, fmt, isRound, opts, the theme colours) with them. `ChartCtx` below
// is that something. It is assembled ONCE here, after the theme is read, and
// each family module destructures it back into the same local names — so the
// blocks are the code they always were, in a file named for what they build.
//
// The three family modules run in a fixed order and it is not cosmetic:
// buildChartDatasets writes per-family state onto `opts` (_gaugeValue,
// _matrixCols/_matrixGrid, _funnelMax/_funnelVals) that buildChartScales and
// buildChartPlugins then read.

// ── Shared shapes ───────────────────────────────────────────────────────────
// Referenced by chartTraits.ts, chartTable.ts and the chart family modules as
// well. They live here, with the pipeline they describe, rather than in one of
// those leaf files: interfaces and type aliases emit no JavaScript, so a sibling
// reading them creates no runtime dependency and no load-order constraint.
// The {labels, series} object vizData.buildVizData produces and everything in
// this file consumes. Declared locally, not imported: renderer files are classic
// global-scope scripts with no module system, so there is nothing to import from
// and nothing to export to.
//
// `values` is `any[]` on purpose. A cell is whatever the dataset holds — a
// number, a text value, or null — and it is Ordinate's own ColumnType in the
// dataset record, not TypeScript, that decides how it may be read. Every
// consumer below narrows with `typeof v === 'number'` before doing arithmetic,
// which is the check that actually holds at runtime; a nominal union here would
// only move that check to a place it cannot be enforced.
interface ChartSeriesShape {
  name?: string;
  values: any[];
}
interface ChartDataShape {
  labels?: any[];
  series?: ChartSeriesShape[];
}

// Chart.js 4 and its plugin bundles (treemap/matrix/sankey/financial/boxplot)
// load as UMD globals with no bundled type definitions, so every value Chart.js
// hands back across a callback boundary — scriptable option contexts, plugin
// hook arguments, legend items, tooltip items, element/meta objects — is
// genuinely untyped here. Naming it says "this is a library boundary", which a
// bare `any` at 60-odd call sites would not.
type ChartJsCtx = any;

// Everything one chart's family blocks need, in one object: the resolved type
// spec (chartType, opts and the is* traits, from chartTypeSpec.js) plus the data,
// the overrides, the formatter and the theme tokens read off THIS canvas.
//
// It is deliberately flat and deliberately not a class. Each family module
// destructures the members it uses under their original names, which is what
// keeps those blocks byte-identical to the ones that used to read these as
// buildChart's locals — and what scripts/test-chartSpec.ts freezes.
interface ChartCtx extends ChartTypeSpec {
  canvas: HTMLCanvasElement;
  labels: any[];
  series: ChartSeriesShape[];
  overrides: any;
  fmt: (v: any) => string;
  valueMode: string;
  lineTension: number;
  palette: string[];
  textColor: string;
  gridColor: string;
  surfColor: string;
  titleColor: string;
  fontFamily: string;
  showLegend: boolean;
  showGridlines: boolean;
  tickFont: { family: string; size: number };
}

// ── Chart rendering ────────────────────────────────────────────────────────
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
function chartSeries(data: ChartDataShape | null | undefined): ChartSeriesShape[] {
  return Array.isArray(data && data.series)
    ? data.series.filter((s: ChartSeriesShape) => Array.isArray(s.values) && s.values.length > 0)
    : [];
}

// A month-truncated date axis reads as a date axis unless it is formatted.
// `datetrunc('month', order_date)` — the only way to chart by month, since
// VizEncoding has no granularity — yields '2023-01-01', and a year of those
// prints twelve full ISO dates whose day part is noise on every one of them.
//
// All-or-nothing on purpose: one label that is not a first-of-month means the
// axis is really daily and the days carry information, so nothing is rewritten.
// UTC throughout — `new Date('2023-01-01')` is UTC midnight, and formatting it
// in a negative-offset zone would label January as Dec 2022.
const FIRST_OF_MONTH_RE = /^(\d{4})-(\d{2})-01(?:[T ]00:00(?::00(?:\.000)?)?Z?)?$/;

function asMonthLabels(labels: any[]): any[] {
  const parsed = labels.map((l) => (typeof l === 'string' ? FIRST_OF_MONTH_RE.exec(l.trim()) : null));
  if (parsed.some((m) => !m)) return labels;
  return parsed.map((m: any) => new Date(Date.UTC(+m[1], +m[2] - 1, 1))
    .toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }));
}

// Build a Chart.js instance for the given data + type id. Returns instance or null.
// overrides: optional per-chart customization { title, color, valueMode, hiddenSeries,
//            showLegend, showGridlines, xAxisLabel, yAxisLabel }
//            (legacy showValues:true is still read as valueMode 'all')
// `overrides` is an open bag of per-chart customization read from a saved visual
// record, a dashboard tile and the Customize menu alike. It is `any` because the
// set genuinely grows per chart family (_gaugeValue, _matrixCols, _funnelVals are
// written back onto `opts` by chartDatasets) and every read is already guarded;
// typing it would be a second, weaker copy of a contract the record format owns.
function buildChart(
  canvas: HTMLCanvasElement | null,
  data: ChartDataShape,
  type: string,
  overrides?: any,
): any {
  overrides = overrides || {};
  let labels = asMonthLabels(Array.isArray(data.labels) ? data.labels : []);
  let series = chartSeries(data);
  if (!labels.length || !series.length || !canvas) return null;

  // Number formatter for display (axis ticks, value labels, tooltips). When the
  // `numberFormat` override is absent, fmt === _fmtVal, so output is byte-identical
  // to before this control existed (the capture flow never sets numberFormat).
  const fmt = overrides.numberFormat ? (v: any) => fmtWith(v, overrides.numberFormat) : _fmtVal;

  // Values menu mode: off | all | max | min | maxmin. Back-compat: legacy showValues:true ⇒ all.
  const valueMode = overrides.valueMode || (overrides.showValues ? 'all' : 'maxmin');
  // Line smoothing: curved (default) vs straight segments.
  const lineTension = overrides.smooth === false ? 0 : 0.35;

  // ── Theme tokens, resolved off THIS canvas, never :root (see chartPalette) ──
  // Read HERE, inside buildChart, and never hoisted: getComputedStyle on a
  // DETACHED element returns '' for every custom property, so a colour read
  // before the canvas is in the document silently falls back to Chart.js's #666.
  const palette = [
    getCSSVar('--chart-1', canvas) || CHART_PALETTE[0],
    getCSSVar('--chart-2', canvas) || CHART_PALETTE[1],
    getCSSVar('--chart-3', canvas) || CHART_PALETTE[2],
    getCSSVar('--chart-4', canvas) || CHART_PALETTE[3],
    getCSSVar('--chart-5', canvas) || CHART_PALETTE[4],
  ];
  // Color override seeds a harmonious palette: every series (and pie/donut slice,
  // which uses palette[i % len]) recolors to a distinct hue derived from the pick,
  // with series 1 = the exact chosen color. Single-series → just the chosen color.
  if (overrides.color) {
    const seeded = paletteFromSeed(overrides.color, palette.length);
    for (let i = 0; i < palette.length; i++) palette[i] = seeded[i];
  }
  const textColor  = getCSSVar('--muted', canvas);
  const gridColor  = getCSSVar('--border', canvas);
  const surfColor  = getCSSVar('--surface', canvas);
  const titleColor = getCSSVar('--text-strong', canvas);
  const fontFamily = getCSSVar('--font-ui', canvas) || 'system-ui, sans-serif';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animDuration = reduceMotion ? 0 : 480;

  // ── Chart type resolution (chartTypeSpec.js) ────────────────────────────
  const spec = resolveChartType(type);
  const { chartType, opts, isRound, isMatrix, isTreemap, isFunnel, isSankey,
          isGauge, isCandlestick, isBoxplot, isHistogram, isHoriz } = spec;

  // ── Sort by value (bar/column families + pie/donut) ───────────────────────
  // Reorders categories by their total across series; line/area/funnel/histogram
  // keep their natural order (sorting would scramble a time axis / fixed sequence).
  //
  // NOT A GAUGE, even though `isRound` is true for one — a gauge is drawn as a
  // Chart.js doughnut, so it inherits every round-family branch unless a branch
  // says otherwise (the same reason #145 had to exclude it from `roundLabels`).
  //
  // Sorting a gauge does not reorder anything the eye can see: chartDatasets
  // builds its two slices itself from `series[0].values.find(isNumber)` — the
  // FIRST numeric value — so reordering the categories underneath changes WHICH
  // NUMBER THE GAUGE SHOWS. Measured on 3 categories of 120/340/80: unsorted 120,
  // `asc` 80, `desc` 340, with the scale moving under it each time. A display
  // control that silently swaps the figure is the one thing this app must never
  // do, so a gauge keeps whichever value its encoding selected.
  const canSort = (chartType === 'bar' && !isFunnel && !isHistogram) || (isRound && !isGauge);
  if (canSort && (overrides.sort === 'asc' || overrides.sort === 'desc')) {
    const totals = labels.map((_: any, i: number) =>
      series.reduce((sum: number, s: ChartSeriesShape) => sum + (typeof s.values[i] === 'number' ? s.values[i] : 0), 0));
    const order = labels.map((_: any, i: number) => i)
      .sort((a: number, b: number) => overrides.sort === 'asc' ? totals[a] - totals[b] : totals[b] - totals[a]);
    labels = order.map((i: number) => labels[i]);
    series = series.map((s: ChartSeriesShape) => Object.assign({}, s, { values: order.map((i: number) => s.values[i]) }));
  }

  const defaultShowLegend = legendOnByDefault(type, series);
  const showLegend = overrides.showLegend !== undefined ? overrides.showLegend : defaultShowLegend;
  const showGridlines = overrides.showGridlines !== false; // default on
  const tickFont   = { family: fontFamily, size: 10 };

  // ── The parameter object every family module reads ───────────────────────
  const c: ChartCtx = {
    ...spec,
    canvas, labels, series, overrides,
    fmt, valueMode, lineTension,
    palette, textColor, gridColor, surfColor, titleColor, fontFamily,
    showLegend, showGridlines, tickFont,
  };

  // Datasets FIRST — they write the per-family state on `opts` that the axes and
  // the inline plugins read back (see the header).
  const { datasets, chartLabels } = buildChartDatasets(c);
  const scales = buildChartScales(c);

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
      labelColor: (ctx: ChartJsCtx) => {
        // Round charts color per slice (an interpolated array) — read the actual slice
        // color so the tooltip swatch matches it; others color per dataset.
        let color: string;
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
    tooltipConfig.callbacks.title = (items: ChartJsCtx[]) => { const r = items[0] && items[0].raw; return r ? `${r.y} · ${r.x}` : ''; };
    tooltipConfig.callbacks.label = (item: ChartJsCtx) => { const r = item.raw; return r && typeof r.v === 'number' ? fmt(r.v) : 'n/a'; };
  }
  if (isTreemap) {
    tooltipConfig.callbacks.title = (items: ChartJsCtx[]) => { const d = items[0] && items[0].raw && items[0].raw._data; return d ? String(d._label) : ''; };
    tooltipConfig.callbacks.label = (item: ChartJsCtx) => { const d = item.raw && item.raw._data; return d ? fmt(d.value) : ''; };
  }
  if (isFunnel) {
    tooltipConfig.filter = (item: ChartJsCtx) => item.datasetIndex !== 0;   // hide the spacer stack
    tooltipConfig.callbacks.label = (item: ChartJsCtx) => {
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

  // ── Per-chart inline plugins (chartValueLabels.js) ───────────────────────
  const inlinePlugins = buildChartPlugins(c);

  // ── Series filter (period multi-select) ────────────────────────────────────
  // Hide deselected series. Indices align with `series` (both use chartSeries()).
  // Guard skips single-dataset types (pie/scatter/bubble/…) where 1 dataset ≠ N series.
  const hiddenSeries = new Set(Array.isArray(overrides.hiddenSeries) ? overrides.hiddenSeries : []);
  if (hiddenSeries.size && datasets.length === series.length) {
    datasets.forEach((ds: any, i: number) => { if (hiddenSeries.has(i)) ds.hidden = true; });
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
              // Start from the generator THIS CHART TYPE would have used, then recolour.
              // Chart.js puts a per-SLICE generator on Chart.overrides.doughnut (pie
              // inherits it as a static), and only the dataset-based one on
              // Chart.defaults — so reaching for the default collapsed a 3-category
              // donut to a single entry whose text was the dataset's absent label. That
              // matters beyond looks: chartValueLabels drops a slice's label when it
              // cannot fit, on the promise the legend still names it.
              // Recolour: line/area swatches default to a hollow box (transparent fill).
              // Paint each with its line color so every entry reads as a solid box.
              generateLabels(chart: ChartJsCtx) {
                const gen = window.Chart.overrides?.[chart.config.type]?.plugins?.legend
                  ?.labels?.generateLabels
                  || window.Chart.defaults.plugins.legend.labels.generateLabels;
                const items = gen(chart);
                items.forEach((it: ChartJsCtx) => {
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
