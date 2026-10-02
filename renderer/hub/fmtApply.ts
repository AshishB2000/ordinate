// Formatting depth, applied to ONE Chart.js config — the pass buildChart runs
// after the family modules have built their datasets and axes:
//
//   fmtResolve  (before the datasets) — series colours into the palette, and the
//               per-category colours from the project's map;
//   fmtApply    (after the datasets and axes) — category colours onto the marks,
//               the dual axis and which measures sit on it, per-axis range /
//               log / number format / tick density / hide, and value palettes.
//
// Everything reads the visual's own `overrides` (validated in main by
// src/analysis/chartFormat.ts) and nothing here computes a figure: a log axis,
// a min, a colour ramp are all ways of DRAWING numbers the app already has.
// The one data-dependent rule main cannot check lives here: a log axis over a
// measure with a zero or a negative in it is drawn linear instead.
//
// buildChart calls both through `typeof` guards, so the chart harnesses that
// load only the family scripts (scripts/test-chart*.ts) draw exactly as before.
//
// Classic global-scope renderer <script>: no import/export.

/** Mirrors chartFormat.DUAL_AXIS_TYPES — scripts/test-chartFormat.ts pins the two together. */
const FMT_DUAL_AXIS_TYPES = new Set(['combo', 'line', 'line_markers', 'area', 'column', 'clustered_column']);

type FmtRole = 'value' | 'category' | null;

/** Which physical axis carries values on this chart type, and whether a right axis is offered. */
function fmtAxisRoles(type: string): { x: FmtRole; y: FmtRole; y2: boolean } {
  const s = resolveChartType(type);
  if (s.isRound || s.isGauge || s.isTreemap || s.isSankey || s.isRadar || s.isCalendar || s.isPivot || s.isWordCloud) {
    return { x: null, y: null, y2: false };
  }
  if (s.isMatrix) return { x: 'category', y: 'category', y2: false };
  if (s.isFunnel) return { x: null, y: 'category', y2: false };
  if (s.isScatter || s.isBubble) return { x: 'value', y: 'value', y2: false };
  if (s.isHoriz) return { x: 'value', y: 'category', y2: false };
  return { x: 'category', y: 'value', y2: FMT_DUAL_AXIS_TYPES.has(type) };
}

/** Does this chart paint one colour per CATEGORY (so the project's map applies to its labels)? */
function fmtColorsByCategory(type: string, series: ChartSeriesShape[], overrides: any): boolean {
  const s = resolveChartType(type);
  if ((s.isRound && !s.isGauge) || s.isTreemap || s.isFunnel || s.isSankey || s.isWordCloud) return true;
  const one = series.filter((x) => x.role !== 'overlay').length === 1;
  return !!(overrides && overrides.colorByCategory) && one && s.chartType === 'bar'
    && !s.isHistogram && !s.isWaterfall && !s.isBullet && !s.isPareto && !s.opts.combo;
}

/**
 * Series colours INTO `palette`, in place: palette[i] becomes series i's colour.
 * A split series (the encoding's `series` column) takes the project's map;
 * measure series take the visual's own `seriesColors`. Returns the palette.
 */
function fmtSeriesPalette(series: ChartSeriesShape[], overrides: any, palette: string[]): string[] {
  const base = palette.slice();
  const scope = fmtScopeOf(overrides);
  const real = series.filter((s) => s.role !== 'overlay');
  const split = scope && scope.series ? fmtTokensFor(scope.series, real.map((s) => s.name)) : null;
  const own = overrides && overrides.seriesColors;
  if (!split && !own) return palette;
  for (let i = palette.length; i < series.length; i++) palette[i] = base[i % base.length];
  let k = 0;
  series.forEach((s, i) => {
    if (s.role === 'overlay') return;
    const tok = split ? split[k++] : own[String(s.name)];
    if (tok) palette[i] = fmtHex(tok, base);
  });
  return palette;
}

/**
 * The pass before the datasets: series colours into `palette`, and — for a
 * chart that colours by category — one colour per label, or null to keep the
 * family's own palette walk.
 */
function fmtResolve(
  labels: any[], series: ChartSeriesShape[], overrides: any, palette: string[], type: string,
): string[] | null {
  const base = palette.slice();
  fmtSeriesPalette(series, overrides, palette);
  if (!fmtColorsByCategory(type, series, overrides)) return null;
  const scope = fmtScopeOf(overrides);
  const tokens = scope && scope.category ? fmtTokensFor(scope.category, labels) : null;
  if (!tokens && !(overrides && overrides.colorByCategory)) return null;
  return labels.map((_, i) => (tokens && tokens[i] ? fmtHex(tokens[i], base) : base[i % base.length]));
}

