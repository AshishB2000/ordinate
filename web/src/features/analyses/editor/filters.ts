// A control's live selection → filter steps, and the sheet's parameters → the
// payload the server resolves `[[name]]` / `{{name}}` against. The same rules
// as src/analysis/dashboardFilters.ts `controlSteps` and dashParams.ts
// `dashParamPayload`: an unset selection filters nothing; a date range travels
// as a `custom` period the server compares as dates. Predicates only — every
// figure is still the server's.

import * as OrdFormat from '../../../../../src/app/format.ts';
import type { Card, ControlValue, Parameter, ParamPayload, Step } from '../api';

export function controlSteps(control: NonNullable<Card['control']>, state: ControlValue | undefined): Step[] {
  if (!state || control.kind === 'parameter') return [];
  const { column } = control;
  if (control.kind === 'dropdown' && 'value' in state) return state.value ? [{ type: 'filter', column, op: '=', value: state.value }] : [];
  if (control.kind === 'multi' && 'values' in state) return state.values.length ? [{ type: 'filter', column, op: 'in', values: state.values.slice() }] : [];
  if (control.kind === 'date_range') {
    if ('preset' in state && state.preset !== 'custom') return [{ type: 'filter', column, op: 'period', period: { ...state } }];
    const from = 'from' in state ? state.from : undefined;
    const to = 'to' in state ? state.to : undefined;
    if (!from && !to) return [];
    return [{ type: 'filter', column, op: 'period', period: { preset: 'custom', ...(from ? { from } : {}), ...(to ? { to } : {}) } }];
  }
  return [];
}

/** Whether a control has anything selected — "not All" (dashControlBar controlIsAll, negated). */
export function controlActive(card: Card, state: ControlValue | undefined): boolean {
  if (!state) return false;
  if ('values' in state) return state.values.length > 0;
  if ('value' in state) return !!state.value;
  if ('preset' in state) return true;
  return !!(state.from || state.to);
}

export function paramPayload(params: readonly Parameter[], live: (id: string) => unknown): ParamPayload {
  return params.map((p) => ({
    name: p.name,
    kind: p.kind,
    value: live(p.id),
    ...(p.min !== undefined ? { min: p.min } : {}),
    ...(p.max !== undefined ? { max: p.max } : {}),
  }));
}

/** `{{name}}` → the parameter's value as text (dashParams.ts dashSubst); an unknown name stays as typed. */
export function substitute(text: string, params: ParamPayload): string {
  if (!text || text.indexOf('{{') < 0) return text;
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,39})\s*\}\}/g, (all, name: string) => {
    const p = params.find((x) => String(x.name).toLowerCase() === name.toLowerCase());
    if (!p) return all;
    const v = (p as { value?: unknown }).value;
    if (v == null) return '—';
    if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
    return typeof v === 'number' ? OrdFormat.formatNumber(v, { maxDecimals: 6 }) : String(v);
  });
}

// ── Click-to-filter ─────────────────────────────────────────────────────────
// A mirror of src/analysis/dashboardFilters.ts (`clickFilterOn`,
// `toggleClickFilter`, `clickFilterSteps`) — the rules and their reasons are
// written there; filters.test.ts holds the two together on the same inputs.
// A reader's clicks are view state: one entry per (card, column), `origin`
// being the card that was clicked, which stays whole while the rest filter.

export interface ClickFilter {
  origin: string;
  column: string;
  values: string[];
}
export interface ClickMark {
  column: string;
  value: unknown;
  seriesColumn?: string;
  series?: unknown;
}

const clickText = (v: unknown): string => (v == null ? '' : String(v as string));

/** The sheet's switch turns it on for every visual that has not opted out; without it, only a visual that opted in. */
export function clickFilterOn(sheet: unknown, visual: unknown): boolean {
  return sheet === true ? visual !== false : visual === true;
}

/** A plain click selects that mark alone (the only selected one: clears); an additive one adds it or takes it away. */
export function toggleClickFilter(clicks: readonly ClickFilter[] | null | undefined, origin: string, mark: ClickMark, additive = false): ClickFilter[] {
  const list = (Array.isArray(clicks) ? (clicks as ClickFilter[]) : []).filter((c) => c && c.origin && c.column && Array.isArray(c.values) && c.values.length > 0);
  if (!origin || !mark || !mark.column) return list.slice();
  const picks: [string, string][] = [[mark.column, clickText(mark.value)]];
  if (mark.seriesColumn && mark.seriesColumn !== mark.column && mark.series !== undefined) picks.push([mark.seriesColumn, clickText(mark.series)]);
  const mine = (column: string): string[] => list.find((c) => c.origin === origin && c.column === column)?.values ?? [];
  const selected = picks.every(([column, v]) => mine(column).includes(v));
  const next = new Map<string, string[]>();
  if (!additive) {
    if (!(selected && picks.every(([column]) => mine(column).length === 1))) for (const [column, v] of picks) next.set(column, [v]);
  } else if (!selected) {
    for (const [column, v] of picks) next.set(column, mine(column).includes(v) ? mine(column) : mine(column).concat(v));
  } else {
    const at = picks.findIndex(([column]) => mine(column).length > 1);
    if (at >= 0) picks.forEach(([column, v], i) => next.set(column, i === at ? mine(column).filter((x) => x !== v) : mine(column)));
  }
  const touched = new Set(picks.map(([column]) => column));
  const out = list.filter((c) => !touched.has(c.column));
  for (const [column, values] of next) out.push({ origin, column, values });
  return out;
}

/** The click-filters as filter steps (`=` for one value, `in` for several), leaving out the card that is exempt. */
export function clickFilterSteps(clicks: readonly ClickFilter[] | null | undefined, exceptOrigin?: string): Step[] {
  const out: Step[] = [];
  for (const c of Array.isArray(clicks) ? (clicks as ClickFilter[]) : []) {
    if (!c || !c.column || !Array.isArray(c.values) || !c.values.length || c.origin === exceptOrigin) continue;
    out.push(c.values.length === 1 ? { type: 'filter', column: c.column, op: '=', value: c.values[0] } : { type: 'filter', column: c.column, op: 'in', values: c.values.slice() });
  }
  return out;
}
