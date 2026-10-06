// Analytics overlays — PURE, MAIN PROCESS, NO MODEL.
//
// The builder's Analytics pane lets an author lay reference lines, bands,
// targets, trend lines, moving averages, forecasts, annotations and highlights
// over a chart. Every figure those overlays show — the average a reference line
// sits at, a trend's slope and R², a forecast and its 80% interval — is
// computed HERE, from the chart's own aggregated `{labels, series}`, and never
// by a model and never in the renderer. The client (web/src/charts/
// annotations.ts) only draws the resolved result.
//
// A saved visual stores DEFINITIONS (`Visual.analytics: Overlay[]`); the figures
// are re-resolved on every `visual:data` (src/ipc/visualsAnalytics.ts), exactly
// like the chart's own numbers. A stored figure would be a figure that can go
// stale.
//
// Metrics: a reference / band edge / target may be a saved metric. This file
// never resolves one — it takes the already-resolved figures in
// `ResolveContext.metrics` (the IPC layer resolves them through the metrics
// layer under the chart's scope), so it stays pure and node-testable.
//
// Deterministic: no Date.now(), no randomness, fixed grid searches with strict
// comparisons, so scripts/test-analytics.ts can pin exact figures.

import { formatCompact } from '../app/format';
import type { ChartData } from './vizData';
import type { CategoryInfo, DateGrain } from './categoryKey';
import { quantile } from './anomalies';
import { forecastSeries, stepGrainOf, futureLabels } from './forecast';
import type { ForecastMethod, ForecastResult } from './forecast';

export type { ForecastMethod } from './forecast';

// ── definitions (what a visual stores) ───────────────────────────────────────

export type OverlayKind =
  | 'reference' | 'band' | 'target' | 'trend' | 'moving_average' | 'forecast' | 'annotation' | 'highlight';

export const OVERLAY_KINDS: readonly OverlayKind[] = [
  'reference', 'band', 'target', 'trend', 'moving_average', 'forecast', 'annotation', 'highlight',
];

export type StatName = 'avg' | 'median' | 'min' | 'max' | 'percentile';

/** Where a line's value comes from: a typed constant, a statistic of the series, or a saved metric. */
export type ValueSource =
  | { type: 'constant'; value: number }
  | { type: 'stat'; stat: StatName; p?: number }
  | { type: 'metric'; metricId: string };

export type HighlightRule = 'top' | 'bottom' | 'above' | 'below';
export type SeasonChoice = 'auto' | 0 | 4 | 7 | 12;

/**
 * One overlay DEFINITION. Flat rather than a discriminated union: every kind
 * reads a handful of the optional fields below, the pane edits them in place,
 * and the sanitizer keeps only the ones the kind uses.
 */
export interface Overlay {
  id: string;
  kind: OverlayKind;
  /** The author's own name for it. Absent: the app names it ("Average", "Trend"). */
  label?: string;
  /** '#rrggbb'. Absent: the renderer's accent for the kind. */
  color?: string;
  /** Which series it reads — an index into `data.series`. Default 0. */
  series?: number;
  /** Switched off in the pane, kept in the list. */
  hidden?: boolean;
  /** reference, target */
  value?: ValueSource;
  /** band — two edges, or `sd` (mean ± sd·σ), which wins when set. */
  from?: ValueSource;
  to?: ValueSource;
  sd?: number;
  /** moving_average: trailing window, in points. */
  window?: number;
  /** forecast */
  method?: ForecastMethod;
  horizon?: number;
  season?: SeasonChoice;
  /** annotation: the category it is pinned to, and what it says. */
  at?: string;
  text?: string;
  /** highlight */
  rule?: HighlightRule;
  n?: number;
  threshold?: number;
}

// ── resolved (what the renderer draws) ───────────────────────────────────────

