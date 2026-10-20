// The self-contained export's WHITELIST — PURE, a trust boundary. Split from
// ./dashboardExport.ts (which re-exports every name), which keeps the layout,
// the style tokens and the render script.
//
// The bundle is untrusted renderer input. `sanitizeBundle` keeps known keys,
// coerces them, and drops the rest — field by field, to labels, finite numbers,
// closed enums and `data:image` URIs — so a stray config field, a secret, a raw
// row or an http(s) URL can never reach a file or a published page
// (src/publish/sanitize.ts builds on these same primitives).

// dashboards.ts is imported for `sanitizeStyle` rather than copying its three
// enums here — duplicating a whitelist is how whitelists drift. It pulls no
// fs/DOM work at load, so the self-checks still run under bare `node`.
import { sanitizeStyle } from './dashboards';
import { themeModel } from './themeTokens';
import type { AccentRamp, ExportBundle, ExportCard, ExportChartData, ExportLayout, ExportPage, ExportTheme } from './dashboardExport';
import type { ChartFigures, StepKind } from './chartShapes';

/** The fixed grid column count (kept in sync with .dash-grid in hub.css / dashboards.ts). */
export const GRID_COLS = 12;

// Core Chart.js types that render live from inlined data. Anything else (treemap /
// sankey / matrix / financial / boxplot / map / table) arrives as a {kind:'image'} PNG,
// so this whitelist never needs the plugin bundles.
const CORE_CHART_TYPES: ReadonlySet<string> = new Set([
  'bar',
  'line',
  'pie',
  'doughnut',
  'radar',
  'polarArea',
  'scatter',
  'bubble',
]);

// ── Defensive whitelisting (never throw — "keep known keys, coerce, drop the rest") ──

function intOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
}

export function sanitizeLayout(raw: unknown): ExportLayout {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  let x = intOr(o.x, 0);
  let y = intOr(o.y, 0);
  let w = intOr(o.w, 1);
  let h = intOr(o.h, 1);
  if (x < 0) x = 0;
  if (x > GRID_COLS - 1) x = GRID_COLS - 1;
  if (y < 0) y = 0;
  if (w < 1) w = 1;
  if (w > GRID_COLS) w = GRID_COLS;
  if (h < 1) h = 1;
  if (x + w > GRID_COLS) w = GRID_COLS - x;
  return { x, y, w, h };
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// A cell value that may legitimately appear in inlined chart data: a finite number, or
// null. ANYTHING else (string, object, a stray secret) → null. This is a hard barrier:
// only numbers survive into the chart datasets.
function asNumOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function sanitizeChartData(raw: unknown): ExportChartData {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const labels = Array.isArray(o.labels)
    ? o.labels.filter((l): l is string | number => typeof l === 'string' || typeof l === 'number')
    : [];
  const series = Array.isArray(o.series)
    ? o.series.map((s) => {
        const so = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
        return {
          label: asString(so.label),
          values: Array.isArray(so.values) ? so.values.map(asNumOrNull) : [],
        };
      })
    : [];
  const figures = sanitizeFigures(o.figures);
  return figures ? { labels, series, figures } : { labels, series };
}

// ── The chart's figures (./chartShapes) — named field by field, never spread ──
// What a waterfall, a Pareto, a 100%-stacked chart, a histogram, a funnel, a
// bullet and a calendar draw beyond their series. Finite numbers (else null),
// in-range integers (else -1), one closed enum and a bounded label: a key not
// named here — a stray field, a secret, a row — is dropped.

const STEP_KINDS: ReadonlySet<string> = new Set(['start', 'up', 'down', 'total', 'end']);
const FIG_MAX = 20_000;
const SERIES_MAX = 64;
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown, max = FIG_MAX): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const nums = (v: unknown): Array<number | null> => list(v).map(asNumOrNull);
const index = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= -1 && v < FIG_MAX ? v : -1);

function sanitizeFigures(raw: unknown): ChartFigures | undefined {
  const o = rec(raw);
  const out: ChartFigures = {};
  if (o.waterfall) {
    const w = rec(o.waterfall);
    out.waterfall = {
      from: asNumOrNull(w.from) ?? 0,
      to: asNumOrNull(w.to) ?? 0,
      steps: list(w.steps).map((x) => {
        const st = rec(x);
        return {
          label: asString(st.label).slice(0, 400), start: asNumOrNull(st.start) ?? 0, end: asNumOrNull(st.end) ?? 0,
          value: asNumOrNull(st.value) ?? 0, kind: (STEP_KINDS.has(st.kind as string) ? st.kind : 'up') as StepKind, src: index(st.src),
        };
      }),
    };
  }
  if (o.pareto) {
    const p = rec(o.pareto);
    out.pareto = {
      order: list(p.order).map(index), cumPct: nums(p.cumPct).map((v) => v ?? 0),
      count80: Math.max(0, index(p.count80)), total: asNumOrNull(p.total) ?? 0, positives: Math.max(0, index(p.positives)),
    };
  }
  if (o.sharePct) out.sharePct = list(o.sharePct, SERIES_MAX).map((r) => nums(r).map((v) => v ?? 0));
  if (o.histogram) {
    out.histogram = list(o.histogram, SERIES_MAX).map((bins) => list(bins).map((b) => {
      const x = rec(b);
      return { from: asNumOrNull(x.from) ?? 0, to: asNumOrNull(x.to) ?? 0, count: Math.max(0, index(x.count)) };
    }));
  }
  if (o.funnel) out.funnel = { ofTopPct: list(rec(o.funnel).ofTopPct, SERIES_MAX).map(nums) };
  if (o.bullet) out.bullet = { ofTargetPct: nums(rec(o.bullet).ofTargetPct) };
  if (o.calendar) {
    const c = rec(o.calendar);
    out.calendar = { days: list(c.days).map((d) => (typeof d === 'number' && Number.isInteger(d) ? d : 0)), values: nums(c.values) };
  }
  return Object.keys(out).length ? out : undefined;
}

