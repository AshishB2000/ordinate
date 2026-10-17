// Saved views, the browser's half (docs/dashboard-filters/00-design.md) —
// PURE: what an open dashboard's state is as a view, and the state a view
// puts back. The server's src/analysis/savedViews.ts decides what a stored
// view may hold (it re-sanitizes every save against the record); these
// mirror its reading of one, and viewState.test.ts compares them with it.
//
// A view holds every control's value (null = All), the parameters moved off
// their saved values, the page, the sheet-wide selection, per-tile narrowing,
// each tabs card's open tab and As of. Not click-filters (a sheet's passing
// state) and not Compare.

import type { Card, ControlValue, Parameter, SavedView, Sheet, Step, ViewState } from '../../analyses/api';

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const cardsOf = (sheets: readonly Sheet[]): Card[] => sheets.flatMap((s) => s.cards);
const isPickable = (c: Card): boolean => c.type === 'control' && !!c.control && c.control.kind !== 'parameter';

/** The view a dashboard opens on: the one asked for, else the default, else none (savedViews.ts openingView). Ids are case-folded. */
export function openingView(views: readonly SavedView[], defaultViewId: string, requested?: string | null): SavedView | null {
  return (requested ? views.find((v) => same(v.id, requested)) : undefined) || (defaultViewId ? views.find((v) => same(v.id, defaultViewId)) : undefined) || null;
}

/** What the open editor holds that a view keeps. */
export interface LiveState {
  sheets: readonly Sheet[];
  sheet: number;
  controls: ReadonlyMap<string, ControlValue>;
  parameters: readonly Parameter[];
  params: ReadonlyMap<string, unknown>;
  selection: readonly Step[];
  narrowed: ReadonlyMap<string, Step[]>;
  groupTabs: ReadonlyMap<string, string>;
  asOf: string | null;
}

/** The open dashboard as a view. */
export function gatherView(l: LiveState): ViewState {
  const controls: Record<string, ControlValue | null> = {};
  for (const c of cardsOf(l.sheets)) if (isPickable(c)) controls[c.id] = l.controls.get(c.id) ?? null;
  const params: Record<string, unknown> = {};
  for (const p of l.parameters) {
    if (l.params.has(p.id) && JSON.stringify(l.params.get(p.id)) !== JSON.stringify(p.value)) params[p.id] = l.params.get(p.id);
  }
  return {
    page: l.sheets[l.sheet]?.id ?? '',
    controls,
    params,
    selection: [...l.selection],
    tiles: Object.fromEntries(l.narrowed),
    groupTabs: Object.fromEntries(l.groupTabs),
    asOf: l.asOf,
  };
}

/** The editor's state under a view. `sheet` -1: stay on the sheet that is open. */
export interface Seed {
  sheet: number;
  controls: Map<string, ControlValue>;
  params: Map<string, unknown>;
  selection: Step[];
  narrowed: Map<string, Step[]>;
  groupTabs: Map<string, string>;
  asOf: string | null;
}

/**
 * What `view` puts back on a dashboard of these sheets; null is the dashboard
 * as authored — every control at its default, every parameter at its saved
 * value, nothing selected — on the sheet already open. A pick on a card that
 * is not on the dashboard any more is skipped (savedViews.ts keeps it, inert).
 */
export function seedFromView(view: SavedView | null, sheets: readonly Sheet[], parameters: readonly Parameter[]): Seed {
  const cards = cardsOf(sheets);
  const ids = new Set(cards.map((c) => c.id));
  const st = view?.state;
  const picks = st?.controls ?? {};
  const controls = new Map<string, ControlValue>();
  for (const c of cards) {
    if (!isPickable(c)) continue;
    // The pick, else the author's default (savedViews.ts viewControlValue); null is "All".
    const v = has(picks, c.id) ? picks[c.id] : c.control?.default;
    if (v) controls.set(c.id, v);
  }
  const known = new Set(parameters.map((p) => p.id));
  const keep = <T,>(o: Record<string, T> | undefined): Array<[string, T]> => Object.entries(o ?? {}).filter(([id]) => ids.has(id));
  return {
    sheet: view ? Math.max(0, sheets.findIndex((p) => p.id === st?.page)) : -1,
    controls,
    params: new Map(Object.entries(st?.params ?? {}).filter(([id]) => known.has(id))),
    selection: [...(st?.selection ?? [])],
    narrowed: new Map(keep(st?.tiles)),
    groupTabs: new Map(keep(st?.groupTabs)),
    asOf: st?.asOf ?? null,
  };
}

/** A view's shareable link: the dashboard's own URL, opening on it. */
export function viewHref(origin: string, projectId: string, analysisId: string, viewId: string): string {
  return `${origin}/analyses/${projectId}/${analysisId}${viewId ? `?view=${viewId}` : ''}`;
}

/** A view name's longest (savedViews.ts MAX_VIEW_NAME). */
export const MAX_VIEW_NAME = 80;

/** The "As authored" choice in a list of views (a view id is a UUID, so it never clashes). */
export const AUTHORED = 'authored';

/** The choices a views picker lists: as authored, then each view, the default marked. */
export function viewOptions(list: readonly SavedView[], defaultId: string): Array<{ value: string; label: string }> {
  return [{ value: AUTHORED, label: 'As authored' }, ...list.map((v) => ({ value: v.id, label: v.id === defaultId ? `${v.name} (default)` : v.name }))];
}