export interface ResolvedOverlay {
  id: string;
  kind: OverlayKind;
  series: number;
  color?: string;
  /** The overlay's name — the author's label, or the app's. */
  label: string;
  /** The readout: "Average 12.3K", "+1.2K per month · R² 0.82". App-written. */
  text: string;
  value?: number;
  from?: number;
  to?: number;
  /** trend / moving average, aligned index-for-index with `data.labels`. */
  points?: Array<number | null>;
  trend?: { slope: number; intercept: number; r2: number | null; per: string };
  forecast?: ForecastResult & { labels: string[] };
  target?: { attainment: number | null; met: number; of: number };
  annotation?: { at: string; text: string; value: number | null };
  highlight?: { indices: number[] };
  /** A constant reference / target line: the builder lets the author drag it. */
  draggable?: boolean;
  /** Why it is not drawn. A resolved overlay with a warning carries no figures. */
  warning?: string;
}

export interface ResolveContext {
  /** How main bucketed the category axis (analysis/categoryKey). */
  category?: CategoryInfo | null;
  /** metricId → its figure under the chart's scope, resolved by the metrics layer. */
  metrics?: Map<string, { name: string; value: number | null }>;
}

// ── sanitize (untrusted renderer / stored input) ─────────────────────────────

const MAX_OVERLAYS = 24;
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const STATS: ReadonlySet<string> = new Set(['avg', 'median', 'min', 'max', 'percentile']);
const METHODS: ReadonlySet<string> = new Set(['linear', 'seasonal_naive', 'holt_winters']);
const RULES: ReadonlySet<string> = new Set(['top', 'bottom', 'above', 'below']);
const KINDS: ReadonlySet<string> = new Set(OVERLAY_KINDS);

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const intIn = (v: unknown, lo: number, hi: number): number | undefined =>
  finite(v) && Math.floor(v) === v && v >= lo && v <= hi ? v : undefined;
const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

export function sanitizeSource(raw: unknown): ValueSource | undefined {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o) return undefined;
  if (o.type === 'constant' && finite(o.value)) return { type: 'constant', value: o.value };
  if (o.type === 'metric' && typeof o.metricId === 'string' && UUID_RE.test(o.metricId)) {
    return { type: 'metric', metricId: o.metricId };
  }
  if (o.type === 'stat' && typeof o.stat === 'string' && STATS.has(o.stat)) {
    const s: ValueSource = { type: 'stat', stat: o.stat as StatName };
    if (o.stat === 'percentile') s.p = finite(o.p) && o.p >= 0 && o.p <= 100 ? o.p : 90;
    return s;
  }
  return undefined;
}

/**
 * Whitelist a stored / renderer-supplied overlay list. Unknown kinds and
 * malformed entries are DROPPED (never clamped into a different overlay), each
 * kind keeps only the fields it reads, and the list is capped. Never throws.
 */
export function sanitizeOverlays(raw: unknown): Overlay[] {
  if (!Array.isArray(raw)) return [];
  const out: Overlay[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (out.length >= MAX_OVERLAYS) break;
    const o = r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
    if (!o || typeof o.kind !== 'string' || !KINDS.has(o.kind)) continue;
    if (typeof o.id !== 'string' || !ID_RE.test(o.id) || seen.has(o.id)) continue;
    seen.add(o.id);
    const ov: Overlay = { id: o.id, kind: o.kind as OverlayKind };
    const label = str(o.label, 80);
    if (label) ov.label = label;
    if (typeof o.color === 'string' && HEX_RE.test(o.color)) ov.color = o.color.toLowerCase();
    const series = intIn(o.series, 0, 99);
    if (series) ov.series = series;
    if (o.hidden === true) ov.hidden = true;
    switch (ov.kind) {
      case 'reference':
      case 'target': {
        ov.value = sanitizeSource(o.value) || (ov.kind === 'reference' ? { type: 'stat', stat: 'avg' } : { type: 'constant', value: 0 });
        break;
      }
      case 'band': {
        const sd = finite(o.sd) && o.sd > 0 && o.sd <= 6 ? o.sd : undefined;
        if (sd) ov.sd = sd;
        const from = sanitizeSource(o.from);
        const to = sanitizeSource(o.to);
        if (from) ov.from = from;
        if (to) ov.to = to;
        if (!sd && (!from || !to)) ov.sd = 1; // an edge missing: fall back to mean ± 1σ
        break;
      }
      case 'moving_average':
        ov.window = intIn(o.window, 2, 60) || 3;
        break;
      case 'forecast':
        ov.method = typeof o.method === 'string' && METHODS.has(o.method) ? (o.method as ForecastMethod) : 'linear';
        ov.horizon = intIn(o.horizon, 1, 36) || 3;
        ov.season = o.season === 0 || o.season === 4 || o.season === 7 || o.season === 12 ? o.season : 'auto';
        break;
      case 'annotation': {
        const at = typeof o.at === 'string' ? o.at.slice(0, 200) : '';
        const text = str(o.text, 280);
        if (!at || !text) continue; // an annotation pinned to nothing, or saying nothing, is not one
        ov.at = at;
        ov.text = text;
        break;
      }
      case 'highlight':
        ov.rule = typeof o.rule === 'string' && RULES.has(o.rule) ? (o.rule as HighlightRule) : 'top';
        if (ov.rule === 'top' || ov.rule === 'bottom') ov.n = intIn(o.n, 1, 50) || 3;
        else ov.threshold = finite(o.threshold) ? o.threshold : 0;
        break;
      default:
        break; // trend: no options
    }
    out.push(ov);
  }
  return out;
}

