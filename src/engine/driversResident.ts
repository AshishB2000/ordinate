'use strict';

// Key drivers' per-member aggregates, computed IN PLACE off the stored Parquet
// — the resident twin of `analysis/driversJs`. MAIN PROCESS ONLY.
//
// Two statements, each ONE scan of the file, however many dimensions:
//
//   1. members per candidate column over rows in A ∪ B (count DISTINCT), so a
//      high-cardinality id column is dropped before anything groups on it;
//   2. every operand, in both periods, per member of every surviving column AND
//      ungrouped, as GROUPING SETS ((k0), (k1), …, ()).
//
// The two periods and each operand's own filters are evaluated once per row in
// a subquery as booleans (`__pa`, `__pb`, `__o<k>`), and the aggregates pick
// rows with CASE WHEN — not FILTER (WHERE …), which cost 16× at width here once.
//
// The layer's standing rules, unchanged:
//   • Cast on the DECLARED type, never inference: only a `number` operand is
//     read through `sqlNum`, and driverShape refuses a sum over anything else.
//   • Every aggregate is CAST(… AS DOUBLE) (sum(INTEGER) is HUGEINT).
//   • Empty is null OR '' OR whitespace (`sqlEmpty`), and every empty cell is
//     the one '' member, exactly as `driversJs.memberKey`.
//   • Order is never assumed: members are sorted by key in JS afterwards, the
//     same comparison the reference uses, so no ORDER BY is needed at all.
//   • A member key that starts with U+FEFF is projected through `bomSafe`,
//     because the bridge drops one leading BOM from every string it returns.
//
// Returns null on ANY failure; the caller falls back to the JS reference and
// records the outcome in residentTrace.

import type { ParsedColumn } from '../data/parse';
import type { FilterStep } from '../data/transforms';
import type { Operand } from '../analysis/driverShape';
import type { DriverQuery, MemberTable } from '../analysis/driversJs';
import { sqlEmpty } from './sqlGen';
import { filterPredicates, plainFrom } from './residentQuery';
import type { ResidentSource } from './residentQuery';
import { bomSafe, phys, sqlNum } from './residentCategory';
import * as duck from './duckdb';

function colIndex(cols: ParsedColumn[], name: string): number {
  return cols.findIndex((c) => c && c.name === name);
}

/** A filter list as ONE never-NULL boolean, params pushed in text order. */
function conj(cols: ParsedColumn[], steps: FilterStep[], params: duck.DuckValue[]): string {
  const preds = filterPredicates(cols, steps, params);
  return preds.length ? `coalesce((${preds.join(' AND ')}), FALSE)` : 'TRUE';
}

function keyExpr(p: string): string {
  return `CASE WHEN ${sqlEmpty(p)} THEN '' ELSE ${bomSafe(p)} END`;
}

function aggExpr(op: Operand, ci: number, period: string, k: number): string {
  const p = phys(ci);
  const when = op.filters.length ? `${period} AND __o${k}` : period;
  if (op.agg === 'count') return `CAST(count(CASE WHEN ${when} AND NOT ${sqlEmpty(p)} THEN 1 END) AS DOUBLE)`;
  if (op.agg === 'ncount') return `CAST(count(CASE WHEN ${when} THEN ${sqlNum(p)} END) AS DOUBLE)`;
  return `CAST(sum(CASE WHEN ${when} THEN ${sqlNum(p)} END) AS DOUBLE)`;
}

function num(raw: duck.DuckValue | undefined): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isNaN(n) ? null : n;
}

