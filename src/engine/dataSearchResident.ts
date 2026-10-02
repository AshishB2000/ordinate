'use strict';

// Search inside the data — the RESIDENT half: the per-dataset value index and
// the bounded scan, both off the stored Parquet in place. MAIN PROCESS ONLY.
//
// Two ways to answer a column, picked per column:
//
//   INDEX  every distinct value of a low-cardinality text column (≤ 10k) with
//          its row count, written as `<id>.search.json` beside `<id>.parquet`
//          after each save and refresh. A lookup is a JS filter over it — no
//          query at all, so "Chairs" answers instantly however big the table.
//   SCAN   a column past 10k distinct values (ids, emails, free text) is asked
//          directly: ILIKE with the term's % _ \ escaped, empties excluded by
//          the spelled-out class (sqlGen.sqlEmpty), grouped and capped at 20.
//
// The index is STAMPED with the Parquet file's inode, size and mtime, read
// BEFORE the build starts. Every table write is a temp-then-rename, so any write
// — save, refresh, pipeline edit — makes a new stamp, and an index whose stamp
// is not the file's is ignored (and rebuilt). A rename or retype is metadata
// only: the index is positional, so it stays right, and a column that stopped
// being `text` is simply not read from it.
//
// Every query goes through `queryAsync`: the sync bridge would freeze every
// window per keystroke. All functions return null on failure; the caller
// decides what a missing answer means (searchDataset: skip that column).

import * as fs from 'fs';
import { randomUUID } from 'crypto';
import type { ParsedColumn } from '../data/parse';
import type { ColumnMatches, ValueMatch } from '../data/dataSearch';
import {
  INDEX_MAX_DISTINCT, PER_COLUMN_CAP, escapeLike, matchPairs, needleOf, searchableColumns,
} from '../data/dataSearch';
import { relationSql } from './parquetStore';
import { bomSafe, phys } from './residentCategory';
import { sqlEmpty } from './sqlGen';
import * as duck from './duckdb';

/** Wall-clock spent on one dataset's SCANS before the rest of its columns are skipped. */
export const BUDGET_MS = 300;
const INDEX_VERSION = 1;

export interface IndexColumn {
  index: number;
  name: string;
  /** `[value, rows]` in code-unit order, or null: past INDEX_MAX_DISTINCT, scan it. */
  values: Array<[string, number]> | null;
}

export interface SearchIndex {
  v: number;
  stamp: string;
  columns: IndexColumn[];
}

export interface ResidentSource {
  parquetPath: string;
  columns: ParsedColumn[];
}

export function indexPathFor(parquetPath: string): string {
  return parquetPath.replace(/\.parquet$/, '') + '.search.json';
}

/** What identifies one write of the table. Null when there is no file. */
export async function parquetStamp(parquetPath: string): Promise<string | null> {
  try {
    const st = await fs.promises.stat(parquetPath);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (_) {
    return null;
  }
}

// ── The index ────────────────────────────────────────────────────────────────

/** One column's `[value, rows]`, code-unit order; `null` values past the cap; null on failure. */
export async function valueCountsResident(parquetPath: string, ci: number, cap = INDEX_MAX_DISTINCT): Promise<IndexColumn['values'] | undefined> {
  try {
    const p = phys(ci);
    const rows = await duck.queryAsync(
      `SELECT ${bomSafe(p)} AS v, CAST(count(*) AS DOUBLE) AS n FROM ${relationSql(parquetPath)} ` +
      `WHERE NOT ${sqlEmpty(p)} GROUP BY ${p} LIMIT ${cap + 1};`,
    );
    if (rows.length > cap) return null;
    const pairs: Array<[string, number]> = rows.map((r) => [String(r.v), Number(r.n)]);
    return pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  } catch (_) {
    return undefined;
  }
}

/** Build the index for every text column. Null when the file is gone or a query failed. */
export async function buildIndex(src: ResidentSource): Promise<SearchIndex | null> {
  const stamp = await parquetStamp(src.parquetPath); // BEFORE reading: a write mid-build makes it stale
  if (!stamp) return null;
  const columns: IndexColumn[] = [];
  for (const ci of searchableColumns(src.columns, new Set())) {
    const values = await valueCountsResident(src.parquetPath, ci);
    if (values === undefined) return null;
    columns.push({ index: ci, name: String(src.columns[ci].name), values });
  }
  return { v: INDEX_VERSION, stamp, columns };
}

/** Build and write `<id>.search.json` atomically. Never throws; false when nothing was written. */
export async function writeIndex(src: ResidentSource): Promise<boolean> {
  try {
    const idx = await buildIndex(src);
    if (!idx) return false;
    const file = indexPathFor(src.parquetPath);
    const tmp = file + '.' + randomUUID() + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(idx), 'utf8');
    await fs.promises.rename(tmp, file);
    return true;
  } catch (_) {
    return false;
  }
}

/** The index, when it exists, parses, and describes the file as it is NOW. */
export async function readIndex(parquetPath: string): Promise<SearchIndex | null> {
  try {
    const [raw, stamp] = await Promise.all([
      fs.promises.readFile(indexPathFor(parquetPath), 'utf8'),
      parquetStamp(parquetPath),
    ]);
    const idx = JSON.parse(raw);
    if (!idx || idx.v !== INDEX_VERSION || !stamp || idx.stamp !== stamp || !Array.isArray(idx.columns)) return null;
    return idx as SearchIndex;
  } catch (_) {
    return null;
  }
}