// ── which chart types draw which overlays ────────────────────────────────────
//
// MAIN's copy of the renderer's `ChartTypeSpec.overlayKinds`
// (the desktop's chartTypeSpec.ts). Captions and the Assistant's facts must only
// talk about overlays the picture actually shows, and main cannot import a
// classic renderer script — so scripts/test-analytics.ts runs chartTypeSpec.js
// in a vm and asserts the two agree for every chart id. Drift fails a test.

const ALL: readonly OverlayKind[] = OVERLAY_KINDS;
const FLAT: readonly OverlayKind[] = ['reference', 'band', 'target', 'annotation', 'highlight'];

export const OVERLAY_ACCEPT: Readonly<Record<string, readonly OverlayKind[]>> = {
  column: ALL, clustered_column: ALL, line: ALL, line_markers: ALL, area: ALL, combo: ALL,
  bar: FLAT, clustered_bar: FLAT, stacked_column: FLAT, stacked_bar: FLAT, stacked_area: FLAT,
  pct_stacked_column: ['annotation', 'highlight'], pct_stacked_bar: ['annotation', 'highlight'],
  histogram: ['reference', 'band', 'annotation', 'highlight'],
  scatter: ['reference', 'band'], bubble: ['reference', 'band'],
  candlestick: ['reference', 'band', 'annotation'], boxplot: ['reference', 'band'],
  // The five #177 families, each decided explicitly: a waterfall's bars are
  // deltas and a Pareto sorts itself, so neither has an axis a trend could run
  // along; a bullet already draws its own target; a calendar is a matrix and a
  // radar is radial, so neither has a value axis a line could be drawn across.
  waterfall: FLAT, pareto: FLAT,
  bullet: ['reference', 'band', 'annotation', 'highlight'],
  calendar: [], radar: [],
  word_cloud: [], // no axes to draw an overlay against
};

export function overlayAccepted(chartType: string | null | undefined, kind: OverlayKind): boolean {
  const list = OVERLAY_ACCEPT[String(chartType || '')];
  return !!list && list.indexOf(kind) >= 0;
}

// ── the maths ────────────────────────────────────────────────────────────────

/** Finite values of a series, in order. */
function finiteOf(values: unknown[]): number[] {
  return values.filter(finite);
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : null;
}

/** Sample standard deviation (n − 1). Fewer than two values: null. */
export function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, v) => a + v, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, v) => a + (v - m) * (v - m), 0) / (xs.length - 1));
}

export function statOf(values: unknown[], stat: StatName, p = 90): number | null {
  const xs = finiteOf(values);
  if (!xs.length) return null;
  if (stat === 'avg') return mean(xs);
  if (stat === 'min') return Math.min(...xs);
  if (stat === 'max') return Math.max(...xs);
  // The app's ONE quantile (analysis/anomalies.ts), linear interpolation.
  const sorted = xs.slice().sort((a, b) => a - b);
  return quantile(sorted, stat === 'median' ? 0.5 : Math.min(100, Math.max(0, p)) / 100);
}

/**
 * Ordinary least squares of y on its POSITION (0, 1, 2, …). Null cells keep
 * their position and are left out of the fit, so a missing month is a gap, not
 * a shift of every later month. R² is null when the fitted values have no
 * variance to explain (a flat series).
 */
