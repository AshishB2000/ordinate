// Formatting depth, applied to ONE Chart.js config (the desktop's fmtApply.ts +
// the drawing half of fmtColors.ts) — the pass buildChart runs around the
// family modules:
//
//   fmtResolve  (before the datasets) series colours into the palette, and the
//               per-category colours from the project's colour map
//   fmtApply    (after the datasets and axes) category colours onto the marks,
//               the dual axis and which measures sit on it, per-axis range /
//               log / number format / tick density / hide, value palettes
//
// Everything reads the visual's `overrides` (validated in main by
// src/analysis/chartFormat.ts) and nothing here computes a figure: a log axis,
// a min, a colour ramp are ways of DRAWING numbers the app already has.
//
// The project's colour map arrives on `overrides._colorScope` ({category,
// series, map}) from the screen that knows which columns the chart reads;
// tokens are DEALT here by the shared pure rule (src/analysis/colorMap.ts) —
// the screen persists a new deal through `format:colors:assign`.

import { assignColors, isColorToken, slotIndex, type ColorMap } from '../../../src/analysis/colorMap.ts';
import { fmtWith } from './format';
import { makeBarGradient } from './paint';
import { getCSSVar, rampColor, valueRamp } from './palette';
import { resolveChartType } from './typeSpec';
import type { ChartCtx, ChartSeriesShape, Cx } from './types';

/** Mirrors chartFormat.DUAL_AXIS_TYPES. */
const DUAL_AXIS_TYPES = new Set(['combo', 'line', 'line_markers', 'area', 'column', 'clustered_column']);

export type FmtRole = 'value' | 'category' | null;

export interface ColorScope {
  category: string;
  series: string;
  map: ColorMap;
}

/** Which physical axis carries values on this chart type, and whether a right axis is offered. */
export function fmtAxisRoles(type: string): { x: FmtRole; y: FmtRole; y2: boolean } {
  const s = resolveChartType(type);
  if (s.isRound || s.isGauge || s.isTreemap || s.isSankey || s.isRadar || s.isCalendar || s.isPivot || s.isWordCloud) {
    return { x: null, y: null, y2: false };
  }
  if (s.isMatrix) return { x: 'category', y: 'category', y2: false };
  if (s.isFunnel) return { x: null, y: 'category', y2: false };
  if (s.isScatter || s.isBubble) return { x: 'value', y: 'value', y2: false };
  if (s.isHoriz) return { x: 'value', y: 'category', y2: false };
  return { x: 'category', y: 'value', y2: DUAL_AXIS_TYPES.has(type) };
}

/** Does this chart paint one colour per CATEGORY (so the project's map applies to its labels)? */
export function fmtColorsByCategory(type: string, series: ChartSeriesShape[], overrides: Cx): boolean {
  const s = resolveChartType(type);
  if ((s.isRound && !s.isGauge) || s.isTreemap || s.isFunnel || s.isSankey || s.isWordCloud) return true;
  const one = series.filter((x) => x.role !== 'overlay').length === 1;
  return !!(overrides && overrides.colorByCategory) && one && s.chartType === 'bar'
    && !s.isHistogram && !s.isWaterfall && !s.isBullet && !s.isPareto && !s.opts.combo;
}

export function fmtScopeOf(overrides: Cx): ColorScope | null {
  const s = overrides && overrides._colorScope;
  return s && typeof s === 'object' && s.map ? (s as ColorScope) : null;
}

/** The slots `values` of `column` are drawn in (dealing new ones, as main will), or null. */
export function fmtTokensFor(scope: ColorScope, column: string, values: Cx[]): (string | null)[] | null {
  if (!column || !Array.isArray(values)) return null;
  return assignColors(scope.map[column], values).tokens;
}

/** 'chart-3' → the third colour of `palette`. */
export function fmtHex(token: string, palette: string[]): string {
  const i = isColorToken(token) ? slotIndex(token) : -1;
  return i >= 0 ? palette[i % palette.length] : palette[0];
}

/** Series colours INTO `palette`, in place: a split takes the project's map, measures the visual's `seriesColors`. */
function fmtSeriesPalette(series: ChartSeriesShape[], overrides: Cx, palette: string[]): string[] {
  const base = palette.slice();
  const scope = fmtScopeOf(overrides);
  const real = series.filter((s) => s.role !== 'overlay');
  const split = scope && scope.series ? fmtTokensFor(scope, scope.series, real.map((s) => s.name)) : null;
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

/** Before the datasets: series colours into `palette`, and one colour per label for a chart that colours by category. */
export function fmtResolve(labels: Cx[], series: ChartSeriesShape[], overrides: Cx, palette: string[], type: string): string[] | null {
  const base = palette.slice();
  fmtSeriesPalette(series, overrides, palette);
  if (!fmtColorsByCategory(type, series, overrides)) return null;
  const scope = fmtScopeOf(overrides);
  const tokens = scope && scope.category ? fmtTokensFor(scope, scope.category, labels) : null;
  if (!tokens && !(overrides && overrides.colorByCategory)) return null;
  return labels.map((_, i) => (tokens && tokens[i] ? fmtHex(tokens[i]!, base) : base[i % base.length]));
}

function axisNumbers(datasets: Cx[], axis: 'x' | 'y' | 'y1', horiz: boolean): number[] {
  const out: number[] = [];
  datasets.forEach((ds) => {
    if (!ds || ds._overlay) return;
    const onRight = ds.yAxisID === 'y1';
    if ((axis === 'y1') !== onRight && !(axis === 'x' && horiz)) return;
    (Array.isArray(ds.data) ? ds.data : []).forEach((p: Cx) => {
      const v = typeof p === 'number' ? p : p && typeof p === 'object' ? (axis === 'x' ? p.x : p.y) : null;
      if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    });
  });
  return out;
}

/** A log axis needs every value above zero — and something to draw. */
function logOk(nums: number[], f: Cx): boolean {
  return nums.length > 0 && nums.every((v) => v > 0) && !(typeof f.min === 'number' && f.min <= 0);
}

function rightAxis(c: ChartCtx): Cx {
  return {
    position: 'right',
    ticks: { color: c.textColor, font: c.tickFont, padding: 6, callback: (v: Cx) => c.fmt(v) },
    grid: { drawOnChartArea: false, display: false },
    border: { display: false },
  };
}

function fmtAxis(c: ChartCtx, sc: Cx, f: Cx, role: FmtRole, nums: number[]): void {
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
    sc.ticks.callback = (v: Cx) => fmtWith(v, f.format);
  }
  if (typeof f.min === 'number') { sc.min = f.min; sc.beginAtZero = false; }
  if (typeof f.max === 'number') sc.max = f.max;
  if (f.log && logOk(nums, f)) {
    sc.type = 'logarithmic';
    delete sc.beginAtZero;
    if (sc.min === 0) delete sc.min;
  }
}

