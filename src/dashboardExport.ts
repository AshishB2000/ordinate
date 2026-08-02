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
  // image
  png?: string;
  // metric
  label?: string;
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

function sanitizeLayout(raw: unknown): ExportLayout {
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

function sanitizeChartData(raw: unknown): ExportChartData {
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
function sanitizePng(v: unknown): string {
  return typeof v === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(v) ? v : '';
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
    return { kind: 'chart', layout, chartType, title: asString(o.title), data };
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
    return { kind: 'metric', layout, label: asString(o.label), value, format: asString(o.format) };
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
  return { name: asString(o.name) || 'Dashboard', pages };
}

// Serialize a JS value for safe embedding inside a <script> tag: escape `<`/`>` (so a
// `</script>` in any string can't break out) and the U+2028/U+2029 line separators
// (which are literal newlines inside a JS string). The result is valid JSON AND a valid
// JS expression.
function embedJson(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// Light-theme tokens mirror renderer/theme.css (kept literal — a standalone file can't
// read the app's CSS vars), same discipline as reportExport.buildReportHtml.
function styleBlock(): string {
  return `
    * { box-sizing: border-box; }
    html, body { margin: 0; background: #f4f4f5; color: #18181b;
      font-family: -apple-system, system-ui, 'Hanken Grotesk', 'Segoe UI', sans-serif; }
    .dash-root { max-width: 1200px; margin: 0 auto; padding: 24px 20px 40px; }
    .dash-title { font-size: 22px; font-weight: 700; margin: 0 0 16px; color: #0f1117; }
    .dash-page { margin-bottom: 28px; }
    .dash-page-title { font-size: 15px; font-weight: 600; color: #6b7280; margin: 0 0 10px; }
    .dash-grid { display: grid; grid-template-columns: repeat(${GRID_COLS}, 1fr);
      grid-auto-rows: 80px; gap: 12px; }
    .dash-card { background: #ffffff; border: 1px solid #e4e4e7; border-radius: 10px;
      padding: 12px; overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
    .dash-card-title { font-size: 12px; font-weight: 600; color: #6b7280; margin: 0 0 8px;
      text-transform: uppercase; letter-spacing: .03em; }
    .chart-wrap { position: relative; flex: 1 1 auto; min-height: 120px; }
    .chart-wrap canvas { max-width: 100%; }
    .dash-img { max-width: 100%; max-height: 100%; object-fit: contain; margin: auto; }
    .dash-metric-value { font-size: 30px; font-weight: 700; color: #0f1117; margin-top: auto; }
    .dash-metric-label { font-size: 13px; color: #6b7280; }
    .dash-text-heading { font-size: 16px; font-weight: 600; color: #0f1117; margin: 0 0 6px; }
    .dash-text-body { font-size: 13px; color: #3f3f46; white-space: pre-wrap; }
    .dash-card--broken { border-style: dashed; border-color: #d4d4d8; background: #fafafa;
      align-items: center; justify-content: center; text-align: center; color: #9ca3af; }
    .dash-broken-badge { font-size: 11px; font-weight: 600; text-transform: uppercase;
      letter-spacing: .04em; color: #a1a1aa; }
    .dash-broken-reason { font-size: 12px; color: #b4b4bb; margin-top: 4px; }
  `;
}

// The vanilla render script embedded in the file. It reads `window.__DASHBOARD__`, lays
// each card on a CSS grid, and draws chart cards with the inlined Chart.js. All text is
// set via textContent (never innerHTML) so a label/heading can't inject markup.
function renderScript(): string {
  return `
(function () {
  var D = window.__DASHBOARD__;
  var PALETTE = ['#2563eb','#16a34a','#ea580c','#9333ea','#0891b2','#dc2626','#ca8a04','#4f46e5'];
  var root = document.getElementById('dash-root');
  document.title = D.name || 'Dashboard';
  var h1 = document.createElement('h1'); h1.className = 'dash-title'; h1.textContent = D.name || 'Dashboard';
  root.appendChild(h1);

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
    var datasets = (d.series || []).map(function (s, i) {
      var c = PALETTE[i % PALETTE.length];
      return { label: s.label, data: s.values, backgroundColor: c, borderColor: c, borderWidth: 2, fill: false };
    });
    new window.Chart(canvas.getContext('2d'), {
      type: card.chartType || 'bar',
      data: { labels: d.labels, datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: datasets.length > 1 } }
      }
    });
  }

  function renderImage(cell, card) {
    if (card.title) cell.appendChild(titleEl(card.title));
    var img = document.createElement('img'); img.className = 'dash-img'; img.src = card.png;
    img.alt = card.title || 'chart'; cell.appendChild(img);
  }

  function renderMetric(cell, card) {
    if (card.label) { var l = document.createElement('div'); l.className = 'dash-metric-label'; l.textContent = card.label; cell.appendChild(l); }
    var v = document.createElement('div'); v.className = 'dash-metric-value';
    v.textContent = (card.value === null || card.value === undefined) ? '—' : String(card.value);
    cell.appendChild(v);
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
export function buildSelfContainedHtml(bundle: unknown, chartLibJs: string): string {
  const clean = sanitizeBundle(bundle);
  const lib = typeof chartLibJs === 'string' ? chartLibJs : '';
  const titleText = clean.name.replace(/[<>]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleText || 'Dashboard'}</title>
<style>${styleBlock()}</style>
</head>
<body>
<div id="dash-root" class="dash-root"></div>
<script>${lib}</script>
<script>window.__DASHBOARD__ = ${embedJson(clean)};</script>
<script>${renderScript()}</script>
</body>
</html>`;
}