export function linearFit(values: unknown[]): { slope: number; intercept: number; r2: number | null; n: number } | null {
  const pts: Array<[number, number]> = [];
  values.forEach((v, i) => { if (finite(v)) pts.push([i, v]); });
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0; let sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  const mx = sx / n; const my = sy / n;
  let sxx = 0; let sxy = 0; let syy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) * (x - mx); sxy += (x - mx) * (y - my); syy += (y - my) * (y - my); }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssRes = 0;
  for (const [x, y] of pts) { const e = y - (intercept + slope * x); ssRes += e * e; }
  const r2 = syy === 0 ? null : 1 - ssRes / syy;
  return { slope, intercept, r2, n };
}

/**
 * Trailing moving average over `window` POSITIONS. The first window − 1 points
 * are null (there is no full window behind them); a null inside a window is
 * skipped and the average is taken over the cells that are there; a window of
 * nothing but nulls is null.
 */
export function movingAverage(values: unknown[], window: number): Array<number | null> {
  const w = Math.max(1, Math.floor(window));
  return values.map((_, i) => {
    if (i < w - 1) return null;
    const cell = values.slice(i - w + 1, i + 1).filter(finite);
    return cell.length ? cell.reduce((a, v) => a + v, 0) / cell.length : null;
  });
}

/** Indices of the points a highlight rule picks. Ties at the cut are all kept. */
export function highlightIndices(values: unknown[], rule: HighlightRule, n = 3, threshold = 0): number[] {
  const idx = values.map((v, i) => (finite(v) ? i : -1)).filter((i) => i >= 0);
  if (rule === 'above') return idx.filter((i) => (values[i] as number) > threshold);
  if (rule === 'below') return idx.filter((i) => (values[i] as number) < threshold);
  const sorted = idx.slice().sort((a, b) => {
    const d = (values[b] as number) - (values[a] as number);
    return (rule === 'top' ? d : -d) || a - b;
  });
  if (sorted.length <= n) return idx;
  const cut = values[sorted[n - 1]] as number;
  return idx.filter((i) => (rule === 'top' ? (values[i] as number) >= cut : (values[i] as number) <= cut));
}

// ── resolution ───────────────────────────────────────────────────────────────

const STAT_NAMES: Record<StatName, string> = {
  avg: 'Average', median: 'Median', min: 'Minimum', max: 'Maximum', percentile: 'Percentile',
};

const GRAIN_NOUN: Record<DateGrain, string> = { day: 'day', week: 'week', month: 'month', quarter: 'quarter', year: 'year' };

/** Signed compact: "+1.2K", "−340". */
export function signed(v: number): string {
  const body = formatCompact(Math.abs(v));
  return v > 0 ? '+' + body : v < 0 ? '−' + body : body;
}

function sourceName(src: ValueSource, ctx: ResolveContext): string {
  if (src.type === 'constant') return 'Reference';
  if (src.type === 'metric') return (ctx.metrics && ctx.metrics.get(src.metricId)?.name) || 'Metric';
  return src.stat === 'percentile' ? `P${Math.round(src.p ?? 90)}` : STAT_NAMES[src.stat];
}

function sourceValue(src: ValueSource | undefined, values: unknown[], ctx: ResolveContext): number | null {
  if (!src) return null;
  if (src.type === 'constant') return src.value;
  if (src.type === 'metric') {
    const m = ctx.metrics && ctx.metrics.get(src.metricId);
    return m && finite(m.value) ? m.value : null;
  }
  return statOf(values, src.stat, src.p);
}

/** Labels that parse as date buckets, for a caller that did not pass a CategoryInfo. */
const BUCKET_RE: Record<DateGrain, RegExp> = {
  year: /^\d{4}$/, quarter: /^\d{4}-Q[1-4]$/, month: /^\d{4}-\d{2}$/, week: /^\d{4}-\d{2}-\d{2}$/, day: /^\d{4}-\d{2}-\d{2}$/,
};

