// The value index (src/ipc/valueIndex.ts), the engine half — MAIN PROCESS ONLY: its build's two statements over a
// table's Parquet, the sidecar it writes beside that table, and an ask's ONE lookup over the sidecars of its datasets.
//
// THE BUILD. First the exact distinct count of each column's values of up to VALUE_BYTES (`approx_count_distinct` was
// 25% off on 8,000 values, so it cannot pick which column is under the cap); then, over the columns at or under
// MAX_DISTINCT alone, each value and its first row (the ordinal the scan orders by), so a column of ids is never grouped.
// A value over VALUE_BYTES is never listed by the ask (valueSearchResident), so it is neither counted nor kept.
//
// THE SIDECAR (`<id>.values.parquet` beside the table, or on S3 an object of its table version named with `valuesTag`:
// ../engine/storage), written by
// parquetStore.writeTableAsync like the table itself (temp then rename; an S3 object appears whole). Four VARCHAR columns
// (SIDECAR_COLUMNS): one row per (value, word of it) — the word's key (valueSearchResident wordKey), the column, the
// value, its first row — and first a SET row (key '#', column -1) whose value is the set as JSON: the build version, the
// stamp of the write it read, the columns it holds whole, the catalog marks then.
//
// THE LOOKUP. One statement over the sidecars the caller knows are written (src/ipc/valueIndex sidecarsOf): each set row, and the values whose keys fall in the question
// words' ranges (valueSearchResident keyRange), at most CANDIDATES a column, first row first, with how many matched.
// Null on any failure; the ask then scans every dataset, as before.

import { createHash } from 'crypto';
import type { ParsedColumn } from '../data/parse';
import type { Cell } from '../data/transforms';
import { runOrderedAsync } from './residentQuery';
import { assertPath, relationSql, sqlStr } from './parquetStore';
import { bomSafe, phys } from './residentCategory';
import { VALUE_BYTES } from './valueSearchResident';
import * as duck from './duckdb';

/**
 * Distinct values a column may have and be indexed. Measured on 1,000,000 rows (a laptop): the first statement over five
 * text columns, one of a million ids, 17 to 40 ms; the second over four columns of 4, 1,000, 8,000 and 500 values, 120 to
 * 130 ms. 10,000 is ⌘K's cap too (../data/dataSearch INDEX_MAX_DISTINCT): past it a column is ids, emails or free text,
 * whose words an ask rarely names, and it would cost the index more rows than the rest of the dataset together.
 */
export const MAX_DISTINCT = 10_000;
/** Bump when what a build writes changes (the keys, the columns held): every sidecar is then stale, and the job builds each again. */
export const VALUE_INDEX_VERSION = 1;
/** Candidates one lookup returns a column at most, first row first, with how many there were. */
export const CANDIDATES = 100;

/** An S3 sidecar's tag (in its name): the build version and the catalog marks it was built under, hashed. */
export const valuesTag = (marked: readonly string[]): string =>
  `${VALUE_INDEX_VERSION}-${createHash('sha256').update(JSON.stringify(marked)).digest('hex').slice(0, 8)}`;

/** What a sidecar was built from: the record's updatedAt and rowCount, both written in the table write's own record write. */
export const stampOf = (m: { updatedAt: string; rowCount: number }): string => `${m.updatedAt}/${m.rowCount}`;

export interface ValueSet { version: number; stamp: string; indexed: number[]; marked: string[] }
export interface ValueRow { col: number; word: string; value: string; ord: number }
export interface Found {
  set: ValueSet | null;
  /** column → its candidates `[value, first row]`, first row first (at most CANDIDATES), and how many matched in all. */
  columns: Map<number, { values: Array<[string, number]>; n: number }>;
}

export interface ColumnValues {
  col: number;
  /** `[value, first row]` in first-row order, or null: past `cap` distinct values, not indexed. */
  values: Array<[string, number]> | null;
}

const short = (i: number): string => `CASE WHEN strlen(CAST(${phys(i)} AS VARCHAR)) <= ${VALUE_BYTES} THEN CAST(${phys(i)} AS VARCHAR) END`;

/** Each of `cols` (text columns of `columns`), in their order. Null on any failure. */
export async function distinctValuesResident(parquetPath: string, columns: ParsedColumn[], cols: readonly number[], cap = MAX_DISTINCT): Promise<ColumnValues[] | null> {
  const ci = [...new Set(cols)].filter((i) => Number.isInteger(i) && i >= 0 && i < columns.length).sort((a, b) => a - b);
  if (!ci.length) return [];
  try {
    const [counts] = await duck.queryAsync(`SELECT ${ci.map((i) => `CAST(count(DISTINCT ${short(i)}) AS DOUBLE) AS n${i}`).join(', ')} FROM ${relationSql(parquetPath)};`);
    const under = ci.filter((i) => Number(counts[`n${i}`]) <= cap);
    const out = new Map<number, ColumnValues>(ci.map((i) => [i, { col: i, values: under.includes(i) ? [] : null }]));
    if (under.length) {
      const rows = await runOrderedAsync(parquetPath, (from, ord) => {
        const all = `SELECT ${ord} AS o, UNNEST([${under.join(', ')}]) AS c, UNNEST([${under.map(short).join(', ')}]) AS v FROM ${from}`;
        return `SELECT c, ${bomSafe('v')} AS v, CAST(MIN(o) AS DOUBLE) AS o FROM (${all}) WHERE v IS NOT NULL GROUP BY c, v ORDER BY c, MIN(o);`;
      }, []);
      for (const r of rows) out.get(Number(r.c))!.values!.push([String(r.v), Number(r.o)]);
    }
    return [...out.values()];
  } catch {
    return null;
  }
}

