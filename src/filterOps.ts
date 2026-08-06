// The filter-operator VOCABULARY — one definition, no dependencies.
//
// Why this file exists: the operator list used to be spelled out four times —
// transforms.ts (the JS predicate), sqlGen.ts (the pipeline compiler),
// residentQuery.ts (the resident predicate) and ipc/visuals.ts (the
// warning-freedom gate). Adding an operator to three of the four is not a
// visible bug: the resident path just returns null for the op it doesn't know,
// the caller quietly hydrates in JS, and the answer stays CORRECT while getting
// ~600x slower. That ships green. `src/residentTrace.ts` exists to make it loud
// at runtime; this file exists so it cannot happen in the first place.
//
// It can only be shared as a LEAF. `transforms.ts` imports `pipelineDuck.ts`
// which imports `sqlGen.ts`, so sqlGen value-importing transforms would close a
// cycle — which is why the copies were duplicated rather than shared before.
// Nothing is imported here, so every one of the four can depend on it.
//
// What is NOT shared: the three IMPLEMENTATIONS. A JS row predicate, a CTE
// fragment and a resident WHERE clause are genuinely different code, and each is
// pinned to the others by a differential test rather than by an abstraction.

export type FilterOp =
  | '='
  | '!='
  | '>'
  | '<'
  | '>='
  | '<='
  | 'contains'
  | 'is_empty'
  | 'not_empty'
  | 'in'
  | 'not in';

/** Every operator a `FilterStep` may carry. An op outside this set is SKIPPED with a warning. */
export const FILTER_OPS: ReadonlySet<string> = new Set<FilterOp>([
  '=', '!=', '>', '<', '>=', '<=', 'contains', 'is_empty', 'not_empty', 'in', 'not in',
]);

/** Ordering/equality operators, which read the scalar `value` and branch on the DECLARED column type. */
export const COMPARE_OPS: ReadonlySet<string> = new Set<FilterOp>(['=', '!=', '>', '<', '>=', '<=']);

/** The operators that read `values: Cell[]` instead of the scalar `value`. */
export const LIST_OPS: ReadonlySet<string> = new Set<FilterOp>(['in', 'not in']);

/** Operators that need no operand at all. */
export const VALUELESS_OPS: ReadonlySet<string> = new Set<FilterOp>(['is_empty', 'not_empty']);

/**
 * The ONE warning text for an `in`/`not in` step with no values, shared so the
 * JS fold and the SQL compiler emit it byte-identically (the differential tests
 * compare warning arrays, not just rows).
 *
 * An empty list SKIPS the step rather than matching zero rows. A filter chip
 * that silently empties the chart the moment it is created reads as a bug, and
 * the user has no way to tell "no values selected yet" from "no rows match".
 */
export function emptyListWarning(column: string, op: string): string {
  return `Filter skipped: "${op}" on "${column}" has no values`;
}
