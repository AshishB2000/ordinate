// One published page as an HTML string — PURE (no fs), so the
// whole assembly is node-testable.
//
// A page is: the dashboard's style tokens (dashboardExport.styleBlock — the
// same tokens an HTML export carries) plus the site's layout CSS; the app's
// own scripts, inlined in order — Chart.js, the formatter, the geo matcher,
// the published renderer (./site/publishCore.js + publishWords.js, publishPhone.js, then the
// client: publishTiles.js, publishMaps.js, publishPages.js, publishClient.js);
// and the page's data as a NON-EXECUTED JSON block, sanitized by
// ./sanitize.ts. Nothing else.
//
// THE CSP IS THE PROOF. Every page carries a Content-Security-Policy meta that
// allows exactly the inline scripts and the one stylesheet it was built with,
// pinned by SHA-256 — `default-src 'none'`, no 'unsafe-inline', images only
// from `data:`. A script that is not one of the app's own, or any network
// request at all, would be refused by the browser opening the file, not just
// absent by construction.

import { createHash } from 'crypto';
import { autoSchemeCss, styleBlock, styleClasses, embedJson } from '../analysis/dashboardExport';
import { sanitizeStyle, sizeLayout } from '../analysis/dashboards';
import type { DashboardStyle } from '../analysis/dashboards';
import { phoneCss } from './sitePhoneCss';

/** The app's own scripts, read off disk by the caller (./publish.ts). */
export interface SiteAssets {
  chartJs: string;
  formatJs: string;
  geoMatchJs: string;
  coreJs: string;
  /** The phone pieces CSS cannot build: a swipeable sheet, the KPI strip's dots (docs/phone-dashboards). */
  phoneJs: string;
  clientJs: string;
}

