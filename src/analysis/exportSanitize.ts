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
  return { labels, series };
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
