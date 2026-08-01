'use strict';

// datasetPage — ONE WINDOW of a dataset's rows, read straight off its Parquet
// file. MAIN PROCESS ONLY. Never throws: `readPage` returns `null` when the
// bridge is down or the query fails, and the caller keeps its working JS path.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// `parse.ts` caps every import at 50,000 rows. That cap is not about parsing —
// it is about the Explore grid. `renderer/hub/datasets.ts` does `expRows =
// ds.rows` (:361) and holds the whole table in renderer memory, then COPIES it
// again on every keystroke and every header click (`explorerDisplayRows`, :502).
// So the whole table is materialised into `Cell[][]` in main, structured-cloned
// across the bridge, and re-copied per interaction — for a viewport that shows
// a few dozen rows.
//
// Charts, metrics and stats already read Parquet in place and hydrate nothing
// (`residentQuery.ts`, `statsResident.ts`, docs/phase-2.5/README.md). The
// Explore grid is the LAST consumer that materialises everything, and it is
// what blocks raising the cap. This module is the server-side paged read that
// replaces it: search, sort and slice all happen in DuckDB, and the only thing
// that crosses the bridge is the window the grid is about to draw.
//
// ── What it must reproduce, exactly ──────────────────────────────────────────
// `readPage(src, req)` ≡ `pageRowsJs(columns, rows, req)` applied to
// `parquetStore.readTable(src.parquetPath, src.columns)`, where `pageRowsJs` is
// a verbatim transcription of the renderer's `explorerDisplayRows` +
// `sortCompare` followed by `.slice(offset, offset + limit)`. `pageRowsJs` is
// EXPORTED because it is both the test oracle and the IPC handler's fallback
// for a v2 (non-Parquet) record — one reference implementation, not two.
//
// The divergences that had to be engineered around:
//
//   1. STABLE PAGING. A `SELECT … ORDER BY <key> LIMIT ? OFFSET ?` with ties in
//      `<key>` may return the tied rows in a different order for page 2 than it
//      did for page 1 — a parallel top-N is under no obligation to be stable —
//      so a row can appear on both pages while another appears on neither. The
//      fix is a TOTAL order: every ORDER BY ends with the file ordinal, so no
//      two rows are ever tied. `scripts/test-datasetPage.ts` pages a
//      many-ties table and asserts the concatenation is an exact permutation.
//
//      The ordinal is `read_parquet(…, file_row_number=true)`: the row's index
//      WITHIN THE FILE, a physical property of the stored data, so unlike
//      `row_number() OVER ()` it does not depend on the order rows reach an
//      operator under a parallel scan. It is also, for the unsorted case, THE
//      DEFAULT ORDER — file order is the order the grid shows today, because
//      `readTable` returns rows in file order and the renderer never reorders
//      them. `row_number() OVER ()` is kept as a one-time downgrade for a build
//      that rejects the option, exactly as `residentQuery.ts` does.
//
//      This also makes the resident sort match the JS one for FREE: JS
//      `Array.prototype.sort` is stable, and the array it sorts is in file
//      order, so "equal keys keep file order" is the same rule on both sides.
//
//   2. SORTING RESPECTS THE DECLARED COLUMN TYPE. A `number` column sorts
//      numerically; `text`/`date` sort as text. The gate is in TS, on
//      `column.type`, before any SQL exists — never `TRY_CAST` a text column to
//      sort it, because `TRY_CAST('007' AS DOUBLE)` is 7 and would collapse
//      '007', '07' and '7' into one indistinguishable key. Same rule, same
//      reason as `residentQuery.aggExpr`.
//
//   3. TEXT SORTS WITH `localeCompare`, NOT BYTE ORDER. The grid compares
//      `String(a).localeCompare(String(b))` — ICU collation, where 'a' < 'B'
//      and 'é' < 'f'. DuckDB's default VARCHAR comparison is BINARY, where
//      'B' < 'a' and 'é' > 'f'. Sorting a mixed-case column would visibly
//      reorder. `COLLATE en` (the bundled ICU extension) reproduces
//      `localeCompare` exactly on the whole tricky set this repo tests —
//      case pairs, accents, leading spaces, punctuation, ß/ẞ, İ, CJK. If a
//      build has no ICU, `collationOk` latches false and a TEXT sort returns
//      `null` (→ the exact JS path) rather than silently serving byte order.
//
//   4. EMPTIES SORT LAST IN BOTH DIRECTIONS, and "empty" here is `cell == null
//      || cell === ''` — NOT `sqlGen.sqlEmpty`, which also treats whitespace-
//      only as empty. `sortCompare` tests `a === ''` exactly, so '   ' is a
//      REAL value that sorts among the others. Reusing the shared predicate
//      would have been the natural mistake and would move whitespace rows.
//
//   5. `total` IS THE POST-SEARCH, PRE-PAGE COUNT. The grid needs it for the
//      "N rows" label and the scrollbar, and it cannot be derived from a page.
//      It is a second statement rather than a `count(*) OVER ()` window,
//      because a window count vanishes when `offset` is past the end — which is
//      precisely when the renderer most needs to know how far back to jump.
//
// ── What could NOT be reproduced ─────────────────────────────────────────────
// See the notes on `matchExpr` (case folding) and `colIndex` (duplicate column
// names). Both are listed there rather than papered over.

