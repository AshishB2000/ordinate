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