export function axisOf(data: ChartData, ctx: ResolveContext): { kind: 'date' | 'number' | 'text'; grain?: DateGrain } {
  const c = ctx.category;
  if (c && c.kind === 'date' && c.grain) return { kind: 'date', grain: c.grain };
  if (c && c.kind === 'number') return { kind: 'number' };
  if (c && c.kind === 'text') return { kind: 'text' };
  const labels = (data.labels || []).map(String);
  if (labels.length) {
    for (const g of ['year', 'quarter', 'month', 'day'] as DateGrain[]) {
      if (labels.every((l) => BUCKET_RE[g].test(l))) return { kind: 'date', grain: g };
    }
  }
  return { kind: 'text' };
}

/**
 * Resolve every overlay against one chart's aggregated data. Hidden overlays
 * are skipped; an overlay that cannot be drawn comes back with a `warning` and
 * no figures, so the pane can say why. Never throws.
 */
export function resolveOverlays(data: ChartData | null | undefined, overlays: Overlay[], ctx: ResolveContext = {}): ResolvedOverlay[] {
  const d: ChartData = data && Array.isArray(data.labels) && Array.isArray(data.series) ? data : { labels: [], series: [] };
  const out: ResolvedOverlay[] = [];
  for (const ov of overlays || []) {
    if (!ov || ov.hidden) continue;
    try {
      out.push(resolveOne(d, ov, ctx));
    } catch (_) {
      out.push({ id: ov.id, kind: ov.kind, series: ov.series || 0, label: ov.label || ov.kind, text: '', warning: 'Could not be computed' });
    }
  }
  return out;
}