/** Distinct members per candidate column over rows in A ∪ B, or null. */
export async function memberCountsResident(
  src: ResidentSource,
  q: { a: FilterStep[]; b: FilterStep[] },
  candidates: string[],
): Promise<Map<string, number> | null> {
  try {
    const cols = src && Array.isArray(src.columns) ? src.columns : [];
    const names = candidates.filter((n) => colIndex(cols, n) >= 0);
    const out = new Map<string, number>();
    if (!names.length) return out;
    const params: duck.DuckValue[] = [];
    const counts = names.map((n, j) => {
      const p = phys(colIndex(cols, n));
      return `CAST(count(DISTINCT CASE WHEN ${sqlEmpty(p)} THEN '' ELSE CAST(${p} AS VARCHAR) END) AS DOUBLE) AS n${j}`;
    });
    const where = `${conj(cols, q.a, params)} OR ${conj(cols, q.b, params)}`;
    const rows = await duck.queryAsync(`SELECT ${counts.join(', ')} FROM ${plainFrom(src.parquetPath)} WHERE ${where};`, params);
    const row = rows[0];
    if (!row) return null;
    names.forEach((n, j) => out.set(n, num(row[`n${j}`]) ?? 0));
    return out;
  } catch (_) {
    return null;
  }
}

/** `driversJs.memberAggsJs`, off the Parquet file. Null on any failure. */
export async function memberAggsResident(src: ResidentSource, q: DriverQuery, dims: string[]): Promise<MemberTable | null> {
  try {
    const cols = src && Array.isArray(src.columns) ? src.columns : [];
    if (!cols.length) return null;
    const ops = q.operands;
    const oc = ops.map((op) => colIndex(cols, op.column));
    if (oc.some((c) => c < 0)) return null;
    const names = dims.filter((d) => colIndex(cols, d) >= 0);

    // The subquery: keys, the period and operand booleans, and the raw operand
    // columns. Params are positional and ALL live here, in text order.
    const params: duck.DuckValue[] = [];
    const inner: string[] = names.map((d, j) => `${keyExpr(phys(colIndex(cols, d)))} AS k${j}`);
    inner.push(`${conj(cols, q.a, params)} AS __pa`);
    inner.push(`${conj(cols, q.b, params)} AS __pb`);
    ops.forEach((op, k) => {
      if (op.filters.length) inner.push(`${conj(cols, op.filters, params)} AS __o${k}`);
    });
    for (const ci of new Set(oc)) inner.push(phys(ci));

    const aggs: string[] = [];
    ops.forEach((op, k) => {
      aggs.push(`${aggExpr(op, oc[k], '__pa', k)} AS a${k}`);
      aggs.push(`${aggExpr(op, oc[k], '__pb', k)} AS b${k}`);
    });
    const keys = names.map((_, j) => `k${j}`);
    const flags = names.map((_, j) => `GROUPING(k${j}) AS g${j}`);
    const head = flags.concat(keys, aggs).join(', ');
    const from = `(SELECT ${inner.join(', ')} FROM ${plainFrom(src.parquetPath)}) AS t WHERE __pa OR __pb`;
    const group = names.length ? ` GROUP BY GROUPING SETS (${keys.map((k) => `(${k})`).concat(['()']).join(', ')})` : '';
    const rows = await duck.queryAsync(`SELECT ${head} FROM ${from}${group};`, params);

    const read = (row: duck.DuckRow, p: 'a' | 'b'): Array<number | null> => ops.map((_, k) => num(row[`${p}${k}`]));
    const zeroA = ops.map((op) => (op.agg === 'sum' ? null : 0));
    let totals: MemberTable['totals'] = { a: zeroA.slice(), b: zeroA.slice() };
    const perDim = names.map(() => [] as Array<{ key: string; a: Array<number | null>; b: Array<number | null> }>);
    for (const row of rows) {
      const set = names.findIndex((_, j) => Number(row[`g${j}`]) === 0);
      if (set < 0) {
        totals = { a: read(row, 'a'), b: read(row, 'b') };
        continue;
      }
      const raw = row[`k${set}`];
      perDim[set].push({ key: raw == null ? '' : String(raw), a: read(row, 'a'), b: read(row, 'b') });
    }
    return {
      totals,
      dims: names.map((column, j) => ({
        column,
        members: perDim[j].sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)),
      })),
    };
  } catch (_) {
    return null;
  }
}
