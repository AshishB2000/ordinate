// The key check (spec D2), JS REFERENCE: how many rows a declared key covers, how many are empty,
// and how many distinct keys repeat. PURE. `engine/keyCheckResident.ts` is its SQL twin;
// scripts/test-keyCheck.ts holds the two to `Object.is` agreement. The key rule is `joinJs.keyOf`.

import type { ParsedColumn } from '../data/parse';
import type { Cell } from '../data/transforms';
import type { KeyCheck } from '../app/tableDocs';
import { keyOf } from './joinJs';

/** What a check counts; `checkedAt` is stamped by whoever stores it. */
export type KeyCheckCounts = Omit<KeyCheck, 'checkedAt'>;

export function keyCheckJs(cells: Cell[], type: ParsedColumn['type']): KeyCheckCounts {
  const seen = new Map<string, number>();
  let empty = 0;
  for (const cell of cells) {
    const k = keyOf(cell, type);
    if (k === null) empty++;
    else seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  let repeatedKeys = 0;
  for (const n of seen.values()) if (n > 1) repeatedKeys++;
  return { rows: cells.length, empty, repeatedKeys };
}

/**
 * One reader for the three-column row both engines return, `[rows, empty, repeatedKeys]`.
 * An aggregate over no rows is SQL NULL and reads 0; anything not a finite count is null (a failure).
 */
export function keyCheckFromRow(row: readonly unknown[] | undefined): KeyCheckCounts | null {
  if (!row || row.length < 3) return null;
  const n = row.slice(0, 3).map((v) => (v === null ? 0 : typeof v === 'number' ? v : NaN));
  if (!n.every((v) => Number.isInteger(v) && v >= 0)) return null;
  return { rows: n[0], empty: n[1], repeatedKeys: n[2] };
}
