// residentFilter — filter steps compiled to SQL predicates over a dataset's
// physical `c0..cN`. Split out of residentQuery.ts at the 800-line cap; every
// rule in that file's header (cast on the DECLARED type, empty = null/''/
// whitespace, bound parameters only) applies here unchanged.
//
// `transforms` applies filter steps in sequence, but each one is a pure row
// predicate over an unchanged column set, so a sequence is exactly a
// conjunction. An unknown column or operator is SKIPPED (transforms skips it
// with a warning), which is what makes one dashboard-wide filter able to span
// heterogeneous datasets.

import type { ColumnType, ParsedColumn } from '../data/parse';
import { coerceValue } from '../data/parse';
import type { Cell, FilterStep } from '../data/transforms';
import type { FilterOp } from '../data/filterOps';
import { FILTER_OPS, COMPARE_OPS, LIST_OPS } from '../data/filterOps';
import { sqlEmpty } from './sqlGen';
import { phys, sqlNum } from './residentCategory';
import type * as duck from './duckdb';
import { sqlPeriodPredicate } from './periodSql';
import { sqlRadiusPredicate } from './geoSql';
import { resolvePeriodNow } from '../analysis/dateIntel';

const SQL_OP: Record<string, string> = { '=': '=', '!=': '<>', '>': '>', '<': '<', '>=': '>=', '<=': '<=' };

/**
 * The filter list as SQL conjuncts, EXPORTED so a caller that already has a
 * WHERE of its own can AND these into it instead of building a second predicate
 * compiler.
 *
 * `datasetPage.readPage` is that caller: the rows behind a number and the number
 * itself must be selected by the SAME predicate, or the drill-down panel would
 * quietly contradict the figure above it. One compiler, two callers.
 *
 * Order matters: `params` is positional, so a caller must splice these
 * predicates into its statement in the same order it called this.
 */
export function filterPredicates(
  cols: ParsedColumn[],
  filters: FilterStep[] | undefined,
  params: duck.DuckValue[],
): string[] {
  if (!Array.isArray(filters) || filters.length === 0) return [];
  const preds: string[] = [];
  for (const f of filters) {
    const p = filterPredicate(cols, f, params);
    if (p) preds.push(p);
  }
  return preds;
}

/**
 * ONE filter step as a SQL predicate, or `null` when the step applies NOTHING
 * (unknown column, unknown operator, empty `in` list) — exactly the cases
 * `transforms.stepFilter` skips with a warning.
 *
 * Exported for the same reason as `filterPredicates`.
 */
export function filterPredicate(cols: ParsedColumn[], s: FilterStep, params: duck.DuckValue[]): string | null {
  if (!s || typeof s !== 'object' || s.type !== 'filter') return null;
  const ci = colIndex(cols, s.column);
  if (ci < 0) return null; // "Filter skipped: unknown column"
  if (!FILTER_OPS.has(s.op)) return null; // "Filter skipped: unknown operator"

  const p = phys(ci);
  const op: FilterOp = s.op;

  if (op === 'within_km') return sqlRadiusPredicate(cols, ci, s, params); // r6:geo — ./geoSql
  if (op === 'is_empty') return sqlEmpty(p);
  if (op === 'not_empty') return `NOT ${sqlEmpty(p)}`;
  if (op === 'period') {
    // Resolved HERE, at query time — the stored step carries only its preset.
    // No range → null, i.e. no predicate: transforms skips the step the same way.
    const r = s.period ? resolvePeriodNow(s.period) : null;
    return r ? sqlPeriodPredicate(p, r, params) : null;
  }
  if (op === 'contains') {
    // Always string-based regardless of column type. A null cell becomes '' and
    // an omitted needle is '' — which matches EVERY row, exactly as JS does.
    params.push(cellToString(s.value));
    return `contains(${sqlStr(p)}, CAST(? AS VARCHAR))`;
  }
  if (LIST_OPS.has(op)) {
    const values = Array.isArray(s.values) ? s.values : [];
    // Empty list → null, i.e. NO predicate. transforms skips the step with a
    // warning and applies nothing, so "apply nothing" is the row-identical
    // answer. (A caller that must not lose the warning — `ipc/visuals.ts`'s
    // warning-freedom gate — rejects this case before it ever gets here.)
    if (values.length === 0) return null;
    return sqlInPredicate(cols[ci].type, p, values, op === 'not in', params);
  }
  if (!COMPARE_OPS.has(op)) return 'FALSE';

  if (cols[ci].type === 'number') {
    // The target goes through the SAME strict gate as transforms (coerceValue →
    // isFiniteNumber), so '007' / '1,200' / 'abc' all become null and the filter
    // keeps ZERO rows for every operator, `!=` included.
    const t = coerceValue(s.value ?? null, 'number');
    const tn = typeof t === 'number' && Number.isFinite(t) ? t : null;
    if (tn === null) return 'FALSE';
    params.push(tn);
    // NULL <op> x is NULL → the row drops for every operator, matching the
    // `cn === null → false` branch.
    return `${sqlNum(p)} ${SQL_OP[op]} CAST(? AS DOUBLE)`;
  }
  params.push(cellToString(s.value));
  return `${sqlStr(p)} ${SQL_OP[op]} CAST(? AS VARCHAR)`;
}

