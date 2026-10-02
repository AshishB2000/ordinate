// Saved views — named reader states on a dashboard. PURE: no electron, no fs,
// so scripts/test-savedViews.ts drives it under bare node.
//
// A VIEW is what a reader did to a dashboard, not what an author built: the
// control picks, parameter values, the sheet-wide selection and per-tile
// narrowing, the page, each tabs card's open tab, and the "as of" time. The
// renderer GATHERS that live state and APPLIES it; everything that decides what
// a stored view may contain lives here:
//
//   sanitizeViews        — on every load and every save (analysis.ts). Bounded
//                          count and name length, unknown keys dropped, and every
//                          reference re-checked against the record it sits on:
//                          a control value is clamped to ITS card's kind by the
//                          same whitelist a control default goes through, a
//                          parameter value to ITS parameter's kind and bounds.
//                          A view naming a card that was deleted loses that pick.
//   applyViewOp          — create / rename / update / delete / set default.
//   openingView          — which view a dashboard opens on.
//   viewScope            — the filters and parameters a view stands for (reports).
//   parseDeepLink        — `ordinate://dashboard/<id>?view=<viewId>`.
//
// Not captured, because it does not exist as dashboard state: a chart ZOOM range
// (no chart zooms on a dashboard yet) and the DRILL panel's rows (a transient
// read, closed by any click). Per-tile narrowing is what a drill-to-filter
// leaves behind, and that IS captured.

import { sanitizeDashboardFilters, sanitizeControlDefault } from './dashboards';
import type { Card, Page, ControlValue } from './dashboards';
import { sanitizeParamValue } from './params';
import type { Parameter, ParamValue } from './params';
import { controlSteps } from './dashboardFilters';
import type { FilterStep } from '../data/transforms';

export const MAX_VIEWS = 50;
export const MAX_VIEW_NAME = 80;
const MAX_STEPS = 50;
const MAX_TILES = 200;
/** Picks kept per view for cards not on the record (see sanitizeViewState). */
const MAX_ORPHANS = 50;
/** An orphan's kind is unknown; the first control kind whose shape it fits keeps it. */
const ORPHAN_KINDS = ['dropdown', 'multi', 'radius', 'date_range'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ViewState {
  /** The page (sheet) id the view shows; '' = the first. */
  page: string;
  /** Control card id → its selection; null = cleared to "All". */
  controls: Record<string, ControlValue | null>;
  /** Parameter id → its value. Absent = the parameter's saved default. */
  params: Record<string, ParamValue>;
  /** The sheet-wide selection (a map click, a navigation's carry). */
  selection: FilterStep[];
  /** Per-tile narrowing (a filter_target action): card id → steps. */
  tiles: Record<string, FilterStep[]>;
  /** Tabs card id → the tab it shows. */
  groupTabs: Record<string, string>;
  /** A kept snapshot time (ISO), or null for Latest. */
  asOf: string | null;
}

export interface SavedView {
  id: string;
  name: string;
  state: ViewState;
  createdAt: string;
  updatedAt: string;
}

/** What a view is checked against: the record it is stored on. */
export interface ViewScope {
  sheets: Page[];
  parameters: Parameter[];
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const isId = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

function allCards(sheets: Page[]): Card[] {
  const out: Card[] = [];
  for (const p of Array.isArray(sheets) ? sheets : []) for (const c of (p && p.cards) || []) if (c) out.push(c);
  return out;
}

/** A view name: one line, trimmed, bounded. '' when there is nothing left. */
export function cleanViewName(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_VIEW_NAME).trim() : '';
}

/** One view's state, whitelisted against the record it is stored on. */
export function sanitizeViewState(raw: unknown, scope: ViewScope): ViewState {
  const o = obj(raw);
  const cards = new Map(allCards(scope.sheets).map((c) => [c.id, c]));
  const pageIds = new Set((scope.sheets || []).map((p) => p.id));

  // A pick on a card that is NOT on the record now is KEPT (shape-checked,
  // bounded): every save re-checks views against the sheets, so a control
  // deleted then brought back by Undo or a version restore — same id — would
  // otherwise lose its pick in every view for good. Applying a view skips ids
  // with no card, so an orphan is inert until its card returns.
  // ponytail: orphans of cards deleted for good linger, capped at MAX_ORPHANS per view.
  let orphans = 0;
  const orphan = (id: string): boolean => isId(id) && !cards.has(id) && orphans++ < MAX_ORPHANS;

  const controls: Record<string, ControlValue | null> = {};
  for (const [id, v] of Object.entries(obj(o.controls))) {
    const card = cards.get(id);
    if (!card && orphan(id)) {
      const clean = v === null ? null : ORPHAN_KINDS.map((k) => sanitizeControlDefault(k, v)).find((x) => x !== undefined);
      if (clean !== undefined) controls[id] = clean;
      continue;
    }
    if (!card || card.type !== 'control' || !card.control || card.control.kind === 'parameter') continue;
    if (v === null) { controls[id] = null; continue; }
    const clean = sanitizeControlDefault(card.control.kind, v);
    if (clean) controls[id] = clean;
  }

  const params: Record<string, ParamValue> = {};
  for (const [id, v] of Object.entries(obj(o.params))) {
    const p = (scope.parameters || []).find((x) => x.id === id);
    if (p) params[id] = sanitizeParamValue(p.kind, v, { min: p.min, max: p.max });
  }

  const tiles: Record<string, FilterStep[]> = {};
  for (const [id, steps] of Object.entries(obj(o.tiles)).slice(0, MAX_TILES)) {
    if (!cards.has(id) && !orphan(id)) continue;
    const clean = sanitizeDashboardFilters(steps).slice(0, MAX_STEPS);
    if (clean.length) tiles[id] = clean;
  }

  const groupTabs: Record<string, string> = {};
  for (const [id, tab] of Object.entries(obj(o.groupTabs))) {
    const card = cards.get(id);
    if (!card && orphan(id)) { if (isId(tab)) groupTabs[id] = tab; continue; }
    // any: a tabs card's `tabs.items` is typed by cardModel.ts, not on Card
    const items: Array<{ id: string }> = card && card.type === 'tabs' ? ((card as any).tabs?.items || []) : [];
    if (items.some((t) => t.id === tab)) groupTabs[id] = tab as string;
  }

  const asOf = typeof o.asOf === 'string' && o.asOf.length <= 40 && Number.isFinite(Date.parse(o.asOf)) ? o.asOf : null;
  return {
    page: typeof o.page === 'string' && pageIds.has(o.page) ? o.page : '',
    controls,
    params,
    selection: sanitizeDashboardFilters(o.selection).slice(0, MAX_STEPS),
    tiles,
    groupTabs,
    asOf,
  };
}

const stamp = (v: unknown): string => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : '');

