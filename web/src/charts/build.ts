// buildChart — resolve the chart id, read the theme off the canvas, and
// assemble the ONE Chart.js config the family modules fill in
// (the desktop's chartRender.ts). Pure: it returns the config instead of
// constructing Chart.js, so the <Chart> component owns the instance and
// legacy.test.ts can compare this config with the desktop's, id by id.
//
// The family modules run in a fixed order and it is not cosmetic:
// buildChartDatasets writes per-family state onto `opts` (_gaugeValue,
// _matrixCols/_matrixGrid, _funnelMax/_funnelVals) that buildChartScales and
// buildChartPlugins then read.
//
// The project colour map and Format → Colours are ./fmtApply (T2.7). Not
// ported here: dashboard linked hover and its transitions (lhPlugin /
// mtPlugin — the dashboard grid, T2.9; <Chart> already animates an update). The
// desktop guards every one with `typeof … === 'function'`, so without them it
// builds exactly this config.

import { annDrawable, annExtent, annotationsPlugin, annWanted, type AnnCommentPin } from './annotations';
import { buildChartDatasets } from './datasets';
import { evDrawable, eventsPlugin } from './events';
import { applyExtraTooltip, extraChartOptions, isExtraFamily } from './familiesExtra';
import { fmtApply, fmtResolve } from './fmtApply';
import { fmtVal, fmtWith, tcAxisFmt, tcTooltip } from './format';
import { CHART_PALETTE, getCSSVar, paletteFromSeed } from './palette';
import { buildChartScales } from './scales';
import { t } from './strings';
import { legendOnByDefault } from './traits';
import { resolveChartType } from './typeSpec';
import type { ChartCtx, ChartDataShape, ChartSeriesShape, Cx, Overrides } from './types';
import { buildChartPlugins } from './valueLabels';
import type { WcTheme } from './wordCloud';

/**
 * The chart types a period overlay is drawn on. Everywhere else a comparison
 * series would be read as a real category — a pie slice, a stacked segment —
 * so buildChart drops it rather than draw something that means something else.
 */
export const CHART_OVERLAY_TYPES = new Set(['line', 'area', 'line_markers', 'column', 'clustered_column', 'bar', 'clustered_bar']);

/** What buildChart decided: a Chart.js config, or a word cloud (wordCloud.ts draws it, no Chart.js). */
export type BuiltChart =
  | { kind: 'chartjs'; config: { type: string; data: { labels: Cx[]; datasets: Cx[] }; plugins: Cx[]; options: Cx } }
  | { kind: 'wordCloud'; labels: Cx[]; series: ChartSeriesShape[]; overrides: Overrides; theme: WcTheme };

// ── Motion: THE one Chart.js animation config ───────────────────────────────
// Every chart this file builds animates by these numbers, and a dashboard
// transition (motion.ts) steps through the `mtStep` half of it when bars leave
// and the rest slide. prefers-reduced-motion is read LIVE — flipping it in the
// OS turns the next draw and the next transition into an instant swap without
// a reload. noAnimate (export, thumbnails, reports) always gets the final frame.
export const CHART_MOTION_MS = 300;
// A MediaQueryList's `matches` is live, so reading it per draw IS listening.
let chartMotionQuery: MediaQueryList | null = null;

export function chartMotionReduced(): boolean {
  chartMotionQuery ??= window.matchMedia('(prefers-reduced-motion: reduce)');
  return chartMotionQuery.matches;
}

export function chartAnimation(overrides: Cx): Cx {
  return overrides.noAnimate || chartMotionReduced() ? false : { duration: CHART_MOTION_MS, easing: 'easeOutCubic' };
}

