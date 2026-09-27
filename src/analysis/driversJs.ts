// Key drivers' per-member aggregates, over HYDRATED rows — the JS REFERENCE.
// MAIN PROCESS, PURE: rows in, figures out.
//
// src/engine/driversResident.ts answers the same two questions off the stored
// Parquet in place, and scripts/test-driversResident.ts holds the two to each
// other with Object.is. This file is the definition; the SQL is the fast path.
//
// Rows are selected by the ORDINARY filter fold (transforms.applyPipeline), so
// "rows in period A" means exactly what it means to a KPI card: each filter
// list is folded over the table with a hidden row-index column riding along,
// and the surviving indices become a mask. A member is a cell's text with every
// empty cell (null, '', whitespace) in the one '' member, so the members of a
// dimension partition the rows and their changes add up to the total's.

import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep } from '../data/transforms';
import { applyPipeline, cellToString, isEmptyCell } from '../data/transforms';
import type { Operand } from './driverShape';
import type { DimensionAgg } from './drivers';

export interface DriverQuery {
  operands: Operand[];
  /** Period A (now) and B (before), each already including the drill path. */
  a: FilterStep[];
  b: FilterStep[];
}

export interface MemberTable {
  /** Ungrouped operand totals per period; a sum with no numeric cell is null. */
  totals: { a: Array<number | null>; b: Array<number | null> };
  /** Members sorted by key (code-unit order). Operand values: null → none. */
  dims: DimensionAgg[];
}

// A name no real column can collide with in practice: a NUL-prefixed marker.
const TAG = '\u0000drivers-row';

function colIndex(columns: ParsedColumn[], name: string): number {
  return columns.findIndex((c) => c && c.name === name);
}

/** Which rows a filter list keeps, as a 0/1 mask — by the ordinary fold. */
export function rowMask(columns: ParsedColumn[], rows: Cell[][], steps: FilterStep[]): Uint8Array {
  const m = new Uint8Array(rows.length);
  if (!steps.length) {
    m.fill(1);
    return m;
  }
  const n = columns.length;
  const tagged = rows.map((r, i) => {
    const row: Cell[] = new Array(n + 1);
    for (let c = 0; c < n; c += 1) row[c] = r ? r[c] ?? null : null;
    row[n] = i;
    return row;
  });
  const out = applyPipeline({ columns: columns.concat([{ name: TAG, type: 'number' }]), rows: tagged }, steps);
  const ti = out.columns.findIndex((c) => c.name === TAG);
  if (ti < 0) return m;
  for (const r of out.rows) {
    const i = r[ti];
    if (typeof i === 'number') m[i] = 1;
  }
  return m;
}

/** A member key: the cell's text, with every empty cell in ''. */
export function memberKey(cell: Cell | undefined): string {
  return cell === undefined || isEmptyCell(cell) ? '' : cellToString(cell);
}

/** Distinct members per candidate column over rows in A ∪ B. */
export function memberCountsJs(
  columns: ParsedColumn[],
  rows: Cell[][],
  q: { a: FilterStep[]; b: FilterStep[] },
  candidates: string[],
): Map<string, number> {
  const ma = rowMask(columns, rows, q.a);
  const mb = rowMask(columns, rows, q.b);
  const out = new Map<string, number>();
  for (const name of candidates) {
    const ci = colIndex(columns, name);
    if (ci < 0) continue;
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i += 1) {
      if (ma[i] || mb[i]) seen.add(memberKey(rows[i] ? rows[i][ci] : null));
    }
    out.set(name, seen.size);
  }
  return out;
}

interface Acc { sum: number; nums: number; count: number }

function finiteNum(cell: Cell | undefined): number | null {
  return typeof cell === 'number' && Number.isFinite(cell) ? cell : null;
}

function readAcc(op: Operand, acc: Acc): number | null {
  if (op.agg === 'count') return acc.count;
  if (op.agg === 'ncount') return acc.nums;
  return acc.nums > 0 ? acc.sum : null;
}

/**
 * Every operand, per member of every dimension and ungrouped, in both periods.
 * Left-fold sums in row order — the reference the SQL is compared against.
 */
export function memberAggsJs(columns: ParsedColumn[], rows: Cell[][], q: DriverQuery, dims: string[]): MemberTable {
  const ops = q.operands;
  const ma = rowMask(columns, rows, q.a);
  const mb = rowMask(columns, rows, q.b);
  // A mask per operand's own filters — shared by both periods.
  const mo = ops.map((op) => (op.filters.length ? rowMask(columns, rows, op.filters) : null));
  const oc = ops.map((op) => colIndex(columns, op.column));
  const dc = dims.map((d) => colIndex(columns, d));

  const fresh = (): Acc[] => ops.map(() => ({ sum: 0, nums: 0, count: 0 }));
  const totA = fresh();
  const totB = fresh();
  const perDim = dims.map(() => new Map<string, { a: Acc[]; b: Acc[] }>());

  const add = (acc: Acc[], row: Cell[] | undefined, i: number): void => {
    for (let k = 0; k < ops.length; k += 1) {
      if (mo[k] && !mo[k]![i]) continue;
      const cell = row && oc[k] >= 0 ? row[oc[k]] : null;
      if (!isEmptyCell(cell ?? null)) acc[k].count += 1;
      const n = finiteNum(cell);
      if (n !== null) {
        acc[k].sum += n;
        acc[k].nums += 1;
      }
    }
  };

  for (let i = 0; i < rows.length; i += 1) {
    if (!ma[i] && !mb[i]) continue;
    const row = rows[i];
    if (ma[i]) add(totA, row, i);
    if (mb[i]) add(totB, row, i);
    for (let d = 0; d < dims.length; d += 1) {
      if (dc[d] < 0) continue;
      const key = memberKey(row ? row[dc[d]] : null);
      let slot = perDim[d].get(key);
      if (!slot) {
        slot = { a: fresh(), b: fresh() };
        perDim[d].set(key, slot);
      }
      if (ma[i]) add(slot.a, row, i);
      if (mb[i]) add(slot.b, row, i);
    }
  }

  const read = (acc: Acc[]): Array<number | null> => ops.map((op, k) => readAcc(op, acc[k]));
  return {
    totals: { a: read(totA), b: read(totB) },
    dims: dims.map((column, d) => ({
      column,
      members: Array.from(perDim[d].entries())
        .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
        .map(([key, s]) => ({ key, a: read(s.a), b: read(s.b) })),
    })).filter((_, d) => dc[d] >= 0),
  };
}
