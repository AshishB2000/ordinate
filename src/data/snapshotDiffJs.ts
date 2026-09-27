// A snapshot diff — the plan both implementations share, and the pure-JS
// REFERENCE. MAIN PROCESS (pure: no fs, no DuckDB).
//
// src/engine/snapshotDiff.ts computes the same answer in DuckDB straight off the
// two Parquet files; scripts/test-snapshotDiff.ts asserts the two agree with
// Object.is on every field. This file is the definition, so every rule is here:
//
// VALUES are compared as STORED (Parquet holds `String(cell)`, all VARCHAR), with
// no type inference: '007' and '7' are different values, and so are '1.0' and
// '1'. EMPTY is null, '' or whitespace only — the whitespace class spelled out
// exactly as sqlGen.WS_CLASS (space \t \n \v \f \r NBSP BOM), because JS trim()
// and DuckDB trim() disagree — and every empty compares equal to every other
// and is reported as null. A non-empty value is never trimmed: ' a' ≠ 'a'.
//
// COLUMNS are matched BY NAME (first occurrence), so a reordered table diffs as
// unchanged. Only columns in both are compared; the rest are reported as
// addedColumns / removedColumns. Rows are shown over the compared columns, in
// the NEW table's order.
//
// KEYED (a key column chosen): a key is matched to a key. DUPLICATE KEYS: only
// the FIRST row of each key (lowest file row number) takes part, on each side;
// the rest are counted in `duplicates` and otherwise ignored. An empty key is a
// key like any other (all empties are one key). added = keys only in new,
// removed = keys only in old, changed = keys in both whose compared cells differ,
// with the cells that differ.
//
// FULL ROW (no key): a MULTISET. A row that appears twice in old and once in new
// is one removed row. The k-th occurrence of a row (in file order) on one side
// matches the k-th on the other, so which copy is "the removed one" is
// deterministic: the later one. `changed` is always 0 — without a key there is
// no "same row, new values".
//
// PAGES are bounded (`limit`), ordered by file row number: added and changed by
// the new file's, removed by the old file's. `ord` is that 0-based row number.

import type { Cell } from './transforms';

export const DIFF_LIMIT = 50;
export const MAX_DIFF_LIMIT = 500;

export type DiffCell = string | null;

export interface DiffPlan {
  mode: 'key' | 'row';
  key: string | null;
  /** Compared column names, in the new table's order. */
  columns: string[];
  /** Physical position of each compared column in the old / new file. */
  oldIdx: number[];
  newIdx: number[];
  /** Index of the key in `columns`, -1 in full-row mode. */
  keyAt: number;
  addedColumns: string[];
  removedColumns: string[];
  limit: number;
}

export interface DiffRow {
  ord: number;
  values: DiffCell[];
}

export interface ChangedCell {
  column: string;
  old: DiffCell;
  new: DiffCell;
}

export interface ChangedRow {
  ordOld: number;
  ordNew: number;
  key: DiffCell;
  cells: ChangedCell[];
}

export interface DiffResult {
  mode: 'key' | 'row';
  key: string | null;
  columns: string[];
  addedColumns: string[];
  removedColumns: string[];
  counts: { added: number; removed: number; changed: number; unchanged: number };
  /** Rows beyond the first of their key, per side. Always 0 in full-row mode. */
  duplicates: { old: number; new: number };
  added: DiffRow[];
  removed: DiffRow[];
  changed: ChangedRow[];
  limit: number;
}

export function sanitizeLimit(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DIFF_LIMIT;
  return Math.min(MAX_DIFF_LIMIT, Math.max(1, Math.floor(v)));
}

function firstIndex(cols: Array<{ name: string }>): Map<string, number> {
  const m = new Map<string, number>();
  cols.forEach((c, i) => { if (c && typeof c.name === 'string' && !m.has(c.name)) m.set(c.name, i); });
  return m;
}

/** The comparison both implementations run, or an error the user can read. */
export function planDiff(
  oldCols: Array<{ name: string }>,
  newCols: Array<{ name: string }>,
  key: unknown,
  limit?: unknown,
): DiffPlan | { error: string } {
  const o = firstIndex(oldCols);
  const n = firstIndex(newCols);
  const columns: string[] = [];
  const oldIdx: number[] = [];
  const newIdx: number[] = [];
  for (const [name, i] of n) {
    const j = o.get(name);
    if (j === undefined) continue;
    columns.push(name);
    oldIdx.push(j);
    newIdx.push(i);
  }
  const addedColumns = [...n.keys()].filter((c) => !o.has(c));
  const removedColumns = [...o.keys()].filter((c) => !n.has(c));
  const k = typeof key === 'string' && key !== '' ? key : null;
  const keyAt = k === null ? -1 : columns.indexOf(k);
  if (k !== null && keyAt < 0) return { error: `"${k}" is not a column in both versions, so it cannot key the comparison.` };
  return { mode: k === null ? 'row' : 'key', key: k, columns, oldIdx, newIdx, keyAt, addedColumns, removedColumns, limit: sanitizeLimit(limit) };
}