import type { ColumnType, ParsedColumn } from './parse';
import type { Cell } from './transforms';
import { relationSql } from './parquetStore';
import * as duck from './duckdb';

// ── Public shapes ────────────────────────────────────────────────────────────

export interface PageSource {
  /** Absolute path to the dataset's `.parquet` file. */
  parquetPath: string;
  /**
   * The record's stored `ParsedColumn[]`, POSITIONALLY ALIGNED to the file —
   * the same contract `parquetStore.readTable(path, schema)`,
   * `residentQuery.ResidentSource` and `datasets.residentSource` take.
   */
  columns: ParsedColumn[];
}

export interface PageRequest {
  /** First row of the window, 0-based. Past the end yields an empty page. */
  offset: number;
  /** Window size. Clamped to `MAX_LIMIT`. */
  limit: number;
  /** Case-insensitive substring, tested against EVERY column. */
  search?: string;
  /** A user-facing column NAME, resolved against the schema. */
  sortColumn?: string;
  sortDir?: 'asc' | 'desc';
}

export interface PageResult {
  /** Exactly the requested window. */
  rows: Cell[][];
  /** Rows matching `search`, BEFORE paging. */
  total: number;
  /** The offset actually used (the request's, floored and clamped to >= 0). */
  offset: number;
}

/**
 * The most rows one call will return. A grid draws tens; this is the ceiling on
 * how much a single structured clone can cost, not a target.
 */
export const MAX_LIMIT = 5000;

// ── Public API ───────────────────────────────────────────────────────────────

/** True when a page can be served straight off Parquet. Never throws. */
export function isPageResident(): boolean {
  try {
    return duck.isAvailable();
  } catch {
    return false;
  }
}

/**
 * One window of a dataset's rows, plus the post-search row count.
 *
 * Byte-for-byte the result of `pageRowsJs(columns, rows, req)` over
 * `parquetStore.readTable(src.parquetPath, src.columns).rows`, computed without
 * hydrating a single row outside the window.
 *
 * Returns `null` — never throws — when the bridge is unavailable, the file is
 * missing/corrupt, the schema is empty or malformed, `offset`/`limit` are not
 * finite numbers, or the query fails. `null` ALWAYS means "fall back", never
 * "no rows": an empty page is returned as a real `PageResult` with `rows: []`.
 */