/** A stored view list → clean. Bad ids, blank names and duplicates are dropped. */
export function sanitizeViews(raw: unknown, scope: ViewScope): SavedView[] {
  const out: SavedView[] = [];
  const seen = new Set<string>();
  for (const v of Array.isArray(raw) ? raw : []) {
    const o = obj(v);
    const name = cleanViewName(o.name);
    if (!isId(o.id) || !name || seen.has(o.id.toLowerCase())) continue;
    seen.add(o.id.toLowerCase());
    const createdAt = stamp(o.createdAt);
    out.push({ id: o.id, name, state: sanitizeViewState(o.state, scope), createdAt, updatedAt: stamp(o.updatedAt) || createdAt });
    if (out.length >= MAX_VIEWS) break;
  }
  return out;
}

/** The default view's id, or '' when it names no view on the list. */
export function sanitizeDefaultViewId(raw: unknown, views: SavedView[]): string {
  return typeof raw === 'string' && views.some((v) => v.id === raw) ? raw : '';
}

/**
 * The view a dashboard opens on: the one asked for (a deep link, a ⌘K row),
 * else the default, else none. An id that names no view falls back to the
 * default rather than failing — a link to a deleted view still opens the board.
 */
export function openingView(views: SavedView[], defaultViewId: string, requested?: string | null): SavedView | null {
  const list = Array.isArray(views) ? views : [];
  return (requested ? list.find((v) => v.id === requested) : undefined)
    || list.find((v) => v.id === defaultViewId)
    || null;
}

export type ViewOp =
  | { op: 'create'; name: unknown; state: unknown }
  | { op: 'rename'; viewId: unknown; name: unknown }
  | { op: 'update'; viewId: unknown; state: unknown }
  | { op: 'delete'; viewId: unknown }
  | { op: 'default'; viewId: unknown };

export type ViewOpResult =
  | { ok: true; views: SavedView[]; defaultViewId: string; viewId: string }
  | { ok: false; error: string };

