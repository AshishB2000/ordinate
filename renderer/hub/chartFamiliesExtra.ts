// Five chart families — waterfall, bullet, calendar heatmap, radar, Pareto —
// in their own module: their Chart.js datasets, axes, tooltip callbacks and the
// few chart options they need. What they DRAW by hand (connectors, bands, the
// 80% marker, the calendar's labels) is chartFamiliesPlugins.js.
//
// WHY BESIDE the four family modules rather than inside them:
// scripts/test-chartSpec.ts freezes every older chart id's full config,
// function SOURCE included, so a sixth branch threaded through a shared closure
// would move 84 frozen hashes to add five charts. Instead buildChartDatasets,
// buildChartScales and buildChartPlugins each ask isExtraFamily() FIRST and hand
// over, and chartRender asks this file for the tooltip callbacks and options —
// so every older config is byte-identical and the new ids have their own
// golden entries.
//
// Every figure comes from chartShapes.js (pure, Node-tested) and is left on
// `opts` (_wf, _pareto, _bullet, _cal/_calLay, _radar) by the dataset builder
// for the plugins and tooltips to read — the same channel the older families
// use. Every colour is read off the canvas (getCSSVar), so themes and dashboard
// presets restyle these exactly as they do the rest.
//
// Loads after chartShapes.js/chartTypeSpec.js and before chartDatasets.js
// (index.html). Classic global-scope script — NO import/export.

function isExtraFamily(s: ChartTypeSpec): boolean {
  return s.isWaterfall || s.isBullet || s.isCalendar || s.isRadar || s.isPareto;
}

// Below this canvas width a chart is a thumbnail or a small tile: the calendar
// drops its month/weekday labels and legend, the Pareto marker its caption.
const EXTRA_FULL_MIN_W = 280;
const CAL_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** '#rrggbb' + alpha. A token that is not six-digit hex is returned as-is. */
function xAlpha(color: string, f: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  return color + Math.round(Math.max(0, Math.min(1, f)) * 255).toString(16).padStart(2, '0');
}

// The calendar's label room around the grid: weekday names left, month names
// above, the legend below. None of it on a thumbnail.
function calPad(full: boolean): { l: number; r: number; t: number; b: number } {
  return full ? { l: 30, r: 8, t: 18, b: 30 } : { l: 2, r: 2, t: 2, b: 2 };
}