/**
 * `in` / `not in` as one never-NULL boolean. The twin of `sqlGen.sqlInPredicate`
 * — same three rules, same order, and pinned to it by the differential tests in
 * scripts/test-residentQuery.ts:
 *
 *  1. Every value is a bound `?`; a value list is untrusted input and is the
 *     only operand here whose COUNT the renderer controls.
 *  2. Cast on the DECLARED type — `sqlNum` only for a `number` column, so
 *     `'007' in ('7')` stays false.
 *  3. `coalesce(… , FALSE)` before negating, because `NULL IN (…)` is NULL and a
 *     bare `NOT` would drop null rows. `not in` is the EXACT complement of `in`
 *     in the JS fold, so a null cell — which is in no list — has to survive.
 */
function sqlInPredicate(
  type: ColumnType,
  p: string,
  values: Cell[],
  negate: boolean,
  params: duck.DuckValue[],
): string {
  let inner: string;
  if (type === 'number') {
    // The same strict gate as transforms: an entry that is not a finite number
    // can never equal a finite cell, so it is dropped. All dropped → matches
    // nothing, exactly as `= 'abc'` on a number column keeps zero rows.
    const targets = new Set<number>();
    for (const v of values) {
      const n = coerceValue(v ?? null, 'number');
      if (typeof n === 'number' && Number.isFinite(n)) targets.add(n);
    }
    if (targets.size === 0) {
      inner = 'FALSE';
    } else {
      const holes: string[] = [];
      for (const n of targets) {
        holes.push('CAST(? AS DOUBLE)');
        params.push(n);
      }
      inner = `coalesce(${sqlNum(p)} IN (${holes.join(', ')}), FALSE)`;
    }
  } else {
    // De-duplicated to mirror the JS `Set` and to bound the parameter count.
    const targets = new Set<string>(values.map((v) => cellToString(v)));
    const holes: string[] = [];
    for (const t of targets) {
      holes.push('CAST(? AS VARCHAR)');
      params.push(t);
    }
    inner = `coalesce(${sqlStr(p)} IN (${holes.join(', ')}), FALSE)`;
  }
  return negate ? `NOT ${inner}` : inner;
}

/** `transforms.cellToString` for a stored cell: NULL becomes ''. */
function sqlStr(p: string): string {
  return `coalesce(CAST(${p} AS VARCHAR), '')`;
}

/** Exact, case-sensitive, FIRST match — `transforms.colIndex`. */
export function colIndex(cols: ParsedColumn[], name: string): number {
  for (let i = 0; i < cols.length; i += 1) {
    if (cols[i] && cols[i].name === name) return i;
  }
  return -1;
}

function cellToString(cell: Cell | undefined): string {
  return cell == null ? '' : String(cell);
}