const EMPTY_RE = /^[ \t\n\v\f\r ﻿]*$/;

/** A stored cell as the diff sees it: null for any empty, else the stored text. */
export function normCell(c: Cell | undefined): DiffCell {
  if (c === null || c === undefined) return null;
  const s = String(c);
  return EMPTY_RE.test(s) ? null : s;
}

/** The cells that differ between two matched rows (the key never does). */
export function changedCells(plan: DiffPlan, oldVals: DiffCell[], newVals: DiffCell[]): ChangedCell[] {
  const out: ChangedCell[] = [];
  for (let j = 0; j < plan.columns.length; j++) {
    if (j === plan.keyAt || oldVals[j] === newVals[j]) continue;
    out.push({ column: plan.columns[j], old: oldVals[j], new: newVals[j] });
  }
  return out;
}

export function emptyResult(plan: DiffPlan): DiffResult {
  return {
    mode: plan.mode, key: plan.key, columns: plan.columns,
    addedColumns: plan.addedColumns, removedColumns: plan.removedColumns,
    counts: { added: 0, removed: 0, changed: 0, unchanged: 0 },
    duplicates: { old: 0, new: 0 },
    added: [], removed: [], changed: [], limit: plan.limit,
  };
}

interface Row { ord: number; v: DiffCell[] }

function project(rows: Cell[][], idx: number[]): Row[] {
  return rows.map((r, ord) => ({ ord, v: idx.map((i) => normCell(Array.isArray(r) ? r[i] : null)) }));
}

/** The reference diff over two in-memory tables of stored cells. */
export function diffTablesJs(
  oldT: { columns: Array<{ name: string }>; rows: Cell[][] },
  newT: { columns: Array<{ name: string }>; rows: Cell[][] },
  key: unknown,
  limit?: unknown,
): DiffResult | { error: string } {
  const plan = planDiff(oldT.columns, newT.columns, key, limit);
  if ('error' in plan) return plan;
  const out = emptyResult(plan);
  const o = project(oldT.rows, plan.oldIdx);
  const n = project(newT.rows, plan.newIdx);
  const added: Row[] = [];
  const removed: Row[] = [];
  const changed: Array<{ o: Row; n: Row }> = [];

  if (plan.mode === 'key') {
    const first = (rows: Row[]): Map<DiffCell, Row> => {
      const m = new Map<DiffCell, Row>();
      for (const r of rows) if (!m.has(r.v[plan.keyAt])) m.set(r.v[plan.keyAt], r);
      return m;
    };
    const om = first(o);
    const nm = first(n);
    out.duplicates = { old: o.length - om.size, new: n.length - nm.size };
    for (const [k, nr] of nm) {
      const or = om.get(k);
      if (!or) added.push(nr);
      else if (changedCells(plan, or.v, nr.v).length) changed.push({ o: or, n: nr });
      else out.counts.unchanged++;
    }
    for (const [k, or] of om) if (!nm.has(k)) removed.push(or);
  } else {
    // Signature → the rows carrying it, in file order; the k-th matches the k-th.
    const bySig = (rows: Row[]): Map<string, Row[]> => {
      const m = new Map<string, Row[]>();
      for (const r of rows) {
        const s = JSON.stringify(r.v);
        const list = m.get(s);
        if (list) list.push(r); else m.set(s, [r]);
      }
      return m;
    };
    const om = bySig(o);
    const nm = bySig(n);
    for (const [s, nrs] of nm) {
      const have = (om.get(s) || []).length;
      out.counts.unchanged += Math.min(have, nrs.length);
      added.push(...nrs.slice(have));
    }
    for (const [s, ors] of om) removed.push(...ors.slice((nm.get(s) || []).length));
  }

  out.counts.added = added.length;
  out.counts.removed = removed.length;
  out.counts.changed = changed.length;
  const byOrd = (a: Row, b: Row): number => a.ord - b.ord;
  out.added = added.sort(byOrd).slice(0, plan.limit).map((r) => ({ ord: r.ord, values: r.v }));
  out.removed = removed.sort(byOrd).slice(0, plan.limit).map((r) => ({ ord: r.ord, values: r.v }));
  out.changed = changed.sort((a, b) => a.n.ord - b.n.ord).slice(0, plan.limit).map((p) => ({
    ordOld: p.o.ord, ordNew: p.n.ord, key: p.n.v[plan.keyAt], cells: changedCells(plan, p.o.v, p.n.v),
  }));
  return out;
}
