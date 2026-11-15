// One dataset's VIEW CTE for SQL on Live datasets (docs/live-data/01-live-sql.md F-D6, F-D10,
// "Row rules and hidden columns, in the warehouse") — PURE.
//
//   v<i> AS (SELECT <reading of col 0> AS c0, … FROM <the record's source> AS lv_src
//            WHERE <the caller's lock> AND <the dataset's base filters>)
//
// The ONLY FROM item of a statement that names a warehouse object, written from the record with the
// live compiler's own parts, which the parity suites already prove: `fromItem` (the table, or the
// editor's defining query), `calcFrom` (a calc read, in its layers, base filters innermost),
// `predicates` (the lock, `binary` per dialect, values bound; the base filters), and per column
// `numberOf` (a finite DOUBLE), `dateOf` (a DATE, F-D7) or `keyText` (text, '' folded to NULL as
// every import stores it). It projects only the columns the statement reads; the lock may name a
// hidden column, since the WHERE applies before the projection. A lock step that cannot apply
// refuses (a missing column throws `RowPolicyError('column')`, as on every door), never skips.

import type { FilterStep } from '../../../data/transforms';
import type { CompileEnv } from '../compile';
import { fromItem } from '../compile';
import type { Ctx } from '../compileFilter';
import { dateOf, keyText, numberOf, predicates } from '../compileFilter';
import { calcFrom, namesCalc } from '../calcLayers';
import type { LiveFilter } from '../liveSpec';
import { adaptFilter, columnOf, isRefusal, refuse } from '../liveSpec';
import { hasNul } from '../sqlParams';
import type { ViewUse } from './ir';
import { Refused } from './scope';

/** What one dataset read needs: the target's compile env (source, every column with its calcs, base filters) and the caller's lock. */
export interface ViewInput {
  env: Pick<CompileEnv, 'source' | 'columns' | 'base' | 'keys'>;
  /** The caller's row lock (`Lock.steps`), [] when the rules do not hold the caller. */
  lock: readonly FilterStep[];
}

const orThrow = <T>(v: T): Exclude<T, { ok: false }> => {
  if (isRefusal(v)) throw new Refused(v);
  return v as Exclude<T, { ok: false }>;
};

/** The lock's steps as compiler filters, `binary` (row-policy D13); one that would be skipped refuses instead. */
export function lockFilters(lock: readonly FilterStep[], env: ViewInput['env']): LiveFilter[] {
  const out: LiveFilter[] = [];
  for (const s of lock) {
    const f = orThrow(adaptFilter(s, env.columns, {}, []));
    if (!f) throw new Refused(refuse('unknownColumn', s.column));
    out.push(f);
  }
  return out;
}

/** The body of view CTE `v<i>`, its values bound into `c.b`. */
export function viewBody(c: Ctx, use: ViewUse, input: ViewInput): string {
  const { env } = input;
  const lock = lockFilters(input.lock, env);
  const names = [...use.columns, ...lock.map((f) => f.column)];
  // ident() quotes a name; refusing '' and NUL is the caller's half of that contract (a NUL would meet the ParamSink markers).
  if (names.some((n) => n === '' || hasNul(n))) throw new Refused(refuse('badIdentifier'));
  const inner = orThrow(fromItem(c.d, env.source));
  const layered = namesCalc(names, env.source);
  const from = layered ? orThrow(calcFrom(c, env.source, names, inner, env.base)) : inner;
  const where = orThrow(predicates(c, [...(layered ? [] : env.base ?? []), ...lock]));
  const cols = use.columns.map((name, j) => {
    const col = columnOf(env.columns, name);
    if (!col) throw new Refused(refuse('unknownColumn', name));
    const read = col.type === 'number' ? numberOf(c, col) : col.type === 'date' ? dateOf(c, col) : keyText(c, col);
    return `${read} AS c${j}`;
  });
  return `SELECT ${cols.length ? cols.join(', ') : '1 AS c0'} FROM ${from}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
}
