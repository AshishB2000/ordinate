'use strict';

// Search inside the data — the PURE half. MAIN PROCESS (no I/O, no DuckDB).
//
// ⌘K's "Data" group answers "where is California?" with dataset › column,
// the value and how many rows carry it. This file is what a match IS and how
// matches are ordered, plus the JS reference both resident paths
// (engine/dataSearchResident.ts) are asserted against with Object.is:
//
//   match    case-insensitive substring of the stored text value. Empty cells
//            (null, '' or whitespace — transforms.isEmptyCell) never match.
//   rank     0 exact, 1 prefix, 2 contains — case-insensitive, by
//            String.prototype.toLowerCase, which DuckDB's lower() mirrors.
//   order    rank, then row count descending, then the value in code-unit
//            order — a TOTAL order on distinct values, so the 20-per-column cap
//            keeps the same twenty on both paths.
//
// Only `text` columns are searched: a number's stored text is not what the
// grid shows, and a date is a period, not a name anyone types into ⌘K.

import type { ParsedColumn } from './parse';
import type { Cell } from './transforms';
import { isEmptyCell } from './transforms';

/** Matches kept per column. */
export const PER_COLUMN_CAP = 20;
/** A column with more distinct values than this is searched by a bounded scan, not the index. */
export const INDEX_MAX_DISTINCT = 10_000;

export type MatchRank = 0 | 1 | 2;

export interface ValueMatch {
  value: string;
  /** Rows of the column holding exactly this value. */
  rows: number;
  rank: MatchRank;
}

export interface ColumnMatches {
  /** Position in the dataset's columns — what the stored Parquet's `c<i>` is. */
  index: number;
  column: string;
  matches: ValueMatch[];
}

/** The needle every comparison uses: trimmed, lower-cased. '' means "no search". */
export function needleOf(term: unknown): string {
  return typeof term === 'string' ? term.trim().toLowerCase() : '';
}

/** 0 exact, 1 prefix, 2 contains, -1 no match. `needle` is already `needleOf`. */
export function rankOf(value: string, needle: string): MatchRank | -1 {
  if (!needle) return -1;
  const v = value.toLowerCase();
  if (v === needle) return 0;
  if (v.startsWith(needle)) return 1;
  return v.includes(needle) ? 2 : -1;
}

const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function compareMatches(a: ValueMatch, b: ValueMatch): number {
  return a.rank - b.rank || b.rows - a.rows || byCode(a.value, b.value);
}

/** `value, rows` pairs → the ranked, capped matches for `needle`. */
export function matchPairs(pairs: ReadonlyArray<readonly [string, number]>, needle: string, cap = PER_COLUMN_CAP): ValueMatch[] {
  const out: ValueMatch[] = [];
  for (const [value, rows] of pairs) {
    const rank = rankOf(value, needle);
    if (rank >= 0) out.push({ value, rows, rank: rank as MatchRank });
  }
  return out.sort(compareMatches).slice(0, cap);
}

/** The columns a search reads: `text` ones, minus the excluded names. */
export function searchableColumns(columns: ParsedColumn[], exclude: ReadonlySet<string>): number[] {
  const out: number[] = [];
  (Array.isArray(columns) ? columns : []).forEach((c, i) => {
    if (c && c.type === 'text' && !exclude.has(String(c.name))) out.push(i);
  });
  return out;
}

/** Every non-empty value of column `ci` with its row count, in code-unit order. Null past `cap` distinct. */
export function valueCountsJs(rows: Cell[][], ci: number, cap = Infinity): Array<[string, number]> | null {
  const counts = new Map<string, number>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const cell = r ? r[ci] : null;
    if (isEmptyCell(cell)) continue;
    const v = String(cell);
    counts.set(v, (counts.get(v) || 0) + 1);
    if (counts.size > cap) return null;
  }
  return Array.from(counts).sort((a, b) => byCode(a[0], b[0]));
}

/**
 * THE REFERENCE: scan every row of every searchable column. What the index and
 * the bounded ILIKE must both agree with.
 */
export function searchRowsJs(
  columns: ParsedColumn[], rows: Cell[][], term: string, exclude: ReadonlySet<string> = new Set(), cap = PER_COLUMN_CAP,
): ColumnMatches[] {
  const needle = needleOf(term);
  if (!needle) return [];
  const out: ColumnMatches[] = [];
  for (const ci of searchableColumns(columns, exclude)) {
    const matches = matchPairs(valueCountsJs(rows, ci) || [], needle, cap);
    if (matches.length) out.push({ index: ci, column: String(columns[ci].name), matches });
  }
  return out;
}

/**
 * The column names a search must not read: the ones marked sensitive, unless
 * the share policy's export path lets them out as they are (dataSearchRun.ts).
 */
export function excludedColumns(exportAction: string, marked: ReadonlySet<string>): Set<string> {
  return exportAction === 'include' ? new Set() : new Set(marked);
}

/** `%`, `_` and `\` are LIKE syntax; a user's term means them literally (ESCAPE '\'). */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => '\\' + ch);
}