export function readPage(src: PageSource, req: PageRequest): PageResult | null {
  try {
    const cols = schemaOf(src);
    if (!cols) return null;
    const r = normalize(cols, req);
    if (!r) return null;
    // A text sort on a build with no ICU cannot be served faithfully (note 3).
    if (r.sort && r.sort.kind === 'text' && !collationOk) return null;

    const total = countRows(src.parquetPath, cols, r);
    if (total === null) return null;

    if (r.limit === 0 || r.offset >= total) return { rows: [], total, offset: r.offset };

    const out = runPage(src.parquetPath, cols, r, ordinalMode);
    if (out === null) return null;

    const rows: Cell[][] = out.map((row) => {
      const cells: Cell[] = new Array(cols.length);
      for (let c = 0; c < cols.length; c += 1) cells[c] = toCell(row[`v${c}`] ?? null, cols[c].type);
      return cells;
    });
    return { rows, total, offset: r.offset };
  } catch {
    // Bridge down, missing file, non-Parquet bytes, width mismatch, no ICU —
    // one answer: the caller keeps its working JS path.
    return null;
  }
}

/**
 * THE REFERENCE IMPLEMENTATION, and the fallback the IPC handler uses for a v2
 * (rows-inline) record.
 *
 * A verbatim transcription of `renderer/hub/datasets.ts`'s
 * `explorerDisplayRows()` (search + sort over an index-preserving copy) and
 * `sortCompare()`, followed by the slice the grid would have taken. It is
 * exported so there is exactly ONE definition of "what the Explore grid shows",
 * shared by the fallback path and by every differential assertion in
 * `scripts/test-datasetPage.ts`.
 *
 * Pure: `rows` is never mutated.
 */
export function pageRowsJs(columns: ParsedColumn[], rows: Cell[][], req: PageRequest): PageResult {
  const cols = Array.isArray(columns) ? columns : [];
  const r = normalize(cols, req) ?? { offset: 0, limit: 0, needle: '', sort: null };

  let list: Cell[][] = (Array.isArray(rows) ? rows : []).map((row) => (Array.isArray(row) ? row : []));

  if (r.needle) {
    const q = r.needle.toLowerCase();
    list = list.filter((row) =>
      cols.some((_, c) => {
        const v = row[c];
        return v != null && String(v).toLowerCase().includes(q);
      }),
    );
  }

  if (r.sort) {
    const { index, type, dir } = r.sort;
    list = list.slice().sort((a, b) => sortCompare(a[index], b[index], type, dir));
  }

  return { rows: list.slice(r.offset, r.offset + r.limit), total: list.length, offset: r.offset };
}

/**
 * `renderer/hub/datasets.ts:484` verbatim. Empties sort last regardless of
 * direction; numbers numeric, text/date lexical via `localeCompare`.
 */
function sortCompare(a: Cell, b: Cell, type: ColumnType, dir: number): number {
  const aE = a == null || a === '';
  const bE = b == null || b === '';
  if (aE && bE) return 0;
  if (aE) return 1;
  if (bE) return -1;
  let c: number;
  if (type === 'number') {
    const an = typeof a === 'number' ? a : Number(a);
    const bn = typeof b === 'number' ? b : Number(b);
    c = an < bn ? -1 : an > bn ? 1 : 0;
  } else {
    c = String(a).localeCompare(String(b));
  }
  return c * dir;
}

// ── Request normalisation ────────────────────────────────────────────────────

interface SortSpec {
  index: number;
  type: ColumnType;
  /** `'number'` sorts numerically; `'text'` needs ICU collation. */
  kind: 'number' | 'text';
  /** 1 asc, -1 desc — the renderer's `expSortDir`. */
  dir: number;
}

interface NormalRequest {
  offset: number;
  limit: number;
  /** Already trimmed. `''` means "no search". */
  needle: string;
  sort: SortSpec | null;
}

/**
 * Untrusted renderer input → a bounded, schema-resolved request. `null` means
 * the request itself is unusable (a non-finite offset/limit), which is a
 * fallback rather than a guess.
 *
 * The SORT COLUMN NEVER REACHES SQL. It is resolved here to an INDEX, and only
 * the positional physical name `c<index>` is ever generated — so identifier
 * quoting, duplicate names and column-name injection are structurally out of
 * reach, the same contract `sqlGen`/`residentQuery`/`statsResident` hold.
 * An unknown column is simply not a sort, matching the grid, whose `expSortCol`
 * can only ever be a real index.
 */