const SITE_CSS = `
  html { --pub-pad-x: 20px; }
  body { min-height: 100vh; }
  .pub-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
    padding: 12px var(--pub-pad-x); background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 2; }
  .pub-brand { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; color: var(--text-strong); font-weight: 700; }
  .pub-logo { max-height: 28px; max-width: 140px; object-fit: contain; }
  .pub-nav { display: flex; gap: 4px; flex-wrap: wrap; }
  .pub-nav-link { padding: 6px 10px; border-radius: 8px; color: var(--muted); text-decoration: none; font-size: 13px; font-weight: 500; }
  .pub-nav-link:hover { background: var(--surface-2); color: var(--text-strong); }
  .pub-nav-link[aria-current="page"] { background: var(--accent-soft); color: var(--accent); }
  .pub-root { padding: 28px var(--pub-pad-x) 56px; }
  .pub-embedded { min-height: 0; } .pub-embedded .pub-root { padding: 16px 20px 20px; }
  .pub-title { font-size: 28px; font-weight: 600; letter-spacing: -.015em; line-height: 1.2; margin: 0 0 6px; color: var(--text-strong); }
  .pub-takeaway { font-size: 15px; line-height: 1.5; color: var(--text); margin: 0; max-width: 90ch; }
  .pub-takeaway strong { font-weight: 600; color: var(--text-strong); }
  .pub-filters { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: flex-end; margin: 18px 0 6px; padding: 12px 16px;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--card-radius); }
  .pub-filter { display: flex; flex-direction: column; gap: 5px; min-width: 180px; }
  .pub-filter-label { font-size: 12px; font-weight: 500; color: var(--muted); }
  .pub-filter-select { font: inherit; font-size: 13px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border-2);
    background: var(--surface); color: var(--text-strong); cursor: pointer; }
  .pub-filter-select:hover { border-color: var(--text-faint); }
  .pub-filter-select:focus-visible { outline: 2px solid var(--accent-line); outline-offset: 1px; border-color: var(--accent); }
  .pub-hint { font-size: 12px; color: var(--text-dim); margin: 0; }
  .pub-tabs { display: flex; gap: 2px; margin: 18px 0 0; border-bottom: 1px solid var(--border); }
  .pub-tab { font: inherit; font-size: 14px; font-weight: 500; background: none; border: 0; border-bottom: 2px solid transparent; margin-bottom: -1px;
    padding: 10px 14px; color: var(--muted); cursor: pointer; }
  .pub-tab:hover { color: var(--text-strong); }
  .pub-tab[aria-selected="true"] { color: var(--text-strong); border-bottom-color: var(--accent); }
  .pub-grid { display: grid; grid-template-columns: repeat(12, 1fr); grid-auto-rows: var(--row); gap: var(--gap); margin-top: 16px; }
  .pub-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--card-radius);
    box-shadow: var(--card-shadow); padding: calc(var(--card-pad) + 6px); display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
  .pub-card-title { font-size: var(--text-h-size); font-weight: 500; line-height: 1.3; color: var(--text-strong); margin: 0 0 12px; }
  .pub-card-title:has(+ .pub-card-note) { margin-bottom: 2px; }
  .pub-card-note { font-size: 12.5px; line-height: 1.4; color: var(--muted); margin: 0 0 12px; }
  .pub-chart { position: relative; flex: 1 1 auto; min-height: 120px; }
  .pub-kpi { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 4px; }
  .pub-kpi-value { font-size: var(--kpi-size); font-weight: 600; letter-spacing: -.02em; color: var(--text-strong); font-family: var(--font-numeric);
    font-variant-numeric: tabular-nums; line-height: 1.1; }
  .pub-kpi-label { font-size: var(--kpi-label-size); color: var(--muted); }
  .pub-card--metric { justify-content: center; }
  .pub-card--metric > .pub-card-title { font-size: var(--kpi-label-size); color: var(--muted); margin-bottom: 6px; }
  .pub-card--metric > .pub-card-note { margin: -2px 0 8px; }
  .pub-kpi--card { flex: 0 0 auto; align-items: flex-start; justify-content: flex-start; text-align: left; gap: 6px; }
  .pub-kpi-change { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; font-size: 12.5px; line-height: 1.35; color: var(--muted);
    font-variant-numeric: tabular-nums; }
  .pub-kpi-delta { font-weight: 600; }
  .pub-tone--good { color: #059669; } .pub-tone--bad { color: #e11d48; } .pub-tone--flat { color: var(--muted); }
  .dash-theme--dark .pub-tone--good { color: #10b981; } .dash-theme--dark .pub-tone--bad { color: #ef4444; }
  @media (prefers-color-scheme: dark) { .dash-theme--auto .pub-tone--good { color: #10b981; } .dash-theme--auto .pub-tone--bad { color: #ef4444; } }
  .pub-kpi-spark { display: block; width: 100%; height: 28px; margin-top: 2px; color: var(--accent); }
  /* A tile with a trend reads top down and gives the trend what the tile has left (a Scorecard's tall tiles). */
  .pub-card--metric:has(.pub-kpi-spark) { justify-content: flex-start; }
  .pub-card--metric:has(.pub-kpi-spark) > .pub-kpi--card { flex: 1 1 auto; }
  .pub-kpi--card > .pub-kpi-spark { flex: 1 1 28px; height: auto; min-height: 28px; max-height: 120px; margin-top: 8px; }
  .pub-kpi-spark path { fill: none; stroke: currentColor; stroke-width: 1.75; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
  .pub-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
  .pub-caption { font-size: 12.5px; color: var(--muted); margin: 10px 0 0; line-height: 1.45; }
  .pub-note { font-size: 11px; color: var(--text-dim); margin: 6px 0 0; }
  .pub-text-h { font-size: var(--text-h-size); font-weight: 600; margin: 0 0 6px; color: var(--text-strong); }
  .pub-text-p { font-size: var(--text-p-size); margin: 0 0 8px; white-space: pre-wrap; }
  .pub-broken { margin: auto; font-size: 12px; color: var(--text-faint); text-align: center; }
  .pub-card--broken { border-style: dashed; background: var(--surface-2); box-shadow: none; }
  .pub-table-wrap { flex: 1 1 auto; overflow: auto; min-height: 0; }
  .pub-rich { flex: 1 1 auto; display: flex; flex-direction: column; gap: 8px; min-height: 0; }
  .pub-rich-search { font: inherit; font-size: 13px; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border-2);
    background: var(--surface); color: var(--text-strong); }
  .pub-rich-table th, .pub-rich-table td { padding: 8px 12px; }
  .pub-rich-table tbody tr:hover > * { background: var(--surface-2); }
  .pub-rich-table th.num { text-align: right; }
  .pub-sort { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: pointer; }
  .pub-sort:hover { color: var(--text-strong); }
  .pub-rich-table th[aria-sort="ascending"] .pub-sort::after { content: " ▲"; color: var(--accent); font-size: .8em; }
  .pub-rich-table th[aria-sort="descending"] .pub-sort::after { content: " ▼"; color: var(--accent); font-size: .8em; }
  .pub-bar-cell { min-width: 120px; }
  .pub-track { display: block; height: 6px; margin-top: 4px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
  .pub-bar { display: block; height: 100%; border-radius: inherit; background: var(--chart-1); }
  .pub-bar--neg { background: #e11d48; }
  .pub-table { border-collapse: collapse; font-size: 12px; width: 100%; }
  .pub-table th, .pub-table td { padding: 4px 8px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
  .pub-table thead th { position: sticky; top: 0; background: var(--surface); color: var(--muted); font-weight: 600; }
  .pub-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pub-pivot tr.subtotal, .pub-pivot tr.grand { font-weight: 600; background: var(--surface-2); }
  .pub-pivot td.total { font-weight: 600; }
  .pub-map-wrap { flex: 1 1 auto; min-height: 0; display: flex; }
  .pub-map { width: 100%; height: 100%; }
  .pub-land { fill: var(--surface-2); stroke: var(--border-2); stroke-width: .5; }
  .pub-region { fill: var(--accent); stroke: var(--surface); stroke-width: .5; }
  .pub-point { fill: var(--accent); fill-opacity: .55; stroke: var(--surface); stroke-width: 1; }
  .pub-flow { fill: none; stroke: var(--accent); stroke-opacity: .6; stroke-linecap: round; }
  .pub-index { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; margin-top: 18px; }
  .pub-index-card { display: flex; flex-direction: column; gap: 6px; padding: 18px; border-radius: var(--card-radius);
    background: var(--surface); border: 1px solid var(--border); text-decoration: none; color: var(--text-strong); }
  .pub-index-card:hover { border-color: var(--accent-line); box-shadow: 0 8px 24px -16px rgba(0,0,0,.35); }
  .pub-index-kind { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--accent); }
  .pub-index-name { font-size: 16px; font-weight: 600; }
  .pub-empty, .pub-foot { color: var(--muted); font-size: 13px; }
  .pub-foot { margin-top: 32px; }
  .pub-story { max-width: 760px; margin: 0 auto; } .pub-story > .pub-title { margin-bottom: 18px; }
  .pub-story-p { font-size: 15px; line-height: 1.65; margin: 0 0 14px; white-space: pre-wrap; }
  .pub-story-chart { height: 380px; margin: 18px 0; }
  .pub-metrics-row { display: flex; gap: 12px; margin: 18px 0 4px; }
  .pub-metrics-row .pub-kpi { background: var(--surface); border: 1px solid var(--border); border-radius: var(--card-radius); padding: 16px; }
  .pub-callout { border-left: 3px solid var(--accent); background: var(--accent-soft); padding: 10px 14px; border-radius: 8px; margin: 14px 0; }
  .pub-callout--warning { border-left-color: #c77d11; } .pub-callout--danger { border-left-color: #e11d48; }
  .pub-callout--success { border-left-color: #059669; }
  .pub-divider { border: 0; border-top: 1px solid var(--border); margin: 24px 0; }
  .pub-figure { margin: 18px 0; } .pub-figure img { max-width: 100%; border-radius: 8px; }
  .pub-sc-period { margin: 0 0 12px; color: var(--muted); font-size: 13px; }
  .pub-sc-summary { display: flex; gap: 16px; margin: 0 0 12px; font-size: 13px; color: var(--text-dim); }
  .pub-sc-sum { display: inline-flex; align-items: center; gap: 6px; } .pub-sc-sum strong { color: var(--text-strong); }
  .pub-sc-card { padding: 0; } .pub-sc-table { font-size: 13px; } .pub-sc-table td { padding: 10px 12px; }
  .pub-sc-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--border-2); }
  .pub-sc-dot--good { background: #10b981; } .pub-sc-dot--warn { background: #f59e0b; } .pub-sc-dot--off { background: #ef4444; }
  .pub-sc-name { font-weight: 600; color: var(--text-strong); } .pub-sc-value { font-weight: 700; color: var(--text-strong); }
  .pub-sc-group td { background: var(--surface-2); font-weight: 600; color: var(--text-strong); font-size: 12px; }
  .pub-sc-bar { display: inline-block; width: 70px; height: 6px; margin-right: 8px; border-radius: 3px; background: var(--surface-2); vertical-align: middle; overflow: hidden; }
  .pub-sc-fill { display: block; height: 100%; background: var(--text-faint); }
  .pub-sc-bar--good .pub-sc-fill { background: #10b981; } .pub-sc-bar--warn .pub-sc-fill { background: #f59e0b; } .pub-sc-bar--off .pub-sc-fill { background: #ef4444; }
  .pub-sc-tone--good { color: #059669; } .pub-sc-tone--bad { color: #e11d48; }
  .pub-sc-spark path { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
  .pub-sc-spark-cell { color: var(--accent); } .pub-sc-dot-c--good { color: #10b981; } .pub-sc-dot-c--warn { color: #f59e0b; } .pub-sc-dot-c--off { color: #ef4444; }
`;

