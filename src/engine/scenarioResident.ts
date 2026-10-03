// SCENARIOS — a column's aggregated inputs per driver partition, read off the
// stored Parquet file IN PLACE. MAIN PROCESS. Never throws: `null` means "use
// the reference" (src/analysis/scenarioInputs.ts), which this reproduces
// exactly — scripts/test-scenarios.ts asserts it with Object.is.
//
// ONE grouped query per column: the scope is the WHERE (residentQuery's own
// filter compiler, so a scope means here what it means on a KPI card), each
// driver's filter is a boolean key column (the same compiler, COALESCE'd to
// FALSE — a NULL comparison keeps no row, as in JS; a filter the compiler skips
// is TRUE, as transforms skips it), and the rows group by those keys. Per group:
//
//   sum / numeric count / min / max  over sqlNum — the column's DECLARED type
//                                    gates it; a non-number column has no
//                                    numeric cells (never TRY_CAST inference)
//   non-empty count                  CASE WHEN, not FILTER (CLAUDE.md: FILTER
//                                    costs 16× at width)
//
// every aggregate CAST(… AS DOUBLE), and groups ordered by their first row's
// ordinal, so partitions arrive in the reference's first-seen order and fold
// in the same order.
//
// Float sums of non-integers can differ from the JS left fold in the last ULPs
// (parallel summation — the documented divergence of every resident sum).

import type { FilterStep } from '../data/transforms';
import type { ParsedColumn } from '../data/parse';
import type { Partition } from '../analysis/scenarioModel';
import { filterPredicate, filterPredicates, runOrderedAsync } from './residentQuery';
import type { ResidentSource } from './residentQuery';
import { phys, sqlNum } from './residentCategory';
import { sqlEmpty } from './sqlGen';
import type { DuckValue } from './duckdb';

function num(v: DuckValue): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isNaN(n) ? null : n;
}

export async function scenarioInputsResident(
  src: ResidentSource,
  column: string,
  scope: FilterStep[],
  filters: Array<FilterStep | null>,
): Promise<Partition[] | null> {
  try {
    const cols: ParsedColumn[] = src && Array.isArray(src.columns) ? src.columns : [];
    const ci = cols.findIndex((c) => !!c && c.name === column); // first match, as transforms.colIndex
    if (ci < 0 || filters.length === 0) return null;
    const p = phys(ci);
    // Params are positional: the key predicates come first in the statement text, then the WHERE.
    const params: DuckValue[] = [];
    const keys = filters.map((f, j) => {
      const pred = f ? filterPredicate(cols, f, params) : null;
      return `${pred ? `coalesce(${pred}, FALSE)` : 'TRUE'} AS k${j}`;
    });
    const where = filterPredicates(cols, scope, params);
    const n = cols[ci].type === 'number' ? sqlNum(p) : 'CAST(NULL AS DOUBLE)';
    const group = filters.map((_, j) => `k${j}`).join(', ');
    const rows = await runOrderedAsync(src.parquetPath, (from, ord) =>
      `SELECT ${group}, CAST(sum(__n) AS DOUBLE) AS s, CAST(count(__n) AS DOUBLE) AS c, ` +
      `CAST(count(__e) AS DOUBLE) AS e, CAST(min(__n) AS DOUBLE) AS lo, CAST(max(__n) AS DOUBLE) AS hi FROM ` +
      `(SELECT ${keys.join(', ')}, ${ord} AS __o, ${n} AS __n, CASE WHEN NOT ${sqlEmpty(p)} THEN 1 END AS __e ` +
      `FROM ${from}${where.length ? ' WHERE ' + where.join(' AND ') : ''}) ` +
      `GROUP BY ${group} ORDER BY min(__o);`, params);
    return rows.map((r) => {
      const c = num(r.c) ?? 0;
      return {
        key: filters.map((_, j) => r['k' + j] === 'true'), // BOOLEAN crosses the bridge as 'true' | 'false'
        pieces: { sum: c > 0 ? (num(r.s) ?? 0) : 0, n: c, nonEmpty: num(r.e) ?? 0, min: num(r.lo), max: num(r.hi) },
      };
    });
  } catch {
    return null;
  }
}
