'use strict';

// The project's CATEGORY COLOURS in the renderer: binds the shared pure rule
// (src/analysis/colorMap.js, loaded straight before this file through
// cjsShim.js, exactly as formatBind.js binds the app's formatter) as
// `OrdColorMap`, and keeps the active project's map in memory so a chart can be
// coloured SYNCHRONOUSLY while it is built.
//
// A chart deals its values against this cache (same rule main runs), draws, and
// — only when the deal changed something — asks main to deal the same values
// against the stored map (src/ipc/format.ts). Main answers with the stored
// column and the cache adopts it, so a stale cache heals on the next draw.
//
// Which column a chart's labels and series come from is not in its data, so
// the surfaces that know (the builder, dashboard and analysis cards, exports,
// thumbnails) hand it in as a transient `_colorScope` on the overrides they
// pass buildChart — fmtWithScope below. Nothing persists that key.
//
// Classic global-scope renderer <script>: no import/export.

const OrdColorMap: OrdColorMapApi = (window as any).module.exports;
(window as any).module = undefined;
(window as any).exports = undefined;

/** The project the cache holds, and its map: column → value → 'chart-N'. */
let fmtColorProject = '';
let fmtColorMap: Record<string, Record<string, string>> = OrdColorMap.sanitizeColorMap(null);
let fmtColorLoading = '';
/** Deals in flight per column — a reply is adopted only when it is the last one. */
const fmtColorPending = new Map<string, number>();

/** adoptProject's hook (workspace.ts): the record main just opened carries its map. */
function fmtAdoptColorMap(project: any): void {
  if (!project || !project.id) return;
  fmtColorProject = String(project.id);
  fmtColorMap = OrdColorMap.sanitizeColorMap(project.colorMap);
  fmtColorPending.clear();
}

/**
 * True when the cache is the ACTIVE project's. When it is not (a project
 * adopted by a path that bypassed adoptProject), it starts loading and says
 * no — the chart draws in position order this once, and never persists a deal
 * made against a map it has not seen.
 */
function fmtColorsReady(): boolean {
  const pid = typeof currentProjectId === 'string' ? currentProjectId : '';
  if (!pid) return false;
  if (fmtColorProject === pid) return true;
  if (fmtColorLoading !== pid && window.hubFormat) {
    fmtColorLoading = pid;
    window.hubFormat.getColorMap(pid).then((map: any) => {
      if (currentProjectId === pid) fmtAdoptColorMap({ id: pid, colorMap: map });
    }).catch(() => { /* next draw retries */ }).finally(() => { fmtColorLoading = ''; });
  }
  return false;
}

/** The slots `values` of `column` are drawn in — dealing new ones — or null when the map is not loaded. */
function fmtTokensFor(column: string, values: any[]): (string | null)[] | null {
  if (!column || !Array.isArray(values) || !fmtColorsReady()) return null;
  const a = OrdColorMap.assignColors(fmtColorMap[column], values);
  if (a.changed) {
    fmtColorMap[column] = a.colors;
    const pid = fmtColorProject;
    fmtColorPending.set(column, (fmtColorPending.get(column) || 0) + 1);
    window.hubFormat.assignColors(pid, column, values).then((res: any) => {
      const left = (fmtColorPending.get(column) || 1) - 1;
      if (left > 0) fmtColorPending.set(column, left);
      else fmtColorPending.delete(column);
      if (res && res.colors && fmtColorProject === pid && left === 0) fmtColorMap[column] = res.colors;
    }).catch(() => { fmtColorPending.delete(column); });
  }
  return a.tokens;
}

/** The stored slot of one value, without dealing (the Colours editors read this). */
function fmtTokenOf(column: string, value: any): string | null {
  const key = OrdColorMap.colorKey(value);
  const col = fmtColorMap[column];
  return key !== null && col && Object.prototype.hasOwnProperty.call(col, key) ? col[key] : null;
}

/** 'chart-3' → the third colour of `palette` (the chart's own, so a theme or a seed repaints it). */
function fmtHex(token: string, palette: string[]): string {
  const i = OrdColorMap.isColorToken(token) ? OrdColorMap.slotIndex(token) : -1;
  return i >= 0 ? palette[i % palette.length] : palette[0];
}

/** The eight theme colours as `el` resolves them (a dashboard preset remaps them on a container). */
function fmtThemePalette(el?: Element | null): string[] {
  return CHART_PALETTE.map((fallback, i) => {
    const tok = '--chart-' + (i + 1);
    return getCSSVar(tok, el) || getCSSVar(tok) || fallback;
  });
}

/**
 * `overrides` plus the columns its chart's labels and series come from, when the
 * caller knows them (`src` = a `source` / `entry.drill`: {projectId, encoding}).
 * A copy — the stored overrides never carry `_colorScope`.
 */
function fmtWithScope(overrides: any, src: any): any {
  const enc = src && src.encoding;
  if (!enc || !src.projectId || (!enc.category && !enc.series)) return overrides || {};
  return Object.assign({}, overrides || {}, {
    _colorScope: {
      projectId: String(src.projectId),
      category: typeof enc.category === 'string' ? enc.category : '',
      series: typeof enc.series === 'string' ? enc.series : '',
    },
  });
}

/** The scope, when it belongs to the active project (another project's map is not in memory). */
function fmtScopeOf(overrides: any): { category: string; series: string } | null {
  const s = overrides && overrides._colorScope;
  return s && s.projectId === currentProjectId ? s : null;
}

// ── Editing the map (Format → Colours, the column profile) ──────────────────

async function fmtColorEdit(column: string, call: (pid: string) => Promise<any>): Promise<boolean> {
  const pid = typeof currentProjectId === 'string' ? currentProjectId : '';
  if (!pid || !column || !window.hubFormat) return false;
  let res: any = null;
  try { res = await call(pid); } catch (_) { res = null; }
  if (!res || !res.colors || currentProjectId !== pid) return false;
  if (fmtColorProject !== pid) fmtAdoptColorMap({ id: pid, colorMap: {} });
  fmtColorMap[column] = res.colors;
  return true;
}

/** One value → one slot, or null to forget it. */
function fmtSetColor(column: string, value: any, token: string | null): Promise<boolean> {
  return fmtColorEdit(column, (pid) => window.hubFormat.setColor(pid, column, String(value), token));
}

/** Forget a column's colours; they are dealt again as the values are next drawn. */
function fmtResetColors(column: string): Promise<boolean> {
  return fmtColorEdit(column, (pid) => window.hubFormat.resetColors(pid, column));
}

/** Deal the palette out again over these values, in this order. */
function fmtApplyPalette(column: string, values: any[]): Promise<boolean> {
  return fmtColorEdit(column, (pid) => window.hubFormat.applyPalette(pid, column, values));
}
