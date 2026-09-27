// Self-contained dashboard export — MAIN-PROCESS-safe, PURE logic (no Electron / fs /
// DOM), so it is node-testable by a plain `node` self-check
// (scripts/test-dashboardExport.ts).
//
// `buildSelfContainedHtml(bundle, chartLibJs)` assembles ONE offline `.html` string for
// a dashboard: inline light-theme CSS + a copy of the Chart.js UMD (read off
// node_modules by the caller — NEVER fetched) + a tiny vanilla render script that draws
// each card. Core-Chart.js cards render live from inlined `{labels,series}`; map / plugin
// / table cards arrive pre-rendered as `{kind:'image', png}` (a `data:` URI captured via
// the existing report-capture path) so the file is fully offline — no network, no plugin
// bundles, no new dependency.
//
// WHY MAPLIBRE IS NOT INLINED (Phase 4). A map card stays a static `data:` PNG; the
// MapLibre bundle is deliberately NOT embedded the way Chart.js is. Measured, v4.7.1:
// maplibre-gl.js 803 KB + maplibre-gl.css 66 KB = ~869 KB, against 209 KB for the whole
// Chart.js UMD — a 4.2x jump in the floor size of EVERY export, map card or not. And it
// would not even buy a working map: MapLibre spins up a Web Worker (a second 352 KB
// file that a single-file export would have to smuggle in through a blob URL) and its
// tiles come from the network, so a "live" map in a file whose entire point is offline
// self-containment is a contradiction. The PNG is one image, already captured, already
// whitelisted by sanitizePng below, and it renders with the network off.
//
// SECRET-EXCLUSION GUARANTEE. The bundle is untrusted renderer input. `sanitizeBundle`
// WHITELISTS it field-by-field to a fixed primitive schema (labels/numbers/strings +
// `data:image` URIs only) — any key that is not part of that schema is DROPPED, so a
// stray config/connection field can never reach the file. This module never reads
// config.json, never touches a key, and never emits an http(s) URL of its own (all
// assets are inline / `data:` URIs), so the produced HTML carries only app-computed
// values + labels + PNGs — the same secret-free public view the git-share affordance
// advertises. Every number in the bundle was computed by the tested pure pipeline
// (buildVizData / computeMetric); this module only lays them out (strict-number rule
// untouched — it never computes a figure).

// The ONE non-pure-ish import: the shared style clamp. dashboards.ts is imported
// for `sanitizeStyle` rather than copying its three enums here, for the same
// reason dashboards.ts itself takes a value import of visuals.ts — duplicating a
// whitelist is how whitelists drift. It stays node-testable: dashboards.ts pulls
// no fs/DOM work at load (its `electron` import is never touched at module
// scope), so scripts/test-dashboardExport.ts still runs under bare `node` with
// no Electron stub.
import { sanitizeStyle } from './dashboards';
import { sanitizeFormatPrefs } from '../app/format';
import type { DashboardStyle } from './dashboards';

// The fixed grid column count (kept in sync with .dash-grid in hub.css / dashboards.ts).
const GRID_COLS = 12;

export type ExportCardKind = 'chart' | 'image' | 'metric' | 'text' | 'broken';

export interface ExportLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ExportSeries {
  label: string;
  values: (number | null)[];
}

export interface ExportChartData {
  labels: (string | number)[];
  series: ExportSeries[];
}

export interface ExportCard {
  kind: ExportCardKind;
  layout: ExportLayout;
  // chart
  chartType?: string;
  title?: string;
  data?: ExportChartData;
  /**
   * The project's colours (renderer/hub/fmtApply.ts), as RAMP SLOTS 0–7 that
   * the file's own ramp draws: `slots` per label for a chart that colours by
   * category (a pie's slices), `seriesSlots` per series. Integers only — a
   * slot indexes PALETTE, so no caller text ever reaches a style.
   */
  slots?: number[];
  seriesSlots?: number[];
  // image
  png?: string;
  // metric
  label?: string;
  /** What the figure is ("Sum of revenue") under the name its author gave it
   *  ("Revenue"). Empty when the two would be the same string. */
  subLabel?: string;
  value?: string | number | null;
  format?: string;
  // text
  heading?: string;
  text?: string;
  // broken
  reason?: string;
}

