'use strict';

// The `in` / `not in` value list, as typed by a human — RENDERER ONLY.
//
// Three surfaces show a filter row (prepare.ts, encodingForm.ts, dashboards.ts)
// and all three need the same string <-> Cell[] pair, so it lives here rather
// than three times. Nothing here computes or coerces: the list is handed to main
// as strings and `transforms`/`sqlGen`/`residentQuery` apply the SAME coercion
// rules the `=` operator uses, on the column's DECLARED type. A renderer that
// guessed types here would be the second opinion this codebase deliberately
// does not have.
//
// ponytail: comma-separated text is the PHASE 1 input, and it has a real
// ceiling — a value containing a comma cannot be typed, and a leading/trailing
// space cannot be preserved. The fix is not a quoting mini-language; it is the
// type-aware dialog (phase 2), whose checkbox list picks real distinct values
// off the column and never round-trips them through a text field at all.

/** "CA, WA ,NY" → ['CA','WA','NY']. Blank entries drop; order and duplicates are the user's. */
function parseFilterValues(raw: string | null | undefined): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** The inverse, for re-opening a saved step. Non-strings stringify; null reads as blank. */
function formatFilterValues(values: unknown): string {
  if (!Array.isArray(values)) return '';
  return values.map((v) => (v == null ? '' : String(v))).join(', ');
}

/** True for the operators that read `values` instead of the scalar `value`. Mirrors src/filterOps.ts. */
function isListFilterOp(op: string | null | undefined): boolean {
  return op === 'in' || op === 'not in';
}

/** True for the operators that take no operand at all. Mirrors src/filterOps.ts. */
function isValuelessFilterOp(op: string | null | undefined): boolean {
  return op === 'is_empty' || op === 'not_empty';
}

/** Human labels for every operator, shared by all three filter surfaces. */
const FILTER_OP_LABELS: Record<string, string> = {
  '=': 'equals',
  '!=': t('common.does_not_equal'),
  '>': t('common.greater_than'),
  '<': t('common.less_than'),
  '>=': t('common.at_least'),
  '<=': t('common.at_most'),
  contains: 'contains',
  is_empty: t('common.is_empty'),
  not_empty: t('common.is_not_empty'),
  in: t('common.is_any_of'),
  'not in': t('common.is_none_of'),
};

/**
 * One filter step as a short phrase — what the chip/pill/summary shows.
 *
 * Long value lists are summarised rather than printed: a chip carrying 40 values
 * is unreadable and pushes every other control off its row. An EMPTY list says
 * so, because the pipeline skips that step with a warning and a chip that looked
 * active while doing nothing would be the confusing case.
 */
function filterStepSummary(step: any): string {
  if (!step || typeof step !== 'object') return '';
  // No operator = an unset row. Deliberately blank rather than defaulting to
  // "equals", so the control falls back to its own "set a condition…" prompt.
  if (!step.op) return '';
  const op = String(step.op);
  const label = FILTER_OP_LABELS[op] || op;
  if (isValuelessFilterOp(op)) return label;
  if (isListFilterOp(op)) {
    const vals: unknown[] = Array.isArray(step.values) ? step.values : [];
    if (vals.length === 0) return t('filterValues.no_values_yet', { label });
    if (vals.length > 3) return `${label} ${formatFilterValues(vals.slice(0, 3))} +${vals.length - 3}`;
    return `${label} ${formatFilterValues(vals)}`;
  }
  return `${label} ${step.value == null ? '' : String(step.value)}`.trim();
}