function normalize(cols: ParsedColumn[], req: PageRequest): NormalRequest | null {
  const raw = req && typeof req === 'object' ? req : ({} as PageRequest);

  const offset = intOr(raw.offset, null);
  const limit = intOr(raw.limit, null);
  if (offset === null || limit === null) return null;

  // `.trim()` here so the SQL side and the JS side see the SAME needle — the
  // renderer trims before lowercasing (`expSearch.trim().toLowerCase()`).
  const needle = typeof raw.search === 'string' ? raw.search.trim() : '';

  let sort: SortSpec | null = null;
  if (typeof raw.sortColumn === 'string' && raw.sortColumn !== '') {
    const index = colIndex(cols, raw.sortColumn);
    if (index >= 0) {
      const type = cols[index].type;
      sort = { index, type, kind: type === 'number' ? 'number' : 'text', dir: raw.sortDir === 'desc' ? -1 : 1 };
    }
  }

  return {
    offset: Math.max(0, offset),
    limit: Math.min(MAX_LIMIT, Math.max(0, limit)),
    needle,
    sort,
  };
}

function intOr(v: unknown, fallback: number | null): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

// ── SQL ──────────────────────────────────────────────────────────────────────
//
// Physical names are positional `c0..cN`, the same contract `sqlGen.ts`,
// `parquetStore.ts`, `residentQuery.ts` and `statsResident.ts` use. The only
// user-influenced TEXT in any statement is the file path, which
// `parquetStore.relationSql` validates and escapes; the search needle and both
// window bounds are BOUND PARAMETERS.

function phys(i: number): string {
  return `c${i}`;
}

/** A finite JS number, or NULL. Mirrors `sqlGen`'s private `sqlNum`. */
function sqlNum(p: string): string {
  return `CASE WHEN isfinite(TRY_CAST(${p} AS DOUBLE)) THEN TRY_CAST(${p} AS DOUBLE) END`;
}

// `src/duckdb.ts` loses exactly ONE leading U+FEFF from every returned string
// (documented there; the loss is below the JS layer). Doubling a leading BOM at
// projection time is an exact inverse, and a value that does not start with one
// is untouched — the same repair `parquetStore.readTable` applies. Cells are
// user data, so they get it. NOTE: it is applied to the PROJECTION ONLY. Sorting
// and searching run on the true stored value inside DuckDB, which never lost its
// BOM in the first place.
const BOM = 'chr(65279)';
function bomSafe(p: string): string {
  const v = `CAST(${p} AS VARCHAR)`;
  return `CASE WHEN starts_with(${v}, ${BOM}) THEN ${BOM} || ${v} ELSE ${v} END`;
}

/**
 * `sortCompare`'s emptiness test — `cell == null || cell === ''` — NOT
 * `sqlGen.sqlEmpty`. The shared predicate also trims, so it would call '   '
 * empty and sort those rows to the bottom; the grid treats whitespace as a real
 * value. Two different questions, deliberately two different predicates.
 */
function sortEmpty(s: SortSpec): string {
  const p = phys(s.index);
  // A number column's stored text reads back as a JS number or as null, and
  // `sqlNum` is NULL in exactly the null case — so one expression covers both
  // halves of the JS test.
  if (s.kind === 'number') return `${sqlNum(p)} IS NULL`;
  return `(${p} IS NULL OR ${p} = '')`;
}

/**
 * The sort KEY — NULL for every empty cell.
 *
 * `sortCompare` returns 0 for two empties, and `Array.prototype.sort` is
 * stable, so two empty cells keep FILE ORDER. Ordering the empty partition by
 * its raw value instead would put `''` and `null` in DuckDB's NULLS-LAST order
 * rather than the order they appear in the file — a real, measured divergence.
 * Collapsing every empty to one NULL key makes them all tie, so the trailing
 * ordinal decides, which IS file order.
 *
 * `sqlNum` already has this shape for a number column (it is NULL exactly when
 * the cell is empty), so only the text branch needs the wrapper.
 */