/**
 * `.pub-root`'s side padding, twice, up to the tablet line: a page's grid is this much narrower than its
 * window there. Wider, the page is fluid and its padding grows with it (--pub-pad-x, below) — past the
 * last breakpoint, so no threshold moves.
 */
const PAGE_PAD_X = 40;

/**
 * The three layouts, switched by CSS alone. Every tile carries all three cells
 * as custom properties (./site/publishClient.ts); a breakpoint only
 * changes which pair `grid-column` / `grid-row` read and how many tracks the
 * grid has. The thresholds are the hub's own — sizeLayout.BREAKPOINTS, which
 * measure the DASHBOARD's width — moved out by the page padding, since a media
 * query can only see the window. A cell a page lacks falls back to a full row.
 */
export function sizeCss(): string {
  const bp = sizeLayout.BREAKPOINTS;
  const cols = sizeLayout.COLS;
  const phoneMax = bp.phone + PAGE_PAD_X - 1;
  const tabletMax = bp.tablet + PAGE_PAD_X - 1;
  return `
  .pub-grid > .pub-card { grid-column: var(--pc-d-col, auto); grid-row: var(--pc-d-row, auto); }
  .pub-filters-open, .pub-filters-done { display: none; }
  .pub-dashhead, .pub-dashhead-ident { display: contents; }
  .pub-dashhead-stamp, .pub-kpis, .pub-scrim, .pub-filters-grab, .pub-filters-foot { display: none; }
  @media (min-width: ${tabletMax + 1}px) { html { --pub-pad-x: clamp(20px, 3vw, 40px); } }
  @media (min-width: ${phoneMax + 1}px) and (max-width: ${tabletMax}px) {
    .pub-grid { grid-template-columns: repeat(${cols.tablet}, minmax(0, 1fr)); }
    .pub-grid > .pub-card { grid-column: var(--pc-t-col, 1 / -1); grid-row: var(--pc-t-row, auto); }
    .pub-grid > .pub-hide-t { display: none; }
  }
  @media (max-width: ${phoneMax}px) {
    .pub-grid { grid-template-columns: repeat(${cols.phone}, minmax(0, 1fr)); }
    .pub-grid > .pub-card { grid-column: var(--pc-p-col, 1 / -1); grid-row: var(--pc-p-row, auto); }
    .pub-grid > .pub-hide-p { display: none; }
  }
` + phoneCss(phoneMax);
}