/** The numbers drawn against one axis, for the log-scale check. */
function fmtAxisNumbers(datasets: any[], axis: 'x' | 'y' | 'y1', horiz: boolean): number[] {
  const out: number[] = [];
  datasets.forEach((ds) => {
    if (!ds || ds._overlay) return;
    const onRight = ds.yAxisID === 'y1';
    if ((axis === 'y1') !== onRight && !(axis === 'x' && horiz)) return;
    (Array.isArray(ds.data) ? ds.data : []).forEach((p: any) => {
      const v = typeof p === 'number' ? p : p && typeof p === 'object' ? (axis === 'x' ? p.x : p.y) : null;
      if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    });
  });
  return out;
}

/** A log axis needs every value above zero — and something to draw. */
function fmtLogOk(nums: number[], f: any): boolean {
  return nums.length > 0 && nums.every((v) => v > 0) && !(typeof f.min === 'number' && f.min <= 0);
}

/** The right-hand value axis, built like the combo chart's. */
function fmtRightAxis(c: ChartCtx): any {
  return {
    position: 'right',
    ticks: { color: c.textColor, font: c.tickFont, padding: 6, callback: (v: any) => c.fmt(v) },
    grid: { drawOnChartArea: false, display: false },
    border: { display: false },
  };
}

function fmtAxis(c: ChartCtx, sc: any, f: any, role: FmtRole, nums: number[]): void {
  if (!sc || !f || !role) return;
  if (f.hide) sc.display = false;
  if (f.ticks) {
    sc.ticks = sc.ticks || {};
    sc.ticks.autoSkip = true;
    sc.ticks.maxTicksLimit = f.ticks === 'few' ? 4 : 16;
  }
  if (role !== 'value' || c.opts.pct) return;
  if (f.format) {
    sc.ticks = sc.ticks || {};
    sc.ticks.callback = (v: any) => fmtWith(v, f.format);
  }
  if (typeof f.min === 'number') { sc.min = f.min; sc.beginAtZero = false; }
  if (typeof f.max === 'number') sc.max = f.max;
  if (f.log && fmtLogOk(nums, f)) {
    sc.type = 'logarithmic';
    delete sc.beginAtZero;
    if (sc.min === 0) delete sc.min;
  }
}

/** Category colours onto whichever marks this family paints per category. */
function fmtPaintCategories(c: ChartCtx, datasets: any[], cat: string[]): void {
  const byLabel = new Map<string, string>();
  c.labels.forEach((l: any, i: number) => byLabel.set(String(l), cat[i]));
  const ds0 = datasets[0];
  if (!ds0) return;
  if (c.isRound && !c.isGauge) ds0.backgroundColor = cat;
  else if (c.isTreemap) {
    ds0.backgroundColor = (ctx: ChartJsCtx) => {
      const d = ctx.type === 'data' && ctx.raw && ctx.raw._data;
      return d ? byLabel.get(String(d._label)) || cat[0] : 'transparent';
    };
  } else if (c.isFunnel && datasets[1]) datasets[1].backgroundColor = cat;
  else if (c.isSankey) {
    ds0.colorFrom = (ctx: ChartJsCtx) => {
      const f = ctx.dataset && ctx.dataset.data && ctx.dataset.data[ctx.dataIndex];
      return (f && byLabel.get(String(f.from))) || cat[0];
    };
  } else {
    const real = datasets.find((d) => !d._overlay);
    if (!real) return;
    const grads = cat.map((col) => makeBarGradient(col, c.isHoriz));
    real.backgroundColor = (ctx: ChartJsCtx) => (grads[ctx.dataIndex] ? grads[ctx.dataIndex](ctx) : cat[0]);
  }
}