function sortKey(s: SortSpec): string {
  const p = phys(s.index);
  if (s.kind === 'number') return sqlNum(p);
  return `(CASE WHEN ${p} IS NULL OR ${p} = '' THEN NULL ELSE ${p} END) COLLATE en`;
}

/**
 * The searchable STRING form of a column, or NULL when the cell would not have
 * been searched at all.
 *
 * The grid tests `v != null && String(v).toLowerCase().includes(q)` on the
 * HYDRATED cell. For a text/date column the hydrated cell is the stored string
 * verbatim, so the stored VARCHAR is already `String(v)`. For a number column
 * the hydrated cell is `Number(stored)` when finite and `null` otherwise, and
 * the file only ever holds `String(<finite number>)` — which is canonical, so
 * `String(Number(stored)) === stored`. The finiteness gate is therefore the
 * whole difference, and NULL correctly drops the row for that column.
 *
 * ── COULD NOT BE REPRODUCED: case folding ───────────────────────────────────
 * `lower()` is DuckDB's Unicode fold, `toLowerCase()` is JS's, and they are not
 * the same function: measured, `lower('İ')` is 'i' (1 char) while
 * `'İ'.toLowerCase()` is 'i' + U+0307 (2 chars). BOTH SIDES of the comparison
 * are folded by DuckDB here (`contains(lower(v), lower(?))`) rather than
 * pre-folding the needle in JS, which keeps SQL self-consistent and, on the
 * İ case, actually agrees with JS where a JS-folded needle would not. A needle
 * whose two foldings differ can still match here and not there; it is ASCII-
 * identical, which is what a search box gets.
 */
function matchExpr(cols: ParsedColumn[], i: number): string {
  const p = phys(i);
  if (cols[i].type === 'number') {
    return `CASE WHEN isfinite(TRY_CAST(${p} AS DOUBLE)) THEN lower(CAST(${p} AS VARCHAR)) END`;
  }
  return `lower(CAST(${p} AS VARCHAR))`;
}

/**
 * `WHERE` for the search, plus its bound parameters.
 *
 * The needle is pushed once PER COLUMN because `duck.query` binds positionally.
 * `contains(NULL, x)` is NULL, so a null cell is simply not a match — exactly
 * the `v != null` guard.
 */
function whereClause(cols: ParsedColumn[], needle: string, params: duck.DuckValue[]): string {
  if (needle === '') return '';
  const preds = cols.map((_, i) => {
    params.push(needle);
    return `contains(${matchExpr(cols, i)}, lower(CAST(? AS VARCHAR)))`;
  });
  return ` WHERE (${preds.join(' OR ')})`;
}

/** `transforms.colIndex` — exact, case-sensitive, FIRST match.
 *
 * ── COULD NOT BE REPRODUCED: duplicate column names ─────────────────────────
 * The grid sorts by column INDEX (`expSortCol`), so with two identically-named
 * columns it can sort by the second one. This API takes a NAME and resolves it
 * to the first match, so it would sort by the first. A caller that needs the
 * distinction must rename the column.
 */
function colIndex(cols: ParsedColumn[], name: string): number {
  for (let i = 0; i < cols.length; i += 1) {
    if (cols[i] && cols[i].name === name) return i;
  }
  return -1;
}

// ── Ordinal mode ─────────────────────────────────────────────────────────────
//
// `file_row_number=true` is the ordinal and the default order (see the header).
// If a DuckDB build rejects the option we downgrade ONCE, permanently, to
// `row_number() OVER ()` — measured stable here, just not stable by
// construction. The happy path costs no probe query.

type OrdinalMode = 'file_row_number' | 'row_number';
let ordinalMode: OrdinalMode = 'file_row_number';

/** Latches false the first time a build turns out to have no ICU collation. */
let collationOk = true;