// Only a `data:image/...;base64,...` URI is accepted for an embedded PNG — never an
// http(s) URL (keeps the file offline) and never arbitrary text. A MapLibre map card
// arrives here as `nativeImage.toDataURL()` output ("data:image/png;base64,…"), so it
// passes unchanged — the WebGL migration needed NO loosening of this gate.
export function sanitizePng(v: unknown): string {
  return typeof v === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(v) ? v : '';
}

/**
 * A list of ramp slots: integers 0–7, one per label/series, or nothing. One
 * bad entry drops the whole list — a garbled list is not half-trusted — and
 * the chart falls back to drawing by position, as every export did before.
 */
export function sanitizeSlots(raw: unknown, n: number): number[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > n) return undefined;
  return raw.every((k) => Number.isInteger(k) && k >= 0 && k < 8) ? (raw as number[]).slice() : undefined;
}

function sanitizeCard(raw: unknown): ExportCard | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o) return null;
  const layout = sanitizeLayout(o.layout);
  const kind = o.kind;

  if (kind === 'chart') {
    const data = sanitizeChartData(o.data);
    const chartType =
      typeof o.chartType === 'string' && CORE_CHART_TYPES.has(o.chartType) ? o.chartType : 'bar';
    const slots = sanitizeSlots(o.slots, data.labels.length);
    const seriesSlots = sanitizeSlots(o.seriesSlots, data.series.length);
    return {
      kind: 'chart', layout, chartType, title: asString(o.title), data,
      ...(slots ? { slots } : {}), ...(seriesSlots ? { seriesSlots } : {}),
    };
  }
  if (kind === 'image') {
    const png = sanitizePng(o.png);
    // A missing/invalid PNG degrades to a broken placeholder rather than a blank tile.
    if (!png) return { kind: 'broken', layout, reason: asString(o.title) || 'Image unavailable' };
    return { kind: 'image', layout, png, title: asString(o.title) };
  }
  if (kind === 'metric') {
    const value =
      typeof o.value === 'number' && Number.isFinite(o.value)
        ? o.value
        : typeof o.value === 'string'
          ? o.value
          : null;
    return {
      kind: 'metric', layout, label: asString(o.label), subLabel: asString(o.subLabel),
      value, format: asString(o.format),
    };
  }
  if (kind === 'text') {
    return { kind: 'text', layout, heading: asString(o.heading), text: asString(o.text) };
  }
  if (kind === 'broken') {
    return { kind: 'broken', layout, reason: asString(o.reason) || 'Source removed' };
  }
  return null; // unknown kind → dropped
}

function sanitizePage(raw: unknown): ExportPage {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const cards: ExportCard[] = [];
  if (Array.isArray(o.cards)) {
    for (const c of o.cards) {
      const card = sanitizeCard(c);
      if (card) cards.push(card);
    }
  }
  return { name: asString(o.name) || 'Page', cards };
}

// Whitelist the whole bundle down to the fixed primitive schema. The RETURN of this
// function is the ONLY thing that ever gets serialized into the file — so anything not
// named here (a secret, a raw dataset row, a config field) is impossible to leak.
export function sanitizeBundle(raw: unknown): ExportBundle {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pages = Array.isArray(o.pages) ? o.pages.map(sanitizePage) : [];
  if (pages.length === 0) pages.push({ name: 'Page', cards: [] });
  return {
    name: asString(o.name) || 'Dashboard',
    pages,
    controlsSummary: asString(o.controlsSummary),
    // A closed-enum clamp, NOT a widening of the whitelist above — see the
    // note on ExportBundle.style. Missing/garbage → the default light style,
    // which is what every export looked like before this field existed.
    style: sanitizeStyle(o.style),
    brand: sanitizeBrand(o.brand),
    ...themeField(o.theme),
  };
}

function themeField(raw: unknown): { theme?: ExportTheme } {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const tokens = themeModel.sanitizeTokens(o.tokens);
  return Object.keys(tokens).length ? { theme: { name: asString(o.name).slice(0, 60), tokens } } : {};
}

const COLOR_RE = /^(#[0-9a-f]{6}|rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (0|1|0?\.\d{1,4})\))$/i;

export function sanitizeBrand(raw: unknown): ExportBundle['brand'] {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const r = o.ramp && typeof o.ramp === 'object' ? (o.ramp as Record<string, unknown>) : {};
  const color = (v: unknown): string => (typeof v === 'string' && COLOR_RE.test(v) ? v : '');
  const chart = Array.isArray(r.chart) ? r.chart.slice(0, 8).map(color) : [];
  const ramp: AccentRamp = { accent: color(r.accent), accent2: color(r.accent2), soft: color(r.soft), line: color(r.line), chart };
  const whole = chart.length === 8 && chart.every(Boolean) && ramp.accent && ramp.accent2 && ramp.soft && ramp.line;
  const logo = sanitizePng(o.logo);
  return { ...(whole ? { ramp } : {}), ...(logo ? { logo } : {}) };
}
