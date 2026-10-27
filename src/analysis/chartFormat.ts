// A visual's FORMATTING DEPTH — per-axis range/scale/format/ticks, the dual
// axis and which measures sit on it, data-label format and position, custom
// sort order, per-series colours and per-measure value palettes — validated.
//
// These keys live on the visual's ordinary `overrides` object (visuals.ts
// `sanitizeOverrides` calls in here), the same bag the ⋯ Customize menu and
// chartRender.buildChart already share. Nothing here is a second store.
//
// CLAMPED, NEVER TRUSTED. An override arrives from the renderer or from a file
// on disk. Every rule below is a STATIC rule — one that can be checked from the
// config plus the visual's chart type and encoding, with no rows in hand:
//
//   · min / max are finite numbers, and min < max when both are set;
//   · a log axis cannot have min <= 0 or max <= 0, nor sit on a 100% chart;
//   · a dual axis only exists on the combo / line / column kinds;
//   · every measure assigned to the right axis is one of the visual's own
//     measures, the encoding does not split by a series column (then the
//     series are values, not measures), and at least one measure stays left.
//
// A config that breaks a rule loses THAT setting, not the whole visual. What
// can only be known from the data — a log axis over a measure with a zero or a
// negative in it — is refused at render time (the desktop's fmtApply.ts), where
// the numbers are.
//
// Pure and main-safe: no fs, only `import type`.

import type { ColorToken } from './colorMap';

export const NUMBER_FORMAT_IDS = ['auto', 'plain', 'thousands', 'compact', 'percent', 'currency'] as const;
export type NumberFormatId = (typeof NUMBER_FORMAT_IDS)[number];

export const SORT_MODE_IDS = ['none', 'asc', 'desc', 'label_asc', 'label_desc', 'custom'] as const;
export type SortMode = (typeof SORT_MODE_IDS)[number];

/** The chart kinds a second value axis is offered on. */
export const DUAL_AXIS_TYPES: ReadonlySet<string> = new Set([
  'combo', 'line', 'line_markers', 'area', 'column', 'clustered_column',
]);
/** 0–100% stacks: their value axis is pinned, so a log scale has no meaning there. */
const PCT_TYPES: ReadonlySet<string> = new Set(['pct_stacked_column', 'pct_stacked_bar']);

const LABEL_POSITIONS: ReadonlySet<string> = new Set(['outside', 'inside', 'center']);
const TICK_DENSITIES: ReadonlySet<string> = new Set(['few', 'many']);
const VALUE_PALETTES: ReadonlySet<string> = new Set(['sequential', 'diverging']);
const FORMATS: ReadonlySet<string> = new Set(NUMBER_FORMAT_IDS);
const TOKENS: ReadonlySet<string> = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((n) => 'chart-' + n));

const MAX_NAME = 200;
const MAX_SORT_ORDER = 500;
const MAX_SERIES_COLORS = 64;
const MAX_MEASURE_PALETTES = 32;

export interface AxisFormat {
  min?: number;
  max?: number;
  log?: boolean;
  /** Tick number format; absent = the chart's own `numberFormat`. */
  format?: NumberFormatId;
  /** Tick density; absent = Chart.js's own spacing. */
  ticks?: 'few' | 'many';
  hide?: boolean;
}

export interface FormatOverrides {
  /** x / y as Chart.js draws them; y2 is the right-hand value axis. */
  axes?: { x?: AxisFormat; y?: AxisFormat; y2?: AxisFormat };
  /** The right axis's title — the sibling of the existing xAxisLabel / yAxisLabel. */
  y2AxisLabel?: string | null;
  /** Measures (by series name) drawn against the right axis. [] = all left. */
  y2Series?: string[];
  labelFormat?: NumberFormatId;
  labelPosition?: 'outside' | 'inside' | 'center';
  /** `sort: 'custom'` — these labels first, in this order; the rest after, as they came. */
  sortOrder?: string[];
  /** Per-series (measure) colour, as a ramp slot. Dimension values use the PROJECT map instead. */
  seriesColors?: Record<string, ColorToken>;
  /** A single-series bar chart painted per category from the project's colour map. */
  colorByCategory?: boolean;
  /** Colour a measure's marks by value along a ramp derived from the accent. */
  measurePalettes?: Record<string, 'sequential' | 'diverging'>;
}