export interface ExportPage {
  name: string;
  cards: ExportCard[];
}

export interface ExportBundle {
  name: string;
  pages: ExportPage[];
  // Plain-text "<label>: <value> · <label>: <value>" for every control card's
  // CURRENT selection, dashboard-wide (Task 5). Controls never get a grid-cell
  // entry in an export (a static, non-interactive widget would be misleading —
  // "Do NOT export live controls"), so this is the ONLY trace of control state
  // that survives into the file: a header subtitle, plain string, never a
  // structured value per control.
  controlsSummary?: string;
  /**
   * The dashboard's {theme,density,accent} triple, so a shared file looks like
   * the dashboard it was exported from rather than always light-and-blue.
   *
   * This does NOT widen the secret-exclusion whitelist above. It is a CLOSED
   * ENUM clamp — sanitizeStyle can only ever return one of 3×2×3 fixed literals
   * it already knew — which is strictly TIGHTER than the `asString` fields
   * around it, since those pass arbitrary caller text through (safely, via
   * textContent) while this one cannot pass any caller text at all. That
   * matters because these three values are interpolated into a class attribute
   * and into the emitted <style> block, where an echoed string would not be.
   */
  style: DashboardStyle;
  /**
   * The brand, when one applies: an accent ramp the renderer computed from the
   * workspace's or the dashboard's hex (it owns the contrast walk), and the
   * logo for the header. Every colour must match COLOR_RE — `#rrggbb` or the
   * renderer's own `rgba(r, g, b, a)` spelling — because each one is
   * interpolated into the <style> block; the logo passes the PNG gate.
   */
  brand: { ramp?: AccentRamp; logo?: string };
}

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
  };
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

