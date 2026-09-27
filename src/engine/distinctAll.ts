'use strict';

// EVERY distinct value of one text/date column — resident first, with its JS
// reference beside it. MAIN PROCESS ONLY.
//
// `datasetPage.readDistinctPage` is a PICKER's read: first-seen order, capped at
// MAX_DISTINCT (200), which is right for a dropdown and wrong for "the two most
// recent periods" — two years of daily dates is 731 values, so the page ends in
// July of the first year and the "latest" periods were eighteen months stale.
// This reads them all (up to a bound that says "these are not periods"), and
// hands them back in code-unit order so both paths return the same array.
//
// Empty is what the picker's read calls empty — null and '' only — because the
// callers turn these into `=`/`contains` filters over the same cells.

import type { ParsedColumn } from '../data/parse';
import type { Cell } from '../data/transforms';
import { plainFrom } from './residentQuery';
import type { ResidentSource } from './residentQuery';
import { bomSafe, phys } from './residentCategory';
import * as duck from './duckdb';

/** Past this many distinct values a column is not a list of periods. */
export const MAX_ALL = 100_000;

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The JS reference. Null when the column is missing or holds more than `cap` values. */
export function distinctAllJs(columns: ParsedColumn[], rows: Cell[][], column: string, cap = MAX_ALL): string[] | null {
  const ci = (Array.isArray(columns) ? columns : []).findIndex((c) => c && c.name === column);
  if (ci < 0) return null;
  const seen = new Set<string>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const cell = r ? r[ci] : null;
    if (cell == null || cell === '') continue;
    seen.add(String(cell));
    if (seen.size > cap) return null;
  }
  return Array.from(seen).sort(byCode);
}

/** The same, off the stored Parquet in place. Null on any failure or past `cap`. */
export async function distinctAllResident(src: ResidentSource, column: string, cap = MAX_ALL): Promise<string[] | null> {
  try {
    const cols = src && Array.isArray(src.columns) ? src.columns : [];
    const ci = cols.findIndex((c) => c && c.name === column);
    if (ci < 0 || cols[ci].type === 'number') return null; // a number's text is not its stored cell's
    const p = phys(ci);
    const rows = await duck.queryAsync(
      `SELECT DISTINCT ${bomSafe(p)} AS v FROM ${plainFrom(src.parquetPath)} WHERE ${p} IS NOT NULL AND CAST(${p} AS VARCHAR) <> '' LIMIT ${cap + 1};`,
    );
    if (rows.length > cap) return null;
    return rows.map((r) => String(r.v)).sort(byCode);
  } catch (_) {
    return null;
  }
}