function resolveOne(data: ChartData, ov: Overlay, ctx: ResolveContext): ResolvedOverlay {
  const si = ov.series || 0;
  const base: ResolvedOverlay = { id: ov.id, kind: ov.kind, series: si, label: ov.label || '', text: '' };
  if (ov.color) base.color = ov.color;
  const s = data.series[si];
  const fail = (label: string, warning: string): ResolvedOverlay => ({ ...base, label: base.label || label, warning });
  if (!s || !Array.isArray(s.values) || (s as { role?: string }).role === 'overlay') return fail(ov.kind, 'That series is not on this chart');
  const values: unknown[] = s.values;
  const axis = axisOf(data, ctx);
  const perNoun = axis.kind === 'date' && axis.grain ? GRAIN_NOUN[stepGrainOf(data.labels.map(String), axis.grain)] : 'period';
  const ordered = axis.kind !== 'text';

  switch (ov.kind) {
    case 'reference': {
      const src = ov.value || { type: 'stat', stat: 'avg' };
      const label = base.label || sourceName(src, ctx);
      const value = sourceValue(src, values, ctx);
      if (value === null) return fail(label, src.type === 'metric' ? 'The metric has no value under this chart\'s filters' : 'No figures to compute it from');
      return { ...base, label, value, text: `${label} ${formatCompact(value)}`, draggable: src.type === 'constant' };
    }
    case 'target': {
      const src = ov.value || { type: 'constant', value: 0 };
      const label = base.label || (src.type === 'metric' ? sourceName(src, ctx) : 'Target');
      const value = sourceValue(src, values, ctx);
      if (value === null) return fail(label, 'The target has no value');
      const xs = finiteOf(values);
      const met = xs.filter((v) => v >= value).length;
      let last: number | null = null;
      for (let i = values.length - 1; i >= 0; i--) if (finite(values[i])) { last = values[i] as number; break; }
      const attainment = axis.kind === 'date' && last !== null && value !== 0 ? last / value : null;
      const tail = attainment !== null
        ? `latest at ${Math.round(attainment * 100)}%`
        : `${met} of ${xs.length} at or above`;
      return {
        ...base, label, value, draggable: src.type === 'constant',
        target: { attainment, met, of: xs.length },
        text: `${label} ${formatCompact(value)} · ${tail}`,
      };
    }
    case 'band': {
      const label = base.label || (ov.sd ? `Mean ± ${ov.sd}σ` : 'Band');
      let lo: number | null; let hi: number | null;
      if (ov.sd) {
        const xs = finiteOf(values);
        const m = mean(xs); const sd = stdev(xs);
        if (m === null || sd === null) return fail(label, 'Needs at least two figures');
        lo = m - ov.sd * sd; hi = m + ov.sd * sd;
      } else {
        lo = sourceValue(ov.from, values, ctx); hi = sourceValue(ov.to, values, ctx);
      }
      if (lo === null || hi === null) return fail(label, 'An edge of the band has no value');
      if (lo > hi) { const t = lo; lo = hi; hi = t; }
      return { ...base, label, from: lo, to: hi, text: `${label} ${formatCompact(lo)} – ${formatCompact(hi)}` };
    }
    case 'trend': {
      const label = base.label || 'Trend';
      if (!ordered) return fail(label, 'A trend needs a date or number axis');
      const fit = linearFit(values);
      if (!fit || fit.n < 3) return fail(label, 'Needs at least three points');
      const points = values.map((_, i) => fit.intercept + fit.slope * i);
      const r2 = fit.r2 === null ? '' : ` · R² ${fit.r2.toFixed(2)}`;
      return {
        ...base, label, points,
        trend: { slope: fit.slope, intercept: fit.intercept, r2: fit.r2, per: perNoun },
        text: `${signed(fit.slope)} per ${perNoun}${r2}`,
      };
    }
    case 'moving_average': {
      const w = ov.window || 3;
      const label = base.label || `${w}-${perNoun} moving average`;
      if (!ordered) return fail(label, 'A moving average needs a date or number axis');
      if (finiteOf(values).length < w) return fail(label, `Needs at least ${w} points`);
      const points = movingAverage(values, w);
      let last: number | null = null;
      for (let i = points.length - 1; i >= 0; i--) if (points[i] !== null) { last = points[i]; break; }
      return { ...base, label, points, text: last === null ? `No full ${w}-point window yet` : `Latest ${formatCompact(last)}` };
    }
    case 'forecast': {
      const label = base.label || 'Forecast';
      if (axis.kind !== 'date' || !axis.grain) return fail(label, 'A forecast needs a date axis');
      const fc = forecastSeries(values, {
        method: ov.method || 'linear',
        horizon: ov.horizon || 3,
        season: ov.season === undefined ? 'auto' : ov.season,
      });
      if ('error' in fc) return fail(label, fc.error);
      const labels = futureLabels(data.labels.map(String), axis.grain, fc.values.length);
      if (!labels) return fail(label, 'The axis labels are not date buckets');
      const i = fc.values.length - 1;
      return {
        ...base, label, forecast: { ...fc, labels },
        text: `${formatCompact(fc.values[i])} by ${labels[i]} (80%: ${formatCompact(fc.lo[i])}–${formatCompact(fc.hi[i])})`
          + ` · ${METHOD_NAMES[fc.method]}${fc.season ? `, season ${fc.season}` : ''}`,
      };
    }
    case 'annotation': {
      const at = String(ov.at || '');
      const i = data.labels.map(String).indexOf(at);
      if (i < 0) return fail(ov.text || 'Note', 'That category is not on the chart any more');
      const v = values[i];
      return {
        ...base, label: base.label || ov.text || 'Note',
        annotation: { at, text: ov.text || '', value: finite(v) ? v : null },
        text: `${at}: ${ov.text || ''}`,
      };
    }
    case 'highlight': {
      const rule = ov.rule || 'top';
      const indices = highlightIndices(values, rule, ov.n || 3, ov.threshold || 0);
      const label = base.label || (rule === 'top' ? `Top ${ov.n || 3}` : rule === 'bottom' ? `Bottom ${ov.n || 3}`
        : `${rule === 'above' ? 'Above' : 'Below'} ${formatCompact(ov.threshold || 0)}`);
      return { ...base, label, highlight: { indices }, text: `${label}: ${indices.length} ${indices.length === 1 ? 'point' : 'points'}` };
    }
    default:
      return fail(String(ov.kind), 'Unknown overlay');
  }
}

export const METHOD_NAMES: Record<ForecastMethod, string> = {
  linear: 'Linear', seasonal_naive: 'Seasonal naive', holt_winters: 'Holt-Winters',
};

// ── sentences (captions) and facts (the Assistant's ledger) ──────────────────

/**
 * The trend and forecast clauses a caption appends — "; trend +8.1K per month
 * (R² 0.62)" and "; forecast 356.2K by 2025-03, 80% range 301K–411K". Only for
 * overlays the chart type actually draws. Empty string when there are none.
 */
