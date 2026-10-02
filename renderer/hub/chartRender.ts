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
//   chartShapes.js / chartFamiliesExtra.js — waterfall, bullet, calendar, radar
//                         and Pareto: their pure shapes, then everything they draw
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
  /** 'overlay' = a prior period drawn muted beside its own series (visualsOverlay.ts). */
  role?: string;
  /** A table calculation: `values` calculated, `raw` the figures (analysis/tableCalc.ts). */
  raw?: any[];
  calc?: TcCalc;
}

/**
 * The chart types a period overlay is drawn on. Everywhere else a comparison
 * series would be read as a real category — a pie slice, a stacked segment —
 * so buildChart drops it rather than draw something that means something else.
 */
const CHART_OVERLAY_TYPES = new Set(['line', 'area', 'line_markers', 'column', 'clustered_column', 'bar', 'clustered_bar']);
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

// ── Motion: THE one Chart.js animation config ───────────────────────────────
// Every chart this file builds animates by these numbers, and a dashboard
// transition (motion.ts) steps through the `mtStep` half of it when bars leave
// and the rest slide. prefers-reduced-motion is read LIVE — flipping it in the
// OS turns the next draw and the next transition into an instant swap without
// a reload. noAnimate (export, thumbnails, reports) always gets the final frame.
const CHART_MOTION_MS = 300;
// A MediaQueryList's `matches` is live, so reading it per draw IS listening.
const chartMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

function chartMotionReduced(): boolean { return chartMotionQuery.matches; }