// ── Datasets ────────────────────────────────────────────────────────────────
// null = nothing drawable (a calendar over labels that are not dates) — buildChart
// returns null and the surface shows its "couldn't draw" message instead of a
// blank canvas.
function buildExtraDatasets(c: ChartCtx): { datasets: any[]; chartLabels: any[] } | null {
  const { canvas, labels, series, opts, overrides, palette, gridColor, surfColor } = c;

  if (c.isWaterfall) {
    const w = waterfallSteps(labels, series, overrides.waterfallTotals);
    const up = getCSSVar('--ok', canvas) || '#16a34a';
    const down = getCSSVar('--error', canvas) || '#dc2626';
    const colors = w.kind.map((k) => (k === 'up' ? up : k === 'down' ? down : palette[0]));
    opts._wf = w;
    opts._wfColors = colors;
    return {
      chartLabels: w.labels,
      datasets: [{
        label: series[0].name || '',
        data: w.base.map((b, i) => [b, b + w.delta[i]]),
        backgroundColor: colors.map((col, i) => (w.kind[i] === 'up' || w.kind[i] === 'down' ? xAlpha(col, 0.88) : col)),
        borderWidth: 0, borderRadius: 3, borderSkipped: false,
        barPercentage: 0.72, categoryPercentage: 0.88,
      }],
    };
  }

  if (c.isPareto) {
    const p = paretoShape(labels, series[0].values);
    opts._pareto = p;
    opts._paretoLine = palette[1] || palette[0];
    return {
      chartLabels: p.labels,
      datasets: [
        {
          label: series[0].name || '',
          data: p.values,
          backgroundColor: makeBarGradient(palette[0], false),
          borderWidth: 0, borderRadius: 5, barPercentage: 0.7, categoryPercentage: 0.86, order: 2,
        },
        {
          type: 'line',
          label: t('chartFamiliesExtra.cumulative'),
          data: p.cumPct,
          yAxisID: 'y1',
          borderColor: opts._paretoLine, backgroundColor: opts._paretoLine,
          borderWidth: 2, tension: 0, fill: false, order: 1,
          // Past ~24 categories the markers crowd the line; the ring still marks 80%.
          pointRadius: p.labels.length > 24 ? 0 : 2.5, pointHoverRadius: 4.5,
          pointBackgroundColor: surfColor, pointBorderColor: opts._paretoLine, pointBorderWidth: 1.5,
        },
      ],
    };
  }

  if (c.isBullet) {
    const b = bulletShape(labels, series, typeof overrides.bulletTarget === 'number' ? overrides.bulletTarget : null);
    opts._bullet = b;
    return {
      chartLabels: labels,
      datasets: [{
        label: series[0].name || '',
        data: b.rows.map((r) => r.value),
        backgroundColor: palette[0],
        borderWidth: 0, borderRadius: 2,
        barPercentage: 0.3, categoryPercentage: 1, maxBarThickness: 12,
      }],
    };
  }

  if (c.isCalendar) {
    const cal = calendarCells(labels, series[0].values);
    if (!cal) return null;
    // Band the strip for the box it will fill. The size is the container's as
    // laid out NOW (Chart.js sizes to the same parent); unknown (0) means one
    // band, and the layout padding keeps the cells square on any later resize.
    const host = canvas.parentElement;
    const W = host ? host.clientWidth : 0;
    const H = host ? host.clientHeight : 0;
    const gap = W && W < EXTRA_FULL_MIN_W ? 0.8 : 2;
    const p = calPad(W >= EXTRA_FULL_MIN_W);
    const lay = calendarBands(cal.weeks, W - p.l - p.r, H - p.t - p.b - (overrides.title ? 26 : 0), gap);
    const span = cal.max - cal.min;
    // Empty days are the border token, filled days the first chart colour on an
    // alpha ramp — the GitHub reading, and the same idea as the heatmap's cells.
    const heat = (v: number | null): string => (v === null ? gridColor
      : xAlpha(palette[0], 0.16 + 0.84 * (span ? (v - cal.min) / span : 1)));
    // A square cell with a gap that scales with it, sized off the live chart area.
    const cell = (ctx: ChartJsCtx): number => {
      const a = ctx.chart.chartArea;
      if (!a) return 8;
      const s = Math.min(a.width / lay.perRow, a.height / lay.rows);
      return Math.max(1, s - Math.max(1, Math.min(3, s * 0.16)));
    };
    opts._cal = cal;
    opts._calLay = Object.assign(lay, { gap });
    opts._calHeat = heat;
    return {
      // Index-aligned with the cells, so a click resolves to the day it hit.
      chartLabels: cal.cells.map((k) => k.date),
      datasets: [{
        label: series[0].name || '',
        data: cal.cells.map((k) => ({
          x: k.week % lay.perRow,
          y: Math.floor(k.week / lay.perRow) * (7 + gap) + k.weekday,
          v: k.v, d: k.date, wd: k.weekday,
        })),
        backgroundColor: (ctx: ChartJsCtx) => heat(ctx.raw ? ctx.raw.v : null),
        borderWidth: 0,
        borderRadius: (ctx: ChartJsCtx) => (cell(ctx) > 9 ? 2 : 1),
        width: cell,
        height: cell,
      }],
    };
  }

  // Radar
  const r = radarShape(labels, series);
  const cols = interpolatePalette(palette, r.datasets.length);
  // Fills stack toward the centre; past three polygons they would muddy it.
  const fillA = r.datasets.length > 3 ? 0.08 : 0.14;
  opts._radar = r;
  return {
    chartLabels: r.axes,
    datasets: r.datasets.map((d, i) => ({
      label: d.label,
      data: d.norm,
      _raw: d.raw,
      borderColor: cols[i], backgroundColor: xAlpha(cols[i], fillA), fill: true,
      borderWidth: 1.8, spanGaps: true,
      pointRadius: 2.5, pointHoverRadius: 4.5,
      pointBackgroundColor: cols[i], pointBorderColor: surfColor, pointBorderWidth: 1,
    })),
  };
}

// ── Axes ────────────────────────────────────────────────────────────────────
// The two axis makers are buildChartScales' own, passed in, so these families
// share the app's tick format, gridlines and "County" trim to the character.
function buildExtraScales(
  c: ChartCtx,
  makeValueAxis: (stacked: boolean, pct: boolean) => any,
  makeCategoryAxis: (stacked: boolean, rotate: boolean) => any,
): any {
  const { opts, textColor, gridColor, tickFont, fontFamily } = c;
  if (c.isCalendar) {
    // Hidden linear axes, one unit per week column / weekday row; the labels
    // are chartFamiliesPlugins' calendarFrame, drawn into the layout padding.
    return {
      x: { type: 'linear', display: false, offset: false, min: -0.5, max: opts._calLay.perRow - 0.5 },
      y: { type: 'linear', display: false, offset: false, min: -0.5, max: opts._calLay.rows - 0.5, reverse: true },
    };
  }
  if (c.isRadar) {
    return {
      r: {
        min: opts._radar.anyNegative ? -1 : 0, max: 1,
        ticks: { display: false, stepSize: 0.25 },
        // Always on: a radar's rings are how its polygons are read, not decoration.
        grid: { color: gridColor },
        angleLines: { color: gridColor },
        pointLabels: {
          color: textColor, padding: 6, font: { family: fontFamily, size: 10, weight: '500' },
          callback: (l: string) => (l.length > 24 ? l.slice(0, 23) + '…' : l),
        },
      },
    };
  }
  if (c.isBullet) {
    return {
      x: Object.assign(makeValueAxis(false, false), { suggestedMax: opts._bullet.max }),
      y: makeCategoryAxis(false, false),
    };
  }
  const scales: any = { x: makeCategoryAxis(false, true), y: makeValueAxis(false, false) };
  if (c.isPareto) {
    scales.y1 = {
      position: 'right', min: 0, max: 100,
      ticks: { color: textColor, font: tickFont, padding: 6, stepSize: 20, callback: (v: any) => v + '%' },
      grid: { drawOnChartArea: false, display: false },
      border: { display: false },
    };
  }
  return scales;
}