export function analyticsClauses(resolved: ResolvedOverlay[] | null | undefined, chartType: string | null | undefined): string {
  const parts: string[] = [];
  for (const r of resolved || []) {
    if (r.warning || !overlayAccepted(chartType, r.kind)) continue;
    if (r.kind === 'trend' && r.trend) {
      const r2 = r.trend.r2 === null ? '' : ` (R² ${r.trend.r2.toFixed(2)})`;
      parts.push(`trend ${signed(r.trend.slope)} per ${r.trend.per}${r2}`);
    } else if (r.kind === 'forecast' && r.forecast) {
      const f = r.forecast;
      const i = f.values.length - 1;
      parts.push(`forecast ${formatCompact(f.values[i])} by ${f.labels[i]}, 80% range ${formatCompact(f.lo[i])}–${formatCompact(f.hi[i])}`);
    }
  }
  return parts.length ? '; ' + parts.join('; ') : '';
}

/** One fact line + the raw figures behind it, for src/ai/copilotFacts.ts's ledger. */
export interface OverlayFact { line: string; figures: Array<{ label: string; value: number }> }

/**
 * Every drawn overlay as a facts line with RAW figures (never the compact
 * display text, which the model would otherwise quote as if it were exact).
 */
export function overlayFacts(resolved: ResolvedOverlay[] | null | undefined, chartType: string | null | undefined): OverlayFact[] {
  const out: OverlayFact[] = [];
  const raw = (v: number): string => String(v);
  for (const r of resolved || []) {
    if (r.warning || !overlayAccepted(chartType, r.kind)) continue;
    const f: OverlayFact = { line: '', figures: [] };
    const add = (label: string, value: number | null | undefined): void => {
      if (finite(value)) f.figures.push({ label: `${r.label} ${label}`.trim(), value });
    };
    if ((r.kind === 'reference' || r.kind === 'target') && finite(r.value)) {
      f.line = `${r.kind === 'target' ? 'Target' : 'Reference line'} "${r.label}" at ${raw(r.value)}`;
      add('', r.value);
      if (r.target && r.target.attainment !== null) {
        f.line += `; latest value is ${raw(r.target.attainment * 100)}% of it`;
        add('attainment %', r.target.attainment * 100);
      } else if (r.target) {
        f.line += `; ${r.target.met} of ${r.target.of} points at or above it`;
        add('points at or above', r.target.met);
        add('points', r.target.of);
      }
    } else if (r.kind === 'band' && finite(r.from) && finite(r.to)) {
      f.line = `Band "${r.label}" from ${raw(r.from)} to ${raw(r.to)}`;
      add('from', r.from); add('to', r.to);
    } else if (r.kind === 'trend' && r.trend) {
      f.line = `Linear trend: slope ${raw(r.trend.slope)} per ${r.trend.per}, R² ${r.trend.r2 === null ? 'n/a' : raw(r.trend.r2)}`;
      add('slope', r.trend.slope); add('R²', r.trend.r2);
    } else if (r.kind === 'moving_average' && r.points) {
      const last = [...r.points].reverse().find(finite);
      f.line = `${r.label}: latest ${last === undefined ? 'n/a' : raw(last)}`;
      add('latest', last);
    } else if (r.kind === 'forecast' && r.forecast) {
      const fc = r.forecast;
      f.line = `Forecast (${METHOD_NAMES[fc.method]}${fc.season ? `, season ${fc.season}` : ''}, 80% interval): `
        + fc.labels.map((l, i) => `${l}=${raw(fc.values[i])} [${raw(fc.lo[i])}, ${raw(fc.hi[i])}]`).join(', ');
      fc.labels.forEach((l, i) => { add(`@ ${l}`, fc.values[i]); add(`low @ ${l}`, fc.lo[i]); add(`high @ ${l}`, fc.hi[i]); });
    } else if (r.kind === 'annotation' && r.annotation) {
      f.line = `Annotation at ${r.annotation.at}: "${r.annotation.text}"`;
    } else if (r.kind === 'highlight' && r.highlight) {
      f.line = `Highlight "${r.label}": ${r.highlight.indices.length} points`;
      add('points', r.highlight.indices.length);
    } else continue;
    out.push(f);
  }
  return out;
}