// The plottable series for a chart: those with a non-empty values array.
// buildChart and the period dropdown share this so hidden-series indices align.
export function chartSeries(data: ChartDataShape | null | undefined): ChartSeriesShape[] {
  return Array.isArray(data && data.series)
    ? data!.series!.filter((s: ChartSeriesShape) => Array.isArray(s.values) && s.values.length > 0)
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

export function asMonthLabels(labels: Cx[]): Cx[] {
  const parsed = labels.map((l) => (typeof l === 'string' ? FIRST_OF_MONTH_RE.exec(l.trim()) : null));
  if (parsed.some((m) => !m)) return labels;
  return parsed.map((m: Cx) => new Date(Date.UTC(+m[1], +m[2] - 1, 1))
    .toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' }));
}

// The config for the given data + type id, or null when there is nothing to
// draw (no labels, no series, a calendar without dates). `canvas` must be in
// the document: the theme tokens are read off it.
// overrides: optional per-chart customization { title, color, valueMode, hiddenSeries,
//            showLegend, showGridlines, xAxisLabel, yAxisLabel, … }
//            (legacy showValues:true is still read as valueMode 'all')
export function buildChart(
  canvas: HTMLCanvasElement | null,
  data: ChartDataShape,
  type: string,
  overrides?: Overrides,
): BuiltChart | null {
  overrides = overrides || {};
  let labels = asMonthLabels(Array.isArray(data.labels) ? data.labels : []);
  let series = chartSeries(data);
  if (!CHART_OVERLAY_TYPES.has(type)) series = series.filter((s: ChartSeriesShape) => s.role !== 'overlay');
  if (!labels.length || !series.length || !canvas) return null;

  // Number formatter for display (axis ticks, value labels, tooltips). When the
  // `numberFormat` override is absent, fmt === _fmtVal, so output is byte-identical
  // to before this control existed (the capture flow never sets numberFormat).
  // A calculated series (table calculations, calcMenu.ts) formats as its kind.
  const fmt = tcAxisFmt(series, overrides.numberFormat ? (v: Cx) => fmtWith(v, overrides.numberFormat) : fmtVal);

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
  if (spec.isWordCloud) return { kind: 'wordCloud', labels, series, overrides, theme: { palette, fmt, textColor, titleColor, fontFamily, surfColor } };

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
  const rawLabels: Cx[] = Array.isArray(data.labels) ? data.labels : [];
  if (canSort && (overrides.sort === 'asc' || overrides.sort === 'desc' || byLabel || overrides.sort === 'custom')) {
    const totals = labels.map((_: Cx, i: number) =>
      series.reduce((sum: number, s: ChartSeriesShape) => sum + (typeof s.values[i] === 'number' ? s.values[i] : 0), 0));
    const rank = new Map<string, number>();
    (Array.isArray(overrides.sortOrder) ? overrides.sortOrder : []).forEach((l: Cx, k: number) => rank.set(String(l), k));
    const pos = (i: number) => (rank.has(String(rawLabels[i])) ? rank.get(String(rawLabels[i]))! : rank.size + i);
    const order = labels.map((_: Cx, i: number) => i).sort((a: number, b: number) => {
      if (overrides.sort === 'custom') return pos(a) - pos(b);
      if (byLabel) {
        const d = String(rawLabels[a]).localeCompare(String(rawLabels[b]), undefined, { numeric: true });
        return overrides.sort === 'label_asc' ? d : -d;
      }
      return overrides.sort === 'asc' ? totals[a] - totals[b] : totals[b] - totals[a];
    });
    labels = order.map((i: number) => labels[i]);
    series = series.map((s: ChartSeriesShape) => Object.assign({}, s, { values: order.map((i: number) => s.values[i]) },
      Array.isArray(s.raw) ? { raw: order.map((i: number) => s.raw![i]) } : {}));
    sortOrder = order;
  }

  // ── Analytics overlays + comment pins (chartAnnotations.js) ───────────────
  // Resolved in main and carried on `data.analytics`; only the kinds this type
  // draws (spec.overlayKinds). A forecast needs room PAST the last category, so
  // the axis grows by its periods and every series is padded with gaps there.
  const annOverlays = annDrawable(Array.isArray((data as Cx).analytics) ? (data as Cx).analytics : [], spec, !!sortOrder);
  const annPins: AnnCommentPin[] = Array.isArray(overrides.commentPins) ? overrides.commentPins : [];
  const annBase = { labels: Array.isArray(data.labels) ? data.labels : [], series: Array.isArray(data.series) ? data.series : [] };
  const annForecast = annOverlays.reduce((best: string[], o: Cx) =>
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

  // Formatting depth (./fmtApply, T2.7): series colours into the palette, and
  // the project's colour per category.
  const fmtCat = fmtResolve(labels, series, overrides, palette, type);

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
  fmtApply(c, datasets, scales, fmtCat, type);
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
  const tooltipConfig: Cx = {
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
      labelColor: (ctx: Cx) => {
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
    tooltipConfig.callbacks.title = (items: Cx[]) => { const r = items[0] && items[0].raw; return r ? `${r.y} · ${r.x}` : ''; };
    tooltipConfig.callbacks.label = (item: Cx) => { const r = item.raw; return r && typeof r.v === 'number' ? fmt(r.v) : 'n/a'; };
  }
  if (isTreemap) {
    tooltipConfig.callbacks.title = (items: Cx[]) => { const d = items[0] && items[0].raw && items[0].raw._data; return d ? String(d._label) : ''; };
    tooltipConfig.callbacks.label = (item: Cx) => { const d = item.raw && item.raw._data; return d ? fmt(d.value) : ''; };
  }
  if (isFunnel) {
    tooltipConfig.filter = (item: Cx) => item.datasetIndex !== 0;   // hide the spacer stack
    tooltipConfig.callbacks.label = (item: Cx) => {
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
  const evMarks = evDrawable(data, spec, !!sortOrder, overrides);
  if (evMarks.length) inlinePlugins.push(eventsPlugin({ events: evMarks, fontFamily, isStatic: !!overrides.devicePixelRatio }));

  // ── Series filter (period multi-select) ────────────────────────────────────
  // Hide deselected series. Indices align with `series` (both use chartSeries()).
  // Guard skips single-dataset types (pie/scatter/bubble/…) where 1 dataset ≠ N series.
  const hiddenSeries = new Set(Array.isArray(overrides.hiddenSeries) ? overrides.hiddenSeries : []);
  // Not the extra families: a radar's datasets are CATEGORIES, and a matching
  // count there would hide a polygon by a series index.
  if (hiddenSeries.size && datasets.length === series.length && !isExtraFamily(spec)) {
    datasets.forEach((ds: Cx, i: number) => { if (hiddenSeries.has(i)) ds.hidden = true; });
  }

  // ── The config ───────────────────────────────────────────────────────────
  return {
    kind: 'chartjs',
    config: {
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
              generateLabels(chart: Cx) {
                // The chart's own class carries Chart.js's statics (overrides, defaults).
                const ChartJs = chart.constructor;
                const gen = ChartJs.overrides?.[chart.config.type]?.plugins?.legend
                  ?.labels?.generateLabels
                  || ChartJs.defaults.plugins.legend.labels.generateLabels;
                const items = gen(chart);
                items.forEach((it: Cx) => {
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
    },
  };
}