// Serialize a JS value for safe embedding inside a <script> tag: escape `<`/`>` (so a
// `</script>` in any string can't break out) and the U+2028/U+2029 line separators
// (which are literal newlines inside a JS string). The result is valid JSON AND a valid
// JS expression.
export function embedJson(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ── Style → literal tokens ────────────────────────────────────────────────────
//
// The tokens are TRANSCRIBED from the `.dash-theme--*` / `.dash-density--*` /
// `.dash-accent--*` blocks in renderer/hub/hub.css, not read from them: a
// standalone file has no access to the app's stylesheet, which is the same
// reason this module hardcoded the light theme before styles existed (and the
// same discipline as reportExport.buildReportHtml). The selector NAMES are kept
// identical to hub.css's on purpose, so the two can be diffed by eye when a
// colour moves.
//
// Only the CHOSEN triple is emitted, one block per axis. Shipping all three
// themes would be dead CSS in a file with no theme switcher — and it would put
// the light surface into a dark export, which is exactly the "looks like the
// original" bug this feature exists to fix.
//
// Source order below is theme → density → accent, the order hub.css mandates:
// accent owns --accent*/--chart* and has to win over the theme block's own copy
// of them at equal specificity.

// The token set each theme owns. Restricted to what THIS file's rules consume —
// the app's full 34-token set includes chrome (titlebar, ok/warn) an export has
// no surface for. --font-numeric is `inherit` except on Executive, where the
// serif KPI is half of what makes that theme recognizable.
const THEME_TOKENS: Record<DashboardStyle['theme'], string> = {
  // An exported file is a standalone document with no app around it to inherit
  // from, so 'auto' — which declares nothing in the app precisely so the sheet
  // follows the app — has to resolve to something concrete here. Light: an
  // export is for sharing and printing, and that is the neutral choice for a
  // document whose reader's preference we cannot know.
  auto: `--bg: #f7f7f8; --surface: #ffffff; --surface-2: #f3f4f6;
    --text: #18181b; --text-strong: #0f1117; --muted: #6b7280;
    --text-dim: #8a909c; --text-faint: #aeb4bf;
    --border: #e5e7eb; --border-2: #d6dae1;
    --font-numeric: inherit; --card-radius: 10px; --card-shadow: none;
    --kpi-size: 30px; --kpi-label-size: 13px; color-scheme: light;`,
  clean: `--bg: #f7f7f8; --surface: #ffffff; --surface-2: #f3f4f6;
    --text: #18181b; --text-strong: #0f1117; --muted: #6b7280;
    --text-dim: #8a909c; --text-faint: #aeb4bf;
    --border: #e5e7eb; --border-2: #d6dae1;
    --font-numeric: inherit; --card-radius: 10px; --card-shadow: none;
    --kpi-size: 30px; --kpi-label-size: 13px; color-scheme: light;`,
  executive: `--bg: #f6f4f1; --surface: #fffefc; --surface-2: #f2f0ec;
    --text: #23211e; --text-strong: #14120f; --muted: #6d6862;
    --text-dim: #8b857d; --text-faint: #b0aaa2;
    --border: #e4e0d9; --border-2: #d5d0c7;
    --font-numeric: ui-serif, Georgia, 'Times New Roman', serif;
    --card-radius: 14px; --card-shadow: 0 10px 28px -12px rgba(60, 50, 35, 0.2);
    --kpi-size: 34px; --kpi-label-size: 12.5px; color-scheme: light;`,
  dark: `--bg: #18181b; --surface: #232327; --surface-2: #2a2a30;
    --text: #ececee; --text-strong: #ffffff; --muted: #9ca3af;
    --text-dim: #6b7280; --text-faint: #52525b;
    --border: #2e2e33; --border-2: #3a3a42;
    --font-numeric: inherit; --card-radius: 10px; --card-shadow: none;
    --kpi-size: 30px; --kpi-label-size: 13px; color-scheme: dark;`,
};

// Density. --gap mirrors hub.css exactly (12/8); --row deliberately does NOT
// (hub is 48/36). An export has no chrome and its .chart-wrap floor is 120px, so
// a 2-row chart card on a 48px grid would overflow its own cell — the export has
// always used a taller row. What matters is that the two scale by the SAME ratio
// as the app, so a compact dashboard reads as compact here too.
//
// comfortable carries the sizes compact overrides, EXCEPT the two KPI sizes:
// those belong to the theme (Executive's KPI is larger), and compact still wins
// over both by source order — the same interaction hub.css relies on.
const DENSITY_TOKENS: Record<DashboardStyle['density'], string> = {
  comfortable: `--gap: 12px; --row: 80px; --card-pad: 12px;
    --card-title-size: 12px; --text-h-size: 16px; --text-p-size: 13px;`,
  compact: `--gap: 8px; --row: 60px; --card-pad: 8px;
    --card-title-size: 10px; --text-h-size: 12.5px; --text-p-size: 12px;
    --kpi-size: 20px; --kpi-label-size: 11px;`,
};

// Accent ramps, keyed `<accent>` for the light themes and `<accent>-dark` for
// the dark one. The dark ramps are NOT a shade of the light ones: hub.css
// carries a separate `.dash-theme--dark.dash-accent--*` set because the light
// hues go muddy on #232327 (slate worst of all — #475569 is nearly invisible
// there, so its whole ramp moves to the light half of the scale).
export interface AccentRamp {
  accent: string;
  accent2: string;
  soft: string;
  line: string;
  chart: string[]; // --chart-1..8, and [0] is --chart-accent
}
const ACCENT_RAMPS: Record<string, AccentRamp> = {
  blue: { accent: '#2563eb', accent2: '#1d4fd0', soft: 'rgba(37, 99, 235, 0.08)', line: 'rgba(37, 99, 235, 0.22)',
    chart: ['#2563eb', '#0e7490', '#14b8a6', '#6366f1', '#64748b', '#b45309', '#be185d', '#4d7c0f'] },
  teal: { accent: '#0d9488', accent2: '#0f766e', soft: 'rgba(13, 148, 136, 0.09)', line: 'rgba(13, 148, 136, 0.24)',
    chart: ['#0d9488', '#0e7490', '#2563eb', '#4f46e5', '#64748b', '#b45309', '#be185d', '#4d7c0f'] },
  slate: { accent: '#475569', accent2: '#334155', soft: 'rgba(71, 85, 105, 0.08)', line: 'rgba(71, 85, 105, 0.22)',
    chart: ['#475569', '#64748b', '#0f766e', '#7e8ba3', '#a1a8b5', '#8b6f47', '#6b5b95', '#5f7f6f'] },
  'blue-dark': { accent: '#3b82f6', accent2: '#2f6fe0', soft: 'rgba(59, 130, 246, 0.16)', line: 'rgba(59, 130, 246, 0.32)',
    chart: ['#3b82f6', '#22d3ee', '#2dd4bf', '#818cf8', '#94a3b8', '#fbbf24', '#f472b6', '#a3e635'] },
  'teal-dark': { accent: '#2dd4bf', accent2: '#14b8a6', soft: 'rgba(45, 212, 191, 0.16)', line: 'rgba(45, 212, 191, 0.32)',
    chart: ['#2dd4bf', '#22d3ee', '#60a5fa', '#818cf8', '#94a3b8', '#fbbf24', '#f472b6', '#a3e635'] },
  'slate-dark': { accent: '#94a3b8', accent2: '#b6c2d1', soft: 'rgba(148, 163, 184, 0.16)', line: 'rgba(148, 163, 184, 0.32)',
    chart: ['#94a3b8', '#cbd5e1', '#5eead4', '#a5b4fc', '#78859a', '#b5a07a', '#b8a9d9', '#9fc5a8'] },
};

// `style` is already clamped by sanitizeStyle, so both halves of the key are one
// of a fixed set of literals and the lookup can never miss.
// A brand ramp (sanitizeBrand) replaces the named one wholesale.
export function accentRamp(style: DashboardStyle, brand?: ExportBundle['brand']): AccentRamp {
  if (brand && brand.ramp) return brand.ramp;
  return ACCENT_RAMPS[style.theme === 'dark' ? style.accent + '-dark' : style.accent];
}

// The three class names the exported document carries, in hub.css's own spelling.
export function styleClasses(style: DashboardStyle): string {
  return `dash-theme--${style.theme} dash-density--${style.density} dash-accent--${style.accent}`;
}

// Theme + density + accent tokens, then the layout rules that consume them. The
// rules are token-only — that is what lets one style change repaint the whole
// document without a second copy of every rule per theme.
export function styleBlock(style: DashboardStyle, brand?: ExportBundle['brand']): string {
  const ramp = accentRamp(style, brand);
  const chartVars = ramp.chart.map((c, i) => `--chart-${i + 1}: ${c};`).join(' ');
  return `
    .dash-theme--${style.theme} { ${THEME_TOKENS[style.theme]} }
    .dash-density--${style.density} { ${DENSITY_TOKENS[style.density]} }
    .dash-accent--${style.accent} { --accent: ${ramp.accent}; --accent-2: ${ramp.accent2};
      --accent-soft: ${ramp.soft}; --accent-line: ${ramp.line};
      --chart-accent: ${ramp.chart[0]}; ${chartVars} }

    * { box-sizing: border-box; }
    html, body { margin: 0; background: var(--bg); color: var(--text);
      font-family: -apple-system, system-ui, 'Hanken Grotesk', 'Segoe UI', sans-serif; }
    .dash-root { max-width: 1200px; margin: 0 auto; padding: 24px 20px 40px; }
    .dash-title { font-size: 22px; font-weight: 700; margin: 0 0 4px; color: var(--text-strong); }
    .dash-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
    .dash-logo { max-width: 160px; max-height: 32px; object-fit: contain; }
    .dash-controls-summary { font-size: 13px; font-weight: 500; color: var(--muted); margin: 0 0 16px; }
    .dash-page { margin-bottom: 28px; }
    .dash-page-title { font-size: 15px; font-weight: 600; color: var(--muted); margin: 0 0 10px; }
    .dash-grid { display: grid; grid-template-columns: repeat(${GRID_COLS}, 1fr);
      grid-auto-rows: var(--row); gap: var(--gap); }
    .dash-card { background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--card-radius); box-shadow: var(--card-shadow);
      padding: var(--card-pad); overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
    .dash-card-title { font-size: var(--card-title-size); font-weight: 600; color: var(--muted); margin: 0 0 8px;
      text-transform: uppercase; letter-spacing: .03em; }
    .chart-wrap { position: relative; flex: 1 1 auto; min-height: 120px; }
    .chart-wrap canvas { max-width: 100%; }
    .dash-img { max-width: 100%; max-height: 100%; object-fit: contain; margin: auto; }
    /* Centred in the tile, like .dash-card--metric .dash-card-body in hub.css.
       The figure used to be pinned bottom-left by a lone \`margin-top: auto\`,
       which read as a mistake in a tall card — and disagreed with the PNG. */
    .dash-metric-box { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center; text-align: center; gap: 4px; }
    .dash-metric-value { font-size: var(--kpi-size); font-weight: 700; color: var(--text-strong);
      font-family: var(--font-numeric); font-variant-numeric: tabular-nums; line-height: 1.1; }
    .dash-metric-sub { font-size: var(--kpi-label-size); color: var(--muted); }
    .dash-text-heading { font-size: var(--text-h-size); font-weight: 600; color: var(--text-strong); margin: 0 0 6px; }
    .dash-text-body { font-size: var(--text-p-size); color: var(--text); white-space: pre-wrap; }
    .dash-card--broken { border-style: dashed; border-color: var(--border-2); background: var(--surface-2);
      box-shadow: none; align-items: center; justify-content: center; text-align: center; color: var(--text-dim); }
    .dash-broken-badge { font-size: 11px; font-weight: 600; text-transform: uppercase;
      letter-spacing: .04em; color: var(--text-faint); }
    .dash-broken-reason { font-size: 12px; color: var(--text-faint); margin-top: 4px; }
  `;
}

// The vanilla render script embedded in the file. It reads `window.__DASHBOARD__`, lays
// each card on a CSS grid, and draws chart cards with the inlined Chart.js. All text is
// set via textContent (never innerHTML) so a label/heading can't inject markup.
function renderScript(style: DashboardStyle, brand?: ExportBundle['brand']): string {
  const palette = accentRamp(style, brand).chart.map((c) => `'${c}'`).join(',');
  return `
(function () {
  var D = window.__DASHBOARD__;
  // The SAME ramp the stylesheet above uses. It was a fixed eight-colour list,
  // which meant an exported dark or Executive dashboard drew its chrome in the
  // chosen style and its bars in the default blue-green-orange.
  var PALETTE = [${palette}];
  var root = document.getElementById('dash-root');
  document.title = D.name || 'Dashboard';
  var h1 = document.createElement('h1'); h1.className = 'dash-title'; h1.textContent = D.name || 'Dashboard';
  if (D.brand && D.brand.logo) {
    var head = document.createElement('div'); head.className = 'dash-head';
    var logo = document.createElement('img'); logo.className = 'dash-logo'; logo.alt = ''; logo.src = D.brand.logo;
    head.appendChild(h1); head.appendChild(logo); root.appendChild(head);
  } else root.appendChild(h1);
  if (typeof D.controlsSummary === 'string' && D.controlsSummary) {
    var sub = document.createElement('div'); sub.className = 'dash-controls-summary'; sub.textContent = D.controlsSummary;
    root.appendChild(sub);
  }

  var multiPage = D.pages.length > 1;
  D.pages.forEach(function (page) {
    var section = document.createElement('section'); section.className = 'dash-page';
    if (multiPage) {
      var pt = document.createElement('h2'); pt.className = 'dash-page-title'; pt.textContent = page.name;
      section.appendChild(pt);
    }
    var grid = document.createElement('div'); grid.className = 'dash-grid';
    page.cards.forEach(function (card) {
      var L = card.layout || { x: 0, y: 0, w: 1, h: 1 };
      var cell = document.createElement('div'); cell.className = 'dash-card dash-card--' + card.kind;
      cell.style.gridColumn = ((L.x || 0) + 1) + ' / span ' + (L.w || 1);
      cell.style.gridRow = ((L.y || 0) + 1) + ' / span ' + (L.h || 1);
      try { renderCard(cell, card); } catch (e) { renderBroken(cell, 'Render error'); }
      grid.appendChild(cell);
    });
    section.appendChild(grid);
    root.appendChild(section);
  });

  function titleEl(text) {
    var t = document.createElement('div'); t.className = 'dash-card-title'; t.textContent = text; return t;
  }

  function renderCard(cell, card) {
    if (card.kind === 'chart') return renderChart(cell, card);
    if (card.kind === 'image') return renderImage(cell, card);
    if (card.kind === 'metric') return renderMetric(cell, card);
    if (card.kind === 'text') return renderText(cell, card);
    return renderBroken(cell, card.reason);
  }

  function renderChart(cell, card) {
    if (card.title) cell.appendChild(titleEl(card.title));
    var wrap = document.createElement('div'); wrap.className = 'chart-wrap';
    var canvas = document.createElement('canvas'); wrap.appendChild(canvas); cell.appendChild(wrap);
    if (typeof window.Chart !== 'function') { renderBroken(cell, 'Chart engine unavailable'); return; }
    var d = card.data || { labels: [], series: [] };
    var radial = card.chartType === 'pie' || card.chartType === 'doughnut';
    // The project's colours: a slot per label (a pie's slices, bars coloured
    // by category) or per series; by position where there are none.
    var slot = function (k) { return PALETTE[k % PALETTE.length]; };
    var perLabel = card.slots ? card.slots.map(slot) : null;
    var datasets = (d.series || []).map(function (s, i) {
      var c = slot(card.seriesSlots ? card.seriesSlots[i] : i);
      var bg = perLabel || (radial ? d.labels.map(function (_, j) { return slot(j); }) : c);
      return { label: s.label, data: s.values, backgroundColor: bg, borderColor: radial ? bg : c, borderWidth: 2, fill: false };
    });
    // The app's formatter, when the file carries it: 5.2M on the axis, the
    // full figure in the tooltip — as in the app.
    var F = typeof OrdFormat === 'object' && OrdFormat ? OrdFormat : null;
    var options = { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: datasets.length > 1 } } };
    if (F) {
      options.plugins.tooltip = { callbacks: { label: function (c) {
        var v = typeof c.parsed === 'number' ? c.parsed : c.parsed.y;
        return (c.dataset.label ? c.dataset.label + ': ' : '') + F.formatNumber(v, { maxDecimals: 2 });
      } } };
      if (!radial) options.scales = { y: { ticks: { callback: function (v) { return F.formatCompact(v); } } } };
    }
    new window.Chart(canvas.getContext('2d'), {
      type: card.chartType || 'bar',
      data: { labels: d.labels, datasets: datasets },
      options: options
    });
  }

  function renderImage(cell, card) {
    if (card.title) cell.appendChild(titleEl(card.title));
    var img = document.createElement('img'); img.className = 'dash-img'; img.src = card.png;
    img.alt = card.title || 'chart'; cell.appendChild(img);
  }

  function renderMetric(cell, card) {
    // Label in the card's title line like every other card type, figure centred
    // under it, and the aggregation it came from beneath that.
    if (card.label) cell.appendChild(titleEl(card.label));
    var box = document.createElement('div'); box.className = 'dash-metric-box';
    var v = document.createElement('div'); v.className = 'dash-metric-value';
    v.textContent = (card.value === null || card.value === undefined) ? '—' : String(card.value);
    box.appendChild(v);
    if (card.subLabel) {
      var s = document.createElement('div'); s.className = 'dash-metric-sub'; s.textContent = card.subLabel;
      box.appendChild(s);
    }
    cell.appendChild(box);
  }

  function renderText(cell, card) {
    if (card.heading) { var h = document.createElement('div'); h.className = 'dash-text-heading'; h.textContent = card.heading; cell.appendChild(h); }
    if (card.text) { var b = document.createElement('div'); b.className = 'dash-text-body'; b.textContent = card.text; cell.appendChild(b); }
  }

  function renderBroken(cell, reason) {
    cell.className = 'dash-card dash-card--broken';
    cell.textContent = '';
    var badge = document.createElement('div'); badge.className = 'dash-broken-badge'; badge.textContent = 'Unavailable';
    cell.appendChild(badge);
    var r = document.createElement('div'); r.className = 'dash-broken-reason'; r.textContent = reason || 'Source removed';
    cell.appendChild(r);
  }
})();
`;
}

// Assemble the full offline HTML document: <style> + inlined Chart.js UMD +
// `window.__DASHBOARD__ = {…}` + the render script. `chartLibJs` is the raw text of
// node_modules/chart.js/dist/chart.umd.min.js, supplied by the MAIN handler (read off
// disk, never fetched). Pure string assembly → node-testable.
//
// `format` is the app's own formatter (src/app/format.js, read off disk by the
// handler) and the workspace's prefs, so the file's axes and tooltips print
// numbers the way the app does. Loaded the way the hub loads it (cjsShim.ts);
// without it Chart.js's defaults stand.
export function buildSelfContainedHtml(bundle: unknown, chartLibJs: string, format?: { js: string; prefs: unknown }): string {
  const clean = sanitizeBundle(bundle);
  const lib = typeof chartLibJs === 'string' ? chartLibJs : '';
  const fmt = format && typeof format.js === 'string' && format.js
    ? `<script>var module = { exports: {} }; var exports = module.exports;</script>
<script>${format.js.replace(/<\/script/gi, '<\\/script')}</script>
<script>var OrdFormat = module.exports; OrdFormat.setFormatPrefs(${embedJson(sanitizeFormatPrefs(format.prefs))});</script>`
    : '';
  const titleText = clean.name.replace(/[<>]/g, '');
  // The style classes go on <html>, not on #dash-root. They declare the tokens,
  // and `html, body { background: var(--bg) }` below is an ANCESTOR of that div
  // — so on the div they left the page itself unstyled: `var(--bg)` resolved to
  // nothing and the body fell back to white, which is invisible on a light
  // export and a white frame around a DARK one. hub.css's own note says these
  // are plain class selectors precisely so the element may be <html>.
  return `<!doctype html>
<html lang="en" class="${styleClasses(clean.style)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleText || 'Dashboard'}</title>
<style>${styleBlock(clean.style, clean.brand)}</style>
</head>
<body>
<div id="dash-root" class="dash-root"></div>
<script>${lib}</script>
${fmt}
<script>window.__DASHBOARD__ = ${embedJson(clean)};</script>
<script>${renderScript(clean.style, clean.brand)}</script>
</body>
</html>`;
}