// The page's icon, inline (a 1×1 transparent GIF). Without one a browser asks
// the server for /favicon.ico, which `img-src data:` refuses — Firefox applies
// the page's CSP to that request and logs the refusal in every visitor's console.
const ICON = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function sha256(text: string): string {
  return "'sha256-" + createHash('sha256').update(text, 'utf8').digest('base64') + "'";
}

/** `</script` inside an inlined library must not end its <script> element. */
function scriptSafe(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script');
}

/**
 * A page's HTML. `page` must ALREADY be the output of sanitize.sanitizePage —
 * this function lays it out and pins it; it does not re-validate content.
 */
export function pageHtml(page: Record<string, any>, assets: SiteAssets, title: string): string { // any: a sanitizePage result
  // Style `auto` follows the reader's light or dark setting, as the app follows its own theme (autoSchemeCss).
  const resolved: DashboardStyle = sanitizeStyle(page.dashboard && page.dashboard.style);
  const css = styleBlock(resolved, page.brand, page.theme) + autoSchemeCss(resolved, page.brand, page.theme) + SITE_CSS + sizeCss();
  const scripts = [
    assets.chartJs,
    'var module = { exports: {} }; var exports = module.exports;',
    assets.formatJs,
    'var OrdFormat = module.exports; module = { exports: {} }; exports = module.exports;',
    assets.geoMatchJs,
    'var matchGeoItem = module.exports.matchGeoItem; var normalizeName = module.exports.normalizeName; var featureNameSet = module.exports.featureNameSet;',
    assets.coreJs,
    assets.phoneJs,
    assets.clientJs,
  ].map(scriptSafe);
  const csp = [
    "default-src 'none'",
    'img-src data:',
    `style-src ${sha256(css)}`,
    `script-src ${scripts.map(sha256).join(' ')}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  const safeTitle = String(title || 'Published').replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="en" class="${styleClasses(resolved)}${page.theme ? ' dash-themed' : ''}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="generator" content="Ordinate">
<title>${safeTitle}</title>
<link rel="icon" href="${ICON}">
<style>${css}</style>
</head>
<body>
<script type="application/json" id="ordinate-page">${embedJson(page)}</script>
${scripts.map((s) => `<script>${s}</script>`).join('\n')}
</body>
</html>`;
}

/** Every script SHA the page allows — for tests and the manifest. */
export function scriptHashes(html: string): string[] {
  const m = /script-src ([^;"]+)/.exec(html);
  return m ? m[1].trim().split(/\s+/) : [];
}
