// The builder's preview sample — PURE, and the reference for
// src/engine/sampleResident.ts, which selects the SAME rows in SQL.
//
// Above SAMPLE_MIN_ROWS the visual builder previews a chart that has no
// resident fast path (a split series, a raw scatter, a map) on about
// SAMPLE_TARGET rows instead of hydrating the whole table on every edit, and
// says so ("Preview computed on 250k of 1M rows"). Save and every dashboard
// still compute in full — the sample is never stored and never on a dashboard.
//
// THE RULE — app-chosen, stratified by the chart's category column, and
// deterministic (the same table gives the same sample on every run and on both
// engines, which is what lets the two implementations be tested against each
// other row for row):
//
//   within each category value, number the rows 1, 2, 3… in FILE order;
//   keep row i when  ⌊i·T/N⌋ > ⌊(i−1)·T/N⌋   (T = target, N = table rows)
//   and always keep i = 1 while the category has ≤ MAX_STRATA values.
//
// That is systematic sampling at rate T/N inside every stratum: each category
// keeps its share of the table (to within one row), rows are spread evenly
// through the file rather than bunched at the start, and a rare category is
// never sampled away — its first row always survives. Integer arithmetic only
// (T·i < 2^53 for any table under the 1M cap), so JS and DuckDB agree exactly.

import type { Cell } from '../data/transforms';

export const SAMPLE_MIN_ROWS = 250_000;
export const SAMPLE_TARGET = 250_000;
/** Above this many distinct category values, the first-row guarantee is off —
 *  one kept row per value of a near-unique column would keep the whole table. */
export const MAX_STRATA = 1000;

export interface SampleInfo {
  /** Rows the preview was computed on. */
  rows: number;
  /** Rows in the table. */
  of: number;
  /** The column the sample was stratified by, if any. */
  by: string | null;
}

/** Whether rank `i` (1-based, within its stratum) is kept at target T of N. */
export function keepRank(i: number, target: number, total: number, guaranteeFirst: boolean): boolean {
  if (total <= target) return true;
  if (guaranteeFirst && i === 1) return true;
  return Math.floor((i * target) / total) > Math.floor(((i - 1) * target) / total);
}

/** The key rows are stratified on — the cell's text, with null its own stratum. */
function stratumKey(cell: Cell): string {
  return cell === null || cell === undefined ? '\u0000null' : typeof cell + ':' + String(cell);
}

/**
 * The indexes (in file order) of the rows kept. `catIndex` -1 = no category:
 * one stratum, i.e. plain systematic sampling.
 */
export function stratifiedIndexes(rows: Cell[][], catIndex: number, target = SAMPLE_TARGET): number[] {
  const total = rows.length;
  if (total <= target) return rows.map((_, i) => i);
  let guaranteeFirst = false;
  if (catIndex >= 0) {
    const distinct = new Set<string>();
    for (const r of rows) {
      distinct.add(stratumKey(r[catIndex] ?? null));
      if (distinct.size > MAX_STRATA) break;
    }
    guaranteeFirst = distinct.size <= MAX_STRATA;
  }
  const rank = new Map<string, number>();
  const kept: number[] = [];
  for (let i = 0; i < total; i++) {
    const k = catIndex >= 0 ? stratumKey(rows[i][catIndex] ?? null) : '';
    const n = (rank.get(k) || 0) + 1;
    rank.set(k, n);
    if (keepRank(n, target, total, guaranteeFirst)) kept.push(i);
  }
  return kept;
}

/** "Preview computed on 250k of 1M rows" — the builder's note. */
export function sampleNote(info: SampleInfo): string {
  return `Preview computed on ${compactCount(info.rows)} of ${compactCount(info.of)} rows`;
}

function compactCount(n: number): string {
  if (n >= 1_000_000) return (Math.round(n / 100_000) / 10).toString().replace(/\.0$/, '') + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}