/** Colour a measure's bars (or a heatmap's cells) by value along a ramp from the accent. */
function fmtPaintValues(c: ChartCtx, datasets: any[], palettes: Record<string, string>): void {
  const accent = getCSSVar('--accent', c.canvas) || c.palette[0];
  const rampOf = (kind: string) => valueRamp(kind, accent, c.surfColor);
  const range = (vals: any[]) => {
    const nums = vals.filter((v) => typeof v === 'number' && Number.isFinite(v));
    return nums.length ? [nums.reduce((a, b) => (b < a ? b : a)), nums.reduce((a, b) => (b > a ? b : a))] : null;
  };
  if (c.isMatrix) {
    const kind = Object.keys(palettes).map((k) => palettes[k])[0];
    const ds = datasets[0];
    const r = ds && range((ds.data || []).map((p: any) => p && p.v));
    if (!kind || !r) return;
    const ramp = rampOf(kind);
    ds.backgroundColor = (ctx: ChartJsCtx) => {
      const v = ctx.raw && ctx.raw.v;
      return typeof v === 'number' ? rampColor(ramp, kind, v, r[0], r[1]) : c.gridColor;
    };
    return;
  }
  if (c.chartType !== 'bar' || c.isFunnel || c.isHistogram || c.isWaterfall || c.isBullet) return;
  datasets.forEach((ds) => {
    const kind = ds && !ds._overlay && ds.type !== 'line' ? palettes[ds.label] : '';
    const r = kind ? range(ds.data || []) : null;
    if (!kind || !r) return;
    const ramp = rampOf(kind);
    ds.backgroundColor = (ds.data as any[]).map((v) => (typeof v === 'number' ? rampColor(ramp, kind, v, r[0], r[1]) : 'transparent'));
  });
}

/** The pass after the datasets and axes. Mutates both. */
function fmtApply(c: ChartCtx, datasets: any[], scales: any, cat: string[] | null, type: string): void {
  const ov = c.overrides || {};
  if (cat) fmtPaintCategories(c, datasets, cat);

  const roles = fmtAxisRoles(type);
  // Dual axis: which measures sit on the right. Absent = the chart's own
  // default (a combo's lines on the right); a list — even an empty one — is
  // the author's assignment.
  if (roles.y2 && Array.isArray(ov.y2Series)) {
    const right = new Set(ov.y2Series.map(String));
    let any = false;
    datasets.forEach((ds) => {
      if (!ds || ds._overlay) return;
      ds.yAxisID = right.has(String(ds.label)) ? 'y1' : 'y';
      if (ds.yAxisID === 'y1') any = true;
    });
    if (any) scales.y1 = scales.y1 || fmtRightAxis(c);
    else delete scales.y1;
  }
  if (scales.y1 && ov.y2AxisLabel) {
    scales.y1.title = { display: true, text: ov.y2AxisLabel, color: c.textColor, font: c.tickFont };
  }

  const axes = ov.axes || {};
  fmtAxis(c, scales.x, axes.x, roles.x, fmtAxisNumbers(datasets, 'x', c.isHoriz || c.isScatter || c.isBubble));
  fmtAxis(c, scales.y, axes.y, roles.y, fmtAxisNumbers(datasets, 'y', false));
  if (scales.y1) fmtAxis(c, scales.y1, axes.y2, 'value', fmtAxisNumbers(datasets, 'y1', false));

  if (ov.measurePalettes && typeof ov.measurePalettes === 'object' && Object.keys(ov.measurePalettes).length) {
    fmtPaintValues(c, datasets, ov.measurePalettes);
  }
}

/**
 * The colours an exported dashboard draws a live chart with, as RAMP SLOTS
 * (0–7) — the export has its own ramp (its style's), so a slot is what carries
 * over, the same way 'chart-3' does in the app. Per label for a chart that
 * colours by category; per series otherwise.
 */
function fmtExportSlots(type: string, visual: any, data: any): { slots?: number[]; seriesSlots?: number[] } {
  const enc = (visual && visual.encoding) || {};
  const ov = fmtWithScope((visual && visual.overrides) || {}, { projectId: currentProjectId, encoding: enc });
  const labels = Array.isArray(data && data.labels) ? data.labels : [];
  const series: ChartSeriesShape[] = chartSeries(data);
  const out: { slots?: number[]; seriesSlots?: number[] } = {};
  const slot = (tok: string | null, i: number) => (tok ? OrdColorMap.slotIndex(tok) : i % 8);
  if (fmtColorsByCategory(type, series, ov) && enc.category) {
    const toks = fmtTokensFor(enc.category, labels);
    if (toks) out.slots = labels.map((_: any, i: number) => slot(toks[i], i));
  }
  const split = enc.series ? fmtTokensFor(enc.series, series.map((s) => s.name)) : null;
  const own = ov.seriesColors || {};
  if (split || Object.keys(own).length) {
    out.seriesSlots = series.map((s, i) => slot(split ? split[i] : own[String(s.name)] || null, i));
  }
  return out;
}