export async function removeIndex(parquetPath: string): Promise<void> {
  await fs.promises.rm(indexPathFor(parquetPath), { force: true }).catch(() => { /* nothing to remove */ });
}

// Coalesce a burst of saves (an input table's edits, a run of prepare steps)
// into one build, a beat after the last. Unref'd: it never holds a quit open.
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const BUILD_DELAY_MS = 1500;

/** Rebuild the index soon. Failures are silent — a missing index only means a scan. */
export function scheduleIndex(src: ResidentSource, delayMs = BUILD_DELAY_MS): void {
  const prev = pending.get(src.parquetPath);
  if (prev) clearTimeout(prev);
  const columns = src.columns.map((c) => ({ ...c }));
  const t = setTimeout(() => {
    pending.delete(src.parquetPath);
    void writeIndex({ parquetPath: src.parquetPath, columns });
  }, delayMs);
  if (typeof t.unref === 'function') t.unref();
  pending.set(src.parquetPath, t);
}

// ── The bounded scan ─────────────────────────────────────────────────────────

/** One column by ILIKE: ≤ `cap` matches, ranked in SQL exactly as compareMatches ranks. Null on failure. */
export async function scanColumn(parquetPath: string, ci: number, term: string, cap = PER_COLUMN_CAP): Promise<ValueMatch[] | null> {
  const needle = needleOf(term);
  if (!needle) return [];
  try {
    const p = phys(ci);
    const v = `CAST(${p} AS VARCHAR)`;
    const rows = await duck.queryAsync(
      `SELECT ${bomSafe(p)} AS v, CAST(count(*) AS DOUBLE) AS n, ` +
      `CASE WHEN lower(${v}) = ? THEN 0 WHEN starts_with(lower(${v}), ?) THEN 1 ELSE 2 END AS r ` +
      `FROM ${relationSql(parquetPath)} WHERE NOT ${sqlEmpty(p)} AND ${v} ILIKE ? ESCAPE '\\' ` +
      `GROUP BY ${p} ORDER BY r, n DESC, ${v} LIMIT ${cap};`,
      [needle, needle, '%' + escapeLike(term.trim()) + '%'],
    );
    // Ranked again in JS from the value itself, so ONE rank function is the
    // truth and a disagreement would show as a reorder, not a wrong label.
    return matchPairs(rows.map((r) => [String(r.v), Number(r.n)] as [string, number]), needle, cap);
  } catch (_) {
    return null;
  }
}

// ── One dataset ──────────────────────────────────────────────────────────────

export interface DatasetSearchOpts {
  term: string;
  /** Column names never searched (sensitive, under the share policy). */
  exclude?: ReadonlySet<string>;
  /** The dataset's index, already read — null/undefined scans every column. */
  index?: SearchIndex | null;
  budgetMs?: number;
  /** Injected for the budget test. */
  now?: () => number;
  /** True once a newer search has started: stop before the next query. */
  cancelled?: () => boolean;
  /** Injected for the budget test; defaults to scanColumn. */
  scan?: (parquetPath: string, ci: number, term: string) => Promise<ValueMatch[] | null>;
}

export interface DatasetSearchResult {
  columns: ColumnMatches[];
  /** Columns left unsearched because the budget ran out. */
  skipped: number;
  /** Columns whose scan failed (logged by nobody: a search box is not a report). */
  failed: number;
}

/**
 * Search one dataset: indexed columns from the index, the rest by scan, until
 * the budget is spent. Null when cancelled — the caller drops the whole reply.
 *
 * ponytail: the budget is checked BETWEEN scans; a scan already in flight runs
 * to its end (the worker has no interrupt), so one huge column can overrun it
 * by its own scan time. Interrupting needs a DuckDB interrupt in duckdbWorker.
 */
export async function searchDataset(src: ResidentSource, opts: DatasetSearchOpts): Promise<DatasetSearchResult | null> {
  const needle = needleOf(opts.term);
  const out: DatasetSearchResult = { columns: [], skipped: 0, failed: 0 };
  if (!needle) return out;
  const now = opts.now || Date.now;
  const budget = opts.budgetMs ?? BUDGET_MS;
  const scan = opts.scan || scanColumn;
  const cancelled = opts.cancelled || ((): boolean => false);
  const byIndex = new Map<number, IndexColumn>();
  for (const c of (opts.index && opts.index.columns) || []) byIndex.set(c.index, c);

  const toScan: number[] = [];
  for (const ci of searchableColumns(src.columns, opts.exclude || new Set())) {
    const name = String(src.columns[ci].name);
    const hit = byIndex.get(ci);
    if (hit && hit.values) {
      const matches = matchPairs(hit.values, needle);
      if (matches.length) out.columns.push({ index: ci, column: name, matches });
    } else {
      toScan.push(ci);
    }
  }

  const start = now();
  for (let k = 0; k < toScan.length; k++) {
    if (cancelled()) return null;
    if (now() - start >= budget) { out.skipped = toScan.length - k; break; }
    const ci = toScan[k];
    const matches = await scan(src.parquetPath, ci, opts.term);
    if (matches === null) { out.failed++; continue; }
    if (matches.length) out.columns.push({ index: ci, column: String(src.columns[ci].name), matches });
  }
  if (cancelled()) return null;
  out.columns.sort((a, b) => a.index - b.index);
  return out;
}