export interface FormatContext {
  chartType?: string;
  encoding?: {
    values?: Array<{ column?: unknown; aggregation?: unknown }>;
    series?: unknown;
  };
}

/**
 * The names a measure may be drawn under — the series names the renderer sees.
 * Mirrors `vizData.measureLabel` (and its resident twins): "sum of price", the
 * bare column for count, and both spellings of a raw ('none') measure, which is
 * summed when grouped and verbatim when not.
 */
export function measureNames(encoding: FormatContext['encoding']): string[] {
  const out: string[] = [];
  const vals = encoding && Array.isArray(encoding.values) ? encoding.values : [];
  for (const v of vals) {
    const col = v && typeof v.column === 'string' ? v.column : '';
    if (!col) continue;
    const agg = typeof v.aggregation === 'string' ? v.aggregation : 'sum';
    if (agg === 'count') out.push(col);
    else if (agg === 'none') out.push('sum of ' + col, col);
    else out.push(agg + ' of ' + col);
  }
  return out;
}

/** How many measures the encoding plots (a 'none' measure has two spellings, one line). */
function measureCount(encoding: FormatContext['encoding']): number {
  const vals = encoding && Array.isArray(encoding.values) ? encoding.values : [];
  return vals.filter((v) => v && typeof v.column === 'string' && v.column).length;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function names(raw: unknown, cap: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of raw) {
    if (typeof s !== 'string' || s.length > MAX_NAME || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= cap) break;
  }
  return out;
}

function validateAxis(raw: unknown, which: string, ctx: FormatContext, errors: string[]): AxisFormat | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: AxisFormat = {};
  for (const k of ['min', 'max'] as const) {
    if (o[k] === undefined || o[k] === null) continue;
    if (finite(o[k])) out[k] = o[k] as number;
    else errors.push(`${which}.${k} must be a finite number`);
  }
  if (out.min !== undefined && out.max !== undefined && !(out.min < out.max)) {
    errors.push(`${which}: min must be below max`);
    delete out.min;
    delete out.max;
  }
  if (o.log === true) {
    if (out.min !== undefined && out.min <= 0) errors.push(`${which}: a log scale needs min above 0`);
    else if (out.max !== undefined && out.max <= 0) errors.push(`${which}: a log scale needs max above 0`);
    else if (ctx.chartType && PCT_TYPES.has(ctx.chartType)) errors.push(`${which}: a 100% chart cannot use a log scale`);
    else out.log = true;
  }
  if (typeof o.format === 'string' && FORMATS.has(o.format)) out.format = o.format as NumberFormatId;
  if (typeof o.ticks === 'string' && TICK_DENSITIES.has(o.ticks)) out.ticks = o.ticks as AxisFormat['ticks'];
  if (o.hide === true) out.hide = true;
  return Object.keys(out).length ? out : null;
}

function validateDualAxis(raw: unknown, ctx: FormatContext, errors: string[]): string[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) { errors.push('y2Series must be a list'); return null; }
  if (!ctx.chartType || !DUAL_AXIS_TYPES.has(ctx.chartType)) {
    errors.push(`a dual axis is not available on ${ctx.chartType || 'this chart'}`);
    return null;
  }
  const enc = ctx.encoding;
  if (!enc) {
    errors.push('a dual axis needs the visual\'s measures to check against');
    return null;
  }
  if (typeof enc.series === 'string' && enc.series) {
    errors.push('a dual axis needs measures, not a series split');
    return null;
  }
  const allowed = new Set(measureNames(enc));
  const picked = names(raw, MAX_SERIES_COLORS).filter((n) => {
    if (allowed.has(n)) return true;
    errors.push(`"${n}" is not one of this visual's measures`);
    return false;
  });
  if (picked.length && picked.length >= measureCount(enc)) {
    errors.push('at least one measure must stay on the left axis');
    return null;
  }
  return picked;
}