function paintCategories(c: ChartCtx, datasets: Cx[], cat: string[]): void {
  const byLabel = new Map<string, string>();
  c.labels.forEach((l: Cx, i: number) => byLabel.set(String(l), cat[i]));
  const ds0 = datasets[0];
  if (!ds0) return;
  if (c.isRound && !c.isGauge) ds0.backgroundColor = cat;
  else if (c.isTreemap) {
    ds0.backgroundColor = (ctx: Cx) => {
      const d = ctx.type === 'data' && ctx.raw && ctx.raw._data;
      return d ? byLabel.get(String(d._label)) || cat[0] : 'transparent';
    };
  } else if (c.isFunnel && datasets[1]) datasets[1].backgroundColor = cat;
  else if (c.isSankey) {
    ds0.colorFrom = (ctx: Cx) => {
      const f = ctx.dataset && ctx.dataset.data && ctx.dataset.data[ctx.dataIndex];
      return (f && byLabel.get(String(f.from))) || cat[0];
    };
  } else {
    const real = datasets.find((d) => !d._overlay);
    if (!real) return;
    const grads = cat.map((col) => makeBarGradient(col, c.isHoriz));
    real.backgroundColor = (ctx: Cx) => (grads[ctx.dataIndex] ? grads[ctx.dataIndex](ctx) : cat[0]);
  }
}

function paintValues(c: ChartCtx, datasets: Cx[], palettes: Record<string, string>): void {
  const accent = getCSSVar('--accent', c.canvas) || c.palette[0];
  const rampOf = (kind: string) => valueRamp(kind, accent, c.surfColor);
  const range = (vals: Cx[]): [number, number] | null => {
    const nums = vals.filter((v) => typeof v === 'number' && Number.isFinite(v)) as number[];
    return nums.length ? [nums.reduce((a, b) => (b < a ? b : a)), nums.reduce((a, b) => (b > a ? b : a))] : null;
  };
  if (c.isMatrix) {
    const kind = Object.keys(palettes).map((k) => palettes[k])[0];
    const ds = datasets[0];
    const r = ds && range((ds.data || []).map((p: Cx) => p && p.v));
    if (!kind || !r) return;
    const ramp = rampOf(kind);
    ds.backgroundColor = (ctx: Cx) => {
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
    ds.backgroundColor = (ds.data as Cx[]).map((v) => (typeof v === 'number' ? rampColor(ramp, kind, v, r[0], r[1]) : 'transparent'));
  });
}

/** After the datasets and axes. Mutates both. */
export function fmtApply(c: ChartCtx, datasets: Cx[], scales: Cx, cat: string[] | null, type: string): void {
  const ov = c.overrides || {};
  if (cat) paintCategories(c, datasets, cat);
  const roles = fmtAxisRoles(type);
  if (roles.y2 && Array.isArray(ov.y2Series)) {
    const right = new Set(ov.y2Series.map(String));
    let any = false;
    datasets.forEach((ds) => {
      if (!ds || ds._overlay) return;
      ds.yAxisID = right.has(String(ds.label)) ? 'y1' : 'y';
      if (ds.yAxisID === 'y1') any = true;
    });
    if (any) scales.y1 = scales.y1 || rightAxis(c);
    else delete scales.y1;
  }
  if (scales.y1 && ov.y2AxisLabel) scales.y1.title = { display: true, text: ov.y2AxisLabel, color: c.textColor, font: c.tickFont };
  const axes = ov.axes || {};
  fmtAxis(c, scales.x, axes.x, roles.x, axisNumbers(datasets, 'x', c.isHoriz || c.isScatter || c.isBubble));
  fmtAxis(c, scales.y, axes.y, roles.y, axisNumbers(datasets, 'y', false));
  if (scales.y1) fmtAxis(c, scales.y1, axes.y2, 'value', axisNumbers(datasets, 'y1', false));
  if (ov.measurePalettes && typeof ov.measurePalettes === 'object' && Object.keys(ov.measurePalettes).length) paintValues(c, datasets, ov.measurePalettes);
}