function orderedFrom(parquetPath: string, mode: OrdinalMode): { from: string; ord: string } {
  const base = relationSql(parquetPath); // read_parquet('…') — validated + escaped
  if (mode === 'file_row_number') {
    return { from: `${base.slice(0, -1)}, file_row_number=true)`, ord: 'file_row_number' };
  }
  return { from: `(SELECT row_number() OVER () AS __ord, * FROM ${base})`, ord: '__ord' };
}

/**
 * The window, in the exact order the grid would show it.
 *
 * Every ORDER BY ends with the ordinal, so the order is TOTAL and paging is
 * stable (header note 1). For the unsorted case the ordinal is the ONLY term,
 * which is file order — what the grid shows today.
 */
function runPage(
  parquetPath: string,
  cols: ParsedColumn[],
  r: NormalRequest,
  mode: OrdinalMode,
): duck.DuckRow[] | null {
  const params: duck.DuckValue[] = [];
  const where = whereClause(cols, r.needle, params);
  const { from, ord } = orderedFrom(parquetPath, mode);

  const order: string[] = [];
  if (r.sort) {
    const dir = r.sort.dir === -1 ? 'DESC' : 'ASC';
    // Empties last in BOTH directions — the leading term is always ASC.
    order.push(`${sortEmpty(r.sort)} ASC`);
    order.push(`${sortKey(r.sort)} ${dir}`);
  }
  order.push(`${ord} ASC`);

  const projection = cols.map((_, i) => `${bomSafe(phys(i))} AS v${i}`).join(', ');
  const sql =
    `SELECT ${projection} FROM ${from}${where} ` +
    `ORDER BY ${order.join(', ')} LIMIT ? OFFSET ?;`;
  params.push(r.limit, r.offset);

  try {
    return duck.query(sql, params);
  } catch (err) {
    const msg = String((err as Error)?.message ?? '');
    if (mode === 'file_row_number' && /file_row_number/i.test(msg)) {
      ordinalMode = 'row_number';
      return runPage(parquetPath, cols, r, 'row_number');
    }
    // No ICU: remember it, so later text sorts fall back without paying a
    // doomed query, and let this call fall back too.
    if (r.sort && r.sort.kind === 'text' && /collation/i.test(msg)) collationOk = false;
    throw err;
  }
}

/** Rows matching the search, before paging. `null` means "fall back". */
function countRows(parquetPath: string, cols: ParsedColumn[], r: NormalRequest): number | null {
  const params: duck.DuckValue[] = [];
  const where = whereClause(cols, r.needle, params);
  const out = duck.query(`SELECT count(*) AS n FROM ${relationSql(parquetPath)}${where};`, params);
  if (out.length !== 1) return null;
  return intOrNull(out[0].n);
}

// ── Result decoding ──────────────────────────────────────────────────────────

/**
 * `parquetStore.toCell` — the inverse of `String(cell)`, NOT a re-parse.
 * Reusing `parse.coerceValue` here would map `''` to `null`, which is an INGEST
 * rule (parse.ts:219) and would erase the `null` vs `''` distinction the whole
 * storage layer exists to preserve.
 */
function toCell(raw: duck.DuckValue, type: ColumnType): Cell {
  if (raw == null) return null;
  if (type !== 'number') return typeof raw === 'string' ? raw : String(raw);
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** A count: a finite, non-negative integer, or null (which means "fall back"). */
function intOrNull(raw: duck.DuckValue): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * The source is usable only when every column is a real `ParsedColumn`. A
 * 0-column dataset falls back: the file holds only a sentinel column, so there
 * is no `c0` to project, and a grid with no columns has nothing to page.
 */
function schemaOf(src: PageSource): ParsedColumn[] | null {
  if (!src || typeof src.parquetPath !== 'string' || !Array.isArray(src.columns)) return null;
  if (src.columns.length === 0) return null;
  for (const col of src.columns) {
    if (!col || typeof col !== 'object' || typeof col.name !== 'string') return null;
  }
  return src.columns;
}
