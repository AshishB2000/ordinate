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