// ── The sidecar ──────────────────────────────────────────────────────────────

export const SIDECAR_COLUMNS: ParsedColumn[] = [{ name: 'word', type: 'text' }, { name: 'col', type: 'number' }, { name: 'value', type: 'text' }, { name: 'ord', type: 'number' }];
const SET_COL = -1;
/** The set row's key: '#' is no word character, so no value's key is it or begins with it. */
const SET_KEY = '#';
const SET_RANGE: [string, string] = [SET_KEY, '$'];

/** A sidecar's rows: its set first, then the values by key. */
export function sidecarRows(set: ValueSet, rows: readonly ValueRow[]): Cell[][] {
  const sorted = [...rows].sort((a, b) => (a.word < b.word ? -1 : a.word > b.word ? 1 : a.col - b.col));
  return [[SET_KEY, SET_COL, JSON.stringify(set), 0], ...sorted.map((r) => [r.word, r.col, r.value, r.ord])];
}

const setOf = (json: unknown): ValueSet | null => {
  try {
    const s = JSON.parse(String(json));
    return s && typeof s.version === 'number' && typeof s.stamp === 'string' && Array.isArray(s.indexed) && Array.isArray(s.marked) ? s : null;
  } catch {
    return null;
  }
};

const list = (paths: readonly string[]): string => {
  for (const p of paths) assertPath(p);
  return `[${paths.map((p) => `'${sqlStr(p)}'`).join(', ')}]`;
};

/** Marks the lookup statement (scripts/test-askValueIndex.ts and test-askBudget count it). */
export const LOOKUP_MARK = '/* value index lookup */';

function lookupSql(files: string, ranges: number): string {
  return `${LOOKUP_MARK} WITH q(f, lo, hi) AS (VALUES ${Array.from({ length: ranges }, () => '(?, ?, ?)').join(', ')}),
    x AS (SELECT filename AS f, c0 AS w, CAST(c1 AS INTEGER) AS c, c2 AS v, CAST(c3 AS DOUBLE) AS o FROM read_parquet(${files}, filename = true)),
    h AS (SELECT DISTINCT x.f, x.c, x.v, x.o FROM x JOIN q ON x.f = q.f AND x.w >= q.lo AND x.w < q.hi),
    r AS (SELECT h.*, row_number() OVER (PARTITION BY h.f, h.c ORDER BY h.o) AS k, count(*) OVER (PARTITION BY h.f, h.c) AS n FROM h)
    SELECT f, c, ${bomSafe('v')} AS v, o, CAST(n AS DOUBLE) AS n FROM r WHERE k <= ${CANDIDATES} ORDER BY f, c, o;`;
}

/** ONE statement for one ask, over sidecars that are written (a missing one fails it: null, and the ask scans). Datasets with no row in it are not in the map. */
export async function lookupValuesResident(files: ReadonlyArray<{ datasetId: string; path: string; ranges: ReadonlyArray<[string, string]> }>): Promise<Map<string, Found> | null> {
  if (!files.length) return new Map();
  const params = files.flatMap((f) => [SET_RANGE, ...f.ranges].flatMap(([lo, hi]) => [f.path, lo, hi]));
  try {
    return foundOf(await duck.queryAsync(lookupSql(list(files.map((f) => f.path)), params.length / 3), params), files);
  } catch {
    return null;
  }
}

function foundOf(rows: duck.DuckRow[], files: ReadonlyArray<{ datasetId: string; path: string }>): Map<string, Found> {
  const byPath = new Map(files.map((f) => [f.path, f.datasetId]));
  const out = new Map<string, Found>();
  for (const r of rows) {
    const id = byPath.get(String(r.f));
    if (!id) continue;
    const found = out.get(id) ?? out.set(id, { set: null, columns: new Map() }).get(id)!;
    const c = Number(r.c);
    if (c === SET_COL) {
      found.set = setOf(r.v);
      continue;
    }
    const col = found.columns.get(c) ?? found.columns.set(c, { values: [], n: Number(r.n) }).get(c)!;
    col.values.push([String(r.v), Number(r.o)]);
  }
  return out;
}

/** The sets of `paths` (the job, over a project's local sidecars): path → its set. Null on any failure. */
export async function setsResident(paths: readonly string[]): Promise<Map<string, ValueSet | null> | null> {
  if (!paths.length) return new Map();
  try {
    const rows = await duck.queryAsync(`SELECT filename AS f, c2 AS v FROM read_parquet(${list(paths)}, filename = true) WHERE c0 = '${SET_KEY}';`);
    return new Map(rows.map((r) => [String(r.f), setOf(r.v)]));
  } catch {
    return null;
  }
}
