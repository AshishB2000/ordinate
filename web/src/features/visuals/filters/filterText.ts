// Filter steps as words (the desktop's filterValues.ts): which operators read a
// list or nothing at all (mirrors src/filterOps.ts), every operator's label,
// and one step as the short phrase a filter row shows. Nothing here coerces a
// value: the list goes to the server as typed, and the server applies the same
// rules `=` uses, on the column's DECLARED type.

import type { FilterStep } from '../api';

export const isListOp = (op: string | null | undefined): boolean => op === 'in' || op === 'not in';
export const isValuelessOp = (op: string | null | undefined): boolean => op === 'is_empty' || op === 'not_empty';

export const OP_LABELS: Record<string, string> = {
  '=': 'equals',
  '!=': 'does not equal',
  '>': 'greater than',
  '<': 'less than',
  '>=': 'at least',
  '<=': 'at most',
  contains: 'contains',
  is_empty: 'is empty',
  not_empty: 'is not empty',
  in: 'is any of',
  'not in': 'is none of',
};

/**
 * One step as a short phrase. A long value list is summarised ("is any of a,
 * b, c +4"); an empty one says so; an unset row (no operator) is '' so the
 * row falls back to its "Set a condition…" prompt. A period step's name is the
 * server's (`periodLabel`), passed in.
 */
export function stepSummary(step: FilterStep | null | undefined, periodLabel?: string): string {
  if (!step || !step.op) return '';
  const op = String(step.op);
  if (op === 'period') return periodLabel ? `in ${periodLabel}` : 'in a period';
  const label = OP_LABELS[op] || op;
  if (isValuelessOp(op)) return label;
  if (isListOp(op)) {
    const vals = Array.isArray(step.values) ? step.values.map((v) => (v == null ? '' : String(v))) : [];
    if (vals.length === 0) return `${label} — no values yet`;
    if (vals.length > 3) return `${label} ${vals.slice(0, 3).join(', ')} +${vals.length - 3}`;
    return `${label} ${vals.join(', ')}`;
  }
  return `${label} ${step.value == null ? '' : String(step.value)}`.trim();
}

/**
 * The steps the server reads: rows with no column or no operator are inert and
 * dropped (`= ''` would match EMPTY cells, which is why a new row has no
 * operator until the dialog gives it one).
 */
export function liveFilters(rows: readonly FilterStep[]): FilterStep[] {
  return rows
    .filter((f) => f && f.column && f.op)
    .map((f) => {
      const s: FilterStep = { type: 'filter', column: f.column, op: f.op };
      if (isListOp(f.op)) s.values = Array.isArray(f.values) ? f.values.slice() : [];
      else if (f.op === 'period') s.period = f.period;
      else if (!isValuelessOp(f.op)) s.value = f.value != null ? f.value : '';
      if (f.context === true) s.context = true;
      return s;
    });
}