function chartAnimation(overrides: any): any {
  return overrides.noAnimate || chartMotionReduced() ? false : { duration: CHART_MOTION_MS, easing: 'easeOutCubic' };
}

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
  if (!CHART_OVERLAY_TYPES.has(type)) series = series.filter((s: ChartSeriesShape) => s.role !== 'overlay');
  if (!labels.length || !series.length || !canvas) return null;

  // Number formatter for display (axis ticks, value labels, tooltips). When the
  // `numberFormat` override is absent, fmt === _fmtVal, so output is byte-identical
  // to before this control existed (the capture flow never sets numberFormat).
  // A calculated series (table calculations, calcMenu.ts) formats as its kind.
  const fmt = tcAxisFmt(series, overrides.numberFormat ? (v: any) => fmtWith(v, overrides.numberFormat) : _fmtVal);

  // Values menu mode: off | all | max | min | maxmin. Back-compat: legacy showValues:true ⇒ all.
  const valueMode = overrides.valueMode || (overrides.showValues ? 'all' : 'maxmin');
  // Line smoothing: curved (default) vs straight segments.
  const lineTension = overrides.smooth === false ? 0 : 0.35;

  // ── Theme tokens, resolved off THIS canvas, never :root (see chartPalette) ──
  // Read HERE, inside buildChart, and never hoisted: getComputedStyle on a
  // DETACHED element returns '' for every custom property, so a colour read
  // before the canvas is in the document silently falls back to Chart.js's #666.
  const palette = CHART_PALETTE.map((fallback, i) => getCSSVar(`--chart-${i + 1}`, canvas) || fallback);
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
  const fontFamily = getCSSVar('--font-ui', canvas) || t('chartRender.system_ui_sans_serif');

  // ── Chart type resolution (chartTypeSpec.js) ────────────────────────────
  const spec = resolveChartType(type);
  const { chartType, opts, isRound, isMatrix, isTreemap, isFunnel, isSankey,
          isGauge, isCandlestick, isBoxplot, isHistogram, isHoriz } = spec;
  // A word cloud is not a Chart.js chart: wordCloudRender.js draws it on this canvas.
  if (spec.isWordCloud) return buildWordCloud(canvas, labels, series, overrides, { palette, fmt, textColor, titleColor, fontFamily, surfColor });

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
  // A waterfall's order IS its story and a Pareto sorts itself, so neither.
  const canSort = ((chartType === 'bar' && !isFunnel && !isHistogram) || (isRound && !isGauge))
    && !spec.isWaterfall && !spec.isPareto;
  let sortOrder: number[] | null = null; // chart position → main's index, for the overlays
  // By label (A→Z / Z→A, numbers in number order) and by hand (`custom`: the
  // stored `sortOrder` first, every label it does not name after, as it came)
  // reorder the same set — a sort never adds, drops or changes a figure. Both
  // read the RAW labels, so a month axis sorts as 2023-01 < 2023-04, not as
  // the "Apr 2023" < "Jan 2023" its display text would.
  const byLabel = overrides.sort === 'label_asc' || overrides.sort === 'label_desc';
  const rawLabels: any[] = Array.isArray(data.labels) ? data.labels : [];
  if (canSort && (overrides.sort === 'asc' || overrides.sort === 'desc' || byLabel || overrides.sort === 'custom')) {
    const totals = labels.map((_: any, i: number) =>
      series.reduce((sum: number, s: ChartSeriesShape) => sum + (typeof s.values[i] === 'number' ? s.values[i] : 0), 0));
    const rank = new Map<string, number>();
    (Array.isArray(overrides.sortOrder) ? overrides.sortOrder : []).forEach((l: any, k: number) => rank.set(String(l), k));
    const pos = (i: number) => (rank.has(String(rawLabels[i])) ? rank.get(String(rawLabels[i])) : rank.size + i);
    const order = labels.map((_: any, i: number) => i).sort((a: number, b: number) => {
      if (overrides.sort === 'custom') return pos(a) - pos(b);
      if (byLabel) {
        const d = String(rawLabels[a]).localeCompare(String(rawLabels[b]), undefined, { numeric: true });
        return overrides.sort === 'label_asc' ? d : -d;
      }
      return overrides.sort === 'asc' ? totals[a] - totals[b] : totals[b] - totals[a];
    });
    labels = order.map((i: number) => labels[i]);
    series = series.map((s: ChartSeriesShape) => Object.assign({}, s, { values: order.map((i: number) => s.values[i]) },
      Array.isArray(s.raw) ? { raw: order.map((i: number) => s.raw[i]) } : {}));
    sortOrder = order;
  }

  // ── Analytics overlays + comment pins (chartAnnotations.js) ───────────────
  // Resolved in main and carried on `data.analytics`; only the kinds this type
  // draws (spec.overlayKinds). A forecast needs room PAST the last category, so
  // the axis grows by its periods and every series is padded with gaps there.
  const annOverlays = annDrawable(Array.isArray((data as any).analytics) ? (data as any).analytics : [], spec, !!sortOrder);
  const annPins: AnnCommentPin[] = Array.isArray(overrides.commentPins) ? overrides.commentPins : [];
  const annBase = { labels: Array.isArray(data.labels) ? data.labels : [], series: Array.isArray(data.series) ? data.series : [] };
  const annForecast = annOverlays.reduce((best: string[], o: any) =>
    (o.kind === 'forecast' && o.forecast && o.forecast.labels.length > best.length ? o.forecast.labels : best), []);
  if (annForecast.length) {
    labels = labels.concat(asMonthLabels(annForecast));
    const gap = annForecast.map(() => null);
    series = series.map((s: ChartSeriesShape) => Object.assign({}, s, { values: s.values.concat(gap) },
      Array.isArray(s.raw) ? { raw: s.raw.concat(gap) } : {}));
  }

  const defaultShowLegend = legendOnByDefault(type, series);
  const showLegend = overrides.showLegend !== undefined ? overrides.showLegend : defaultShowLegend;
  const showGridlines = overrides.showGridlines !== false; // default on
  const tickFont   = { family: fontFamily, size: 10 };

  // Formatting depth (fmtApply.ts): series colours into the palette, and the
  // project's colour per category. Guarded — the chart test harnesses load the
  // family scripts only.
  const fmtCat = typeof fmtResolve === 'function' ? fmtResolve(labels, series, overrides, palette, type) : null;

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
  const built = buildChartDatasets(c);
  if (!built) return null;   // nothing drawable (a calendar without dates)
  const { datasets, chartLabels } = built;
  const scales = buildChartScales(c);
  if (typeof fmtApply === 'function') fmtApply(c, datasets, scales, fmtCat, type);
  // The value axis must reach every overlay — a target above the tallest bar
  // would otherwise be drawn off the chart. `suggested*`, so an explicit
  // min/max (a percent-stacked 0–100) still wins.
  const annExt = annOverlays.length ? annExtent(annOverlays) : null;
  const annAxis = scales && scales[isHoriz ? 'x' : 'y'];
  if (annExt && annAxis) {
    annAxis.suggestedMin = typeof annAxis.suggestedMin === 'number' ? Math.min(annAxis.suggestedMin, annExt.min) : annExt.min;
    annAxis.suggestedMax = typeof annAxis.suggestedMax === 'number' ? Math.max(annAxis.suggestedMax, annExt.max) : annExt.max;
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
      return pct != null ? t('chartRender.of_top', { v: fmt(v), pct }) : fmt(v);
    };
  }
  if (isExtraFamily(spec)) applyExtraTooltip(c, tooltipConfig);
  else if (!isMatrix && !isTreemap && !isFunnel && !isSankey && !isGauge && !isCandlestick && !isBoxplot) {
    tcTooltip(series, tooltipConfig, fmt);
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
  if (annWanted(annOverlays, annPins, spec)) {
    inlinePlugins.push(annotationsPlugin({
      overlays: annOverlays, pins: annPins, labels: annBase.labels, series: annBase.series,
      order: sortOrder, pinTarget: overrides.commentPinTarget || null, fmt, fontFamily,
    }));
  }
  // r8:events — the project's events on a date axis (chartEvents.js), unless this visual hides them.
  const evMarks = typeof evDrawable === 'function' ? evDrawable(data, spec, !!sortOrder, overrides) : [];
  if (evMarks.length) inlinePlugins.push(eventsPlugin({ events: evMarks, fontFamily, isStatic: !!overrides.devicePixelRatio }));
  // Linked hover + transitions (linkedHover.ts / motion.ts). Both no-op outside a
  // dashboard card; guarded because the chart test harnesses load families only.
  if (typeof lhPlugin !== 'undefined') inlinePlugins.push(lhPlugin, mtPlugin);

  // ── Series filter (period multi-select) ────────────────────────────────────
  // Hide deselected series. Indices align with `series` (both use chartSeries()).
  // Guard skips single-dataset types (pie/scatter/bubble/…) where 1 dataset ≠ N series.
  const hiddenSeries = new Set(Array.isArray(overrides.hiddenSeries) ? overrides.hiddenSeries : []);
  // Not the extra families: a radar's datasets are CATEGORIES, and a matching
  // count there would hide a polygon by a series index.
  if (hiddenSeries.size && datasets.length === series.length && !isExtraFamily(spec)) {
    datasets.forEach((ds: any, i: number) => { if (hiddenSeries.has(i)) ds.hidden = true; });
  }

  // ── Build chart ──────────────────────────────────────────────────────────
  try {
    const chart = new window.Chart(canvas, {
      type: chartType,
      data: { labels: chartLabels, datasets },
      plugins: inlinePlugins,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // Export capture passes devicePixelRatio:2 (crisp PNG) + noAnimate (draw the
        // final frame immediately so toDataURL isn't a mid-animation snapshot).
        devicePixelRatio: overrides.devicePixelRatio || undefined,
        animation: chartAnimation(overrides),
        transitions: { mtStep: { animation: { duration: CHART_MOTION_MS / 2 } } },
        indexAxis: opts.indexAxis || 'x',
        ...(interactionConfig ? { interaction: interactionConfig } : {}),
        layout: { padding: { top: overrides.title ? 6 : 10, right: 12, bottom: 4, left: 6 } },
        ...(isExtraFamily(spec) ? extraChartOptions(c) : {}),
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
    if (typeof mtAfterBuild === 'function') mtAfterBuild(chart, type, overrides);
    return chart;
  } catch (_) {
    return null;
  }
}