/** One edit to a dashboard's view list. Pure: `now` and `newId` are passed in. */
export function applyViewOp(
  rec: { views?: SavedView[]; defaultViewId?: string },
  op: ViewOp,
  scope: ViewScope,
  now: string,
  newId: () => string,
): ViewOpResult {
  const views = (rec.views || []).slice();
  let defaultViewId = sanitizeDefaultViewId(rec.defaultViewId, views);
  const o = obj(op);
  const kind = o.op;
  const taken = (name: string, except: string): boolean =>
    views.some((v) => v.id !== except && v.name.toLowerCase() === name.toLowerCase());

  if (kind === 'create') {
    const name = cleanViewName(o.name);
    if (!name) return { ok: false, error: 'Give the view a name.' };
    if (views.length >= MAX_VIEWS) return { ok: false, error: `A dashboard keeps at most ${MAX_VIEWS} views.` };
    if (taken(name, '')) return { ok: false, error: `There is already a view called “${name}”.` };
    const view: SavedView = { id: newId(), name, state: sanitizeViewState(o.state, scope), createdAt: now, updatedAt: now };
    views.push(view);
    return { ok: true, views, defaultViewId, viewId: view.id };
  }
  if (kind === 'default' && o.viewId === '') return { ok: true, views, defaultViewId: '', viewId: '' };

  const at = views.findIndex((v) => v.id === o.viewId);
  if (at < 0) return { ok: false, error: 'That view no longer exists.' };
  const id = views[at].id;
  if (kind === 'rename') {
    const name = cleanViewName(o.name);
    if (!name) return { ok: false, error: 'Give the view a name.' };
    if (taken(name, id)) return { ok: false, error: `There is already a view called “${name}”.` };
    views[at] = { ...views[at], name, updatedAt: now };
  } else if (kind === 'update') {
    views[at] = { ...views[at], state: sanitizeViewState(o.state, scope), updatedAt: now };
  } else if (kind === 'delete') {
    views.splice(at, 1);
    if (defaultViewId === id) defaultViewId = '';
  } else if (kind === 'default') {
    defaultViewId = id;
  } else {
    return { ok: false, error: 'Unknown view action.' };
  }
  return { ok: true, views, defaultViewId, viewId: id };
}

/** A control's value under a view: its pick, else the author's default. */
export function viewControlValue(view: SavedView | null, card: Card): ControlValue | null {
  const picks = view ? view.state.controls : {};
  if (Object.prototype.hasOwnProperty.call(picks, card.id)) return picks[card.id];
  return (card.control && card.control.default) || null;
}

/** A parameter's value under a view: its pick, else the saved default. */
export function viewParamValue(view: SavedView | null, p: Parameter): ParamValue {
  const picks = view ? view.state.params : {};
  return Object.prototype.hasOwnProperty.call(picks, p.id) ? picks[p.id] : p.value;
}

/**
 * What a view stands for as a query: the dashboard's own filters, then every
 * control's pick as steps, then the selection — the order effectiveFilters()
 * uses on screen — and the parameters at the view's values. Per-tile narrowing
 * is per tile, so it is not in a dashboard-wide scope.
 */
export function viewScope(
  view: SavedView | null,
  rec: { sheets: Page[]; filters?: FilterStep[]; parameters?: Parameter[] },
): { filters: FilterStep[]; params: Array<{ name: string; kind: string; value: ParamValue; min?: number; max?: number }> } {
  const filters: FilterStep[] = Array.isArray(rec.filters) ? rec.filters.slice() : [];
  for (const card of allCards(rec.sheets)) {
    if (card.type !== 'control' || !card.control || card.control.kind === 'parameter') continue;
    filters.push(...controlSteps(card.control, viewControlValue(view, card)));
  }
  if (view) filters.push(...view.state.selection);
  const params = (rec.parameters || []).map((p) => ({ name: p.name, kind: p.kind, value: viewParamValue(view, p), min: p.min, max: p.max }));
  return { filters, params };
}

/** The page a view opens on, as an index into `sheets` (0 when it is gone). */
export function viewPageIndex(view: SavedView | null, sheets: Page[]): number {
  const i = view && view.state.page ? (sheets || []).findIndex((p) => p.id === view.state.page) : -1;
  return i < 0 ? 0 : i;
}

// ── Deep links ───────────────────────────────────────────────────────────────

export interface DeepLink { dashboardId: string; viewId?: string }

/**
 * `ordinate://dashboard/<uuid>` or `ordinate://dashboard/<uuid>?view=<uuid>`.
 * Anything else is null: another scheme or host, a second path segment, a
 * port or credentials, a non-UUID id, or `view` given twice. Unknown query
 * parameters are ignored, so a link a later version adds to still opens here.
 */
export function parseDeepLink(raw: unknown): DeepLink | null {
  if (typeof raw !== 'string' || raw.length > 512) return null;
  // The raw shape first: URL parsing would quietly resolve `dashboard/../<id>`.
  if (!/^ordinate:\/\/[^/?#]+\/[^/?#]+\/?([?#].*)?$/i.test(raw)) return null;
  let u: URL;
  try { u = new URL(raw); } catch (_) { return null; }
  if (u.protocol !== 'ordinate:' || u.hostname.toLowerCase() !== 'dashboard') return null;
  if (u.username || u.password || u.port) return null;
  const m = /^\/([^/]+)\/?$/.exec(u.pathname);
  if (!m || !isId(m[1])) return null;
  const views = u.searchParams.getAll('view');
  if (views.length > 1 || (views.length === 1 && !isId(views[0]))) return null;
  return views.length ? { dashboardId: m[1].toLowerCase(), viewId: views[0].toLowerCase() } : { dashboardId: m[1].toLowerCase() };
}

/** The link a "Copy link" puts on the clipboard. */
export function viewLink(dashboardId: string, viewId?: string): string {
  return `ordinate://dashboard/${dashboardId}` + (viewId ? `?view=${viewId}` : '');
}