function tokenMap(raw: unknown, cap: number): Record<string, ColorToken> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = Object.create(null) as Record<string, ColorToken>;
  let n = 0;
  for (const k of Object.keys(raw as object)) {
    const t = (raw as Record<string, unknown>)[k];
    if (k.length > MAX_NAME || typeof t !== 'string' || !TOKENS.has(t)) continue;
    out[k] = t as ColorToken;
    if (++n >= cap) break;
  }
  return n ? out : null;
}

/**
 * Validate the formatting keys of an overrides object. `value` is the clamped
 * config (only valid settings, only present keys); `errors` says what was
 * dropped and why — the tests read it, the sanitizer only keeps `value`.
 */
export function validateFormat(raw: unknown, ctx: FormatContext = {}): { value: FormatOverrides; errors: string[] } {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const errors: string[] = [];
  const value: FormatOverrides = {};

  if (o.axes && typeof o.axes === 'object' && !Array.isArray(o.axes)) {
    const a = o.axes as Record<string, unknown>;
    const axes: NonNullable<FormatOverrides['axes']> = {};
    for (const k of ['x', 'y', 'y2'] as const) {
      const ax = validateAxis(a[k], k, ctx, errors);
      if (ax) axes[k] = ax;
    }
    if (Object.keys(axes).length) value.axes = axes;
  }
  if (typeof o.y2AxisLabel === 'string') value.y2AxisLabel = o.y2AxisLabel.slice(0, MAX_NAME);
  else if (o.y2AxisLabel === null) value.y2AxisLabel = null;

  const y2 = validateDualAxis(o.y2Series, ctx, errors);
  if (y2) value.y2Series = y2;

  if (typeof o.labelFormat === 'string' && FORMATS.has(o.labelFormat)) value.labelFormat = o.labelFormat as NumberFormatId;
  if (typeof o.labelPosition === 'string' && LABEL_POSITIONS.has(o.labelPosition)) {
    value.labelPosition = o.labelPosition as FormatOverrides['labelPosition'];
  }

  const order = names(o.sortOrder, MAX_SORT_ORDER);
  if (order.length) value.sortOrder = order;

  const sc = tokenMap(o.seriesColors, MAX_SERIES_COLORS);
  if (sc) value.seriesColors = sc;
  if (o.colorByCategory === true) value.colorByCategory = true;

  if (o.measurePalettes && typeof o.measurePalettes === 'object' && !Array.isArray(o.measurePalettes)) {
    const known = ctx.encoding ? new Set(measureNames(ctx.encoding)) : null;
    const mp = Object.create(null) as Record<string, 'sequential' | 'diverging'>;
    let n = 0;
    for (const k of Object.keys(o.measurePalettes as object)) {
      const p = (o.measurePalettes as Record<string, unknown>)[k];
      if (k.length > MAX_NAME || typeof p !== 'string' || !VALUE_PALETTES.has(p)) continue;
      if (known && !known.has(k)) { errors.push(`"${k}" is not one of this visual's measures`); continue; }
      mp[k] = p as 'sequential' | 'diverging';
      if (++n >= MAX_MEASURE_PALETTES) break;
    }
    if (n) value.measurePalettes = mp;
  }
  return { value, errors };
}

/** validateFormat's clamped config alone — what `visuals.sanitizeOverrides` keeps. */
export function sanitizeFormat(raw: unknown, ctx?: FormatContext): FormatOverrides {
  return validateFormat(raw, ctx).value;
}