// ── Tooltips ────────────────────────────────────────────────────────────────
// Added onto the shared tooltip config; the swatch is the mark's own colour.
function applyExtraTooltip(c: ChartCtx, tv: any): void {
  const { opts, fmt, palette } = c;
  const swatch = (color: string) => ({ borderColor: color, backgroundColor: color, borderWidth: 0, borderRadius: 2 });
  const cb = tv.callbacks;
  if (c.isWaterfall) {
    const w = opts._wf;
    cb.label = (item: ChartJsCtx) => {
      const i = item.dataIndex, d = w.delta[i];
      return w.kind[i] === 'up' || w.kind[i] === 'down'
        ? `${d > 0 ? '+' : ''}${fmt(d)}  →  ${fmt(w.running[i])}` : fmt(d);
    };
    cb.labelColor = (item: ChartJsCtx) => swatch(opts._wfColors[item.dataIndex]);
  } else if (c.isPareto) {
    cb.label = (item: ChartJsCtx) => (item.datasetIndex === 1
      ? t('chartFamiliesExtra.cumulative_2', { p0: Number(item.raw).toFixed(1) })
      : (item.dataset.label ? item.dataset.label + ': ' : '') + fmt(item.raw));
    cb.labelColor = (item: ChartJsCtx) => swatch(item.datasetIndex === 1 ? opts._paretoLine : palette[0]);
  } else if (c.isBullet) {
    cb.label = (item: ChartJsCtx) => {
      const r = opts._bullet.rows[item.dataIndex];
      if (!r || r.value === null) return 'n/a';
      if (r.target === null) return fmt(r.value);
      const pct = r.target ? ` (${Math.round((r.value / r.target) * 100)}%)` : '';
      return t('chartFamiliesExtra.of_target', { value: fmt(r.value), target: fmt(r.target), pct });
    };
  } else if (c.isCalendar) {
    cb.title = (items: ChartJsCtx[]) => { const r = items[0] && items[0].raw; return r ? `${CAL_WEEKDAYS[r.wd]} ${r.d}` : ''; };
    cb.label = (item: ChartJsCtx) => (item.raw && typeof item.raw.v === 'number' ? fmt(item.raw.v) : t('chartFamiliesExtra.no_data'));
    cb.labelColor = (item: ChartJsCtx) => swatch(opts._calHeat(item.raw ? item.raw.v : null));
  } else if (c.isRadar) {
    // The polygon is normalised; the figure shown is the raw one.
    cb.label = (item: ChartJsCtx) => {
      const v = item.dataset._raw && item.dataset._raw[item.dataIndex];
      return `${item.dataset.label}: ${typeof v === 'number' ? fmt(v) : 'n/a'}`;
    };
    cb.labelColor = (item: ChartJsCtx) => swatch(item.dataset.borderColor);
  }
}

// ── Chart options ───────────────────────────────────────────────────────────
// Spread into buildChart's options after `layout`. {} for every other id.
function extraChartOptions(c: ChartCtx): any {
  if (c.isPareto) return { interaction: { mode: 'index', intersect: false } };
  if (c.isRadar) return { interaction: { mode: 'nearest', intersect: false } };
  if (!c.isCalendar) return {};
  const lay = c.opts._calLay;
  const titleH = c.overrides.title ? 26 : 0;
  return {
    interaction: { mode: 'nearest', intersect: true },
    // Padding sized so the chart area is exactly perRow × rows SQUARE cells,
    // centred, with the label room calPad reserves around it. Scriptable, so it
    // re-resolves on every resize.
    layout: {
      padding: (ctx: ChartJsCtx) => {
        const W = ctx.chart.width || 0, H = ctx.chart.height || 0;
        const p = calPad(W >= EXTRA_FULL_MIN_W);
        const cell = Math.max(2, Math.min((W - p.l - p.r) / lay.perRow, (H - p.t - p.b - titleH) / lay.rows, 30));
        const exX = Math.max(0, W - p.l - p.r - cell * lay.perRow);
        const exY = Math.max(0, H - p.t - p.b - titleH - cell * lay.rows);
        return { left: p.l + exX / 2, right: p.r + exX / 2, top: p.t + exY / 2, bottom: p.b + exY / 2 };
      },
    },
  };
}
