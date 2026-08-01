'use strict';

// datasetView — a TYPED, USER-NAMED SQL VIEW over a dataset's Parquet file.
// MAIN PROCESS ONLY. Nothing here throws except `viewSql` (pure, so a caller can
// see *why* a spec is unusable); `ensureView`/`dropView` return false instead.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// `parquetStore.ts` stores EVERY column as VARCHAR under POSITIONAL physical
// names `c0..cN`, with the dataset's JSON record as the only source of truth for
// user-facing names and Ordinate `ColumnType`s. That is deliberate and it is
// what stops DuckDB's sniffer turning `007` into `7`
// (docs/phase-0/06-duckdb-verification.md §2).
//
// The cost is that generated SQL cannot query the stored file: `sum("revenue")`
// fails (no such column) and `DESCRIBE` reports every column as VARCHAR, so a
// charting layer sees only ordinal scales (docs/phase-3/README.md, blocker B4).
//
// This module is the bridge. It creates
//
//   CREATE OR REPLACE VIEW "v" AS
//     SELECT CAST(c0 AS VARCHAR) AS "region",
//            CAST(CASE WHEN isfinite(TRY_CAST(c1 AS DOUBLE))
//                      THEN TRY_CAST(c1 AS DOUBLE) END AS DOUBLE) AS "revenue"
//     FROM read_parquet('…');
//
// so `SELECT "region", sum("revenue") … GROUP BY "region"` just works and
// `DESCRIBE` reports VARCHAR/DOUBLE. The storage decision is untouched: the file
// is still all-VARCHAR `c0..cN`, and the view is a pure projection derived from
// the record's metadata. A rename stays a metadata edit + one `CREATE OR
// REPLACE`.
//
// ── The four rules this file exists to enforce ───────────────────────────────
//
// 1. THE CAST FOLLOWS THE DECLARED TYPE, NEVER INFERENCE. Only a column the
//    record declares `number` is cast. A `text` or `date` column is passed
//    through as VARCHAR and is NEVER `TRY_CAST`-ed, because
//    `TRY_CAST('007' AS DOUBLE)` is `7` — the exact corruption the whole storage
//    design exists to prevent. An unrecognised type degrades to `text`, so a bad
//    record can only ever under-type, never mis-cast.
//    Consequence, and it is the intended one: `sum()` over a `text` view column
//    is a DuckDB BINDER ERROR, not a plausible wrong total. Loud beats subtly
//    wrong. `residentQuery.aggExpr` makes the same call in TS.
//
// 2. THE NUMBER EXPRESSION IS `sqlGen`'s, NOT A NEW ONE. `CASE WHEN
//    isfinite(TRY_CAST(x AS DOUBLE)) THEN TRY_CAST(x AS DOUBLE) END` — so
//    `'inf'`/`'nan'` degrade to NULL exactly as they do in the JS fold and in
//    `residentQuery` (06 §4 D6), and the outer `CAST(… AS DOUBLE)` keeps
//    `sum(INTEGER) → HUGEINT → decimal string` off the bridge (06 §4 D4).
//    `sqlGen.sqlNum` is module-private; this is the same third copy
//    `residentQuery` already keeps, not a second dialect.
//
// 3. NULL AND '' STAY DISTINCT. Text/date columns are projected untouched, so
//    the storage contract (`transforms.isEmptyCell` depends on the difference)
//    survives the view. Verified, not assumed — see scripts/test-datasetView.ts.
//
// 4. IDENTIFIERS ARE THE ONLY PLACE USER DATA REACHES SQL TEXT, so they are
//    quoted, de-duplicated and bounded here — see the two sections below.
//
// ── Column names: de-duplication and quoting ─────────────────────────────────
//
// A CSV header is user data. It can be `''`, a duplicate, a SQL keyword, or
// contain `"`, `;`, a newline or a NUL. A view needs unique, non-empty,
// properly-quoted identifiers, so `viewColumns()` maps the record's
// `ParsedColumn[]` to exactly what the view exposes. IT IS THE SINGLE SOURCE OF
// TRUTH: `viewSql` is built from it, and a caller must read exposed names from
// it rather than re-deriving them.
//
//   a. QUOTING — every identifier is emitted as `"…"` with embedded `"` doubled.
//      That is the whole escape: a `;`, a newline, `--`, or `DROP TABLE` inside
//      a name is inert text inside a delimited identifier (measured, see the
//      injection test). Nothing else is stripped or rewritten.
//   b. UNREPRESENTABLE NAMES are replaced WHOLESALE by `column_<1-based index>`,
//      never partially rewritten — a half-mangled name is a lie about the user's
//      data. Exactly three cases qualify: a non-string, `''` (DuckDB: "Parser
//      Error: zero-length delimited identifier"), and any name containing a NUL
//      byte (which cannot survive the native binding's C strings).
//      Whitespace-only names are legal and are KEPT verbatim.
//   c. DE-DUPLICATION is first-wins, left to right: a later collision gets
//      `_1`, `_2`, … until free. The comparison is ASCII-case-INSENSITIVE
//      because DuckDB's is: measured, `"a"` and `"A"` collide, while `"É"`/`"é"`
//      and `"İ"`/`"i"` do NOT (DuckDB folds ASCII only, so `toLowerCase()` —
//      which maps `İ` onto `i` — would invent collisions DuckDB does not have).
//      The `_N` suffix is DuckDB's OWN scheme for the duplicates it silently
//      renames; matching it means the names are the same either way. We still
//      compute them ourselves, because DuckDB's rename is silent and would leave
//      `viewColumns()` describing a view that does not exist.
//      A generated name can itself collide with a real column (`column_1`, or a
//      literal `a_1` next to two `a`s); the same loop resolves it, so the output
//      is always unique and always a pure function of the input list.
//
// ── View names ───────────────────────────────────────────────────────────────
// The caller derives these from dataset UUIDs. This module does NOT build a name
// from an id — it VALIDATES the name it is handed against `VIEW_NAME_RE` (a
// plain SQL identifier, ≤128 chars) and rejects everything else, so a raw id can
// never become SQL text by accident. A UUID contains `-`, so a caller must map
// it deliberately (e.g. `'ds_' + id.replace(/-/g, '_')`).
//
// ── Known limitation: a LEADING U+FEFF in a column NAME ──────────────────────
// `src/duckdb.ts` loses exactly one leading BOM from every string it returns
// (documented there; the loss is below the JS layer in `@duckdb/node-api`). The
// view is created with the faithful name and `viewColumns()` reports it
// faithfully, but `DESCRIBE` READ-BACK reports it WITHOUT the BOM — so a
// consumer that discovers names via `DESCRIBE` instead of `viewColumns()` would
// generate an identifier that does not bind. Nothing is mangled to paper over
// it: use `viewColumns()`. Pinned by a test so it stays visible.
// (`parquetStore.readTable` can apply the `bomSafe` doubling because it is a
// read-into-JS function. A VIEW is a stored SQL object — doubling a BOM there
// would corrupt the value for every in-SQL comparison, filter and GROUP BY, so
// view VALUES are passed through untouched and inherit the bridge's behaviour
// like any other query.)

import type { ColumnType, ParsedColumn } from './parse';
import { relationSql } from './parquetStore';
import * as duck from './duckdb';

// ── Public shapes ────────────────────────────────────────────────────────────

export interface ViewSpec {
  /** The view's identifier. Validated against `VIEW_NAME_RE`; never built here. */
  name: string;
  /** Absolute path to the dataset's `.parquet` file. */
  parquetPath: string;
  /**
   * The record's stored `ParsedColumn[]`, POSITIONALLY ALIGNED to the file —
   * the same contract `parquetStore.readTable(path, schema)` and
   * `residentQuery.ResidentSource` take.
   */
  columns: ParsedColumn[];
}

export interface ViewColumn {
  /** The identifier the view actually exposes (de-duplicated, never empty). */
  name: string;
  /** Ordinate's declared type — what drives the cast, and what DESCRIBE shows. */
  type: ColumnType;
  /** The positional physical column it reads: `c0..cN`. */
  physical: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** A plain SQL identifier, ≤128 chars. Deliberately narrower than DuckDB allows. */
const VIEW_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const COLUMN_TYPES: ReadonlySet<string> = new Set<ColumnType>(['text', 'number', 'date']);

// Mirrors `parquetStore`'s private EMPTY_MARK. A 0-column dataset still has a ROW
// COUNT, and a SELECT with an empty select list is a DuckDB parser error
// (06 §4 G7) — so the view projects one all-NULL sentinel column instead. It is
// NOT a user column and never appears in `viewColumns()`.
const EMPTY_MARK = '__empty';

// ── Public API ───────────────────────────────────────────────────────────────

/** True when `name` is safe to use as a view identifier. Never throws. */
export function isViewName(name: unknown): name is string {
  return typeof name === 'string' && VIEW_NAME_RE.test(name);
}

/**
 * The user-facing columns the view exposes, after de-duplication — the single
 * source of truth for the mapping described in the header. Pure, total, and a
 * function of the input list alone: same input, same output, every time.
 *
 * A malformed entry never throws: a non-`ParsedColumn` gets the positional
 * fallback name and type `text`.
 */
export function viewColumns(columns: ParsedColumn[]): ViewColumn[] {
  const list = Array.isArray(columns) ? columns : [];
  const taken = new Set<string>();
  const out: ViewColumn[] = [];

  for (let i = 0; i < list.length; i += 1) {
    const src = list[i] as Partial<ParsedColumn> | null | undefined;
    const base = baseName(src && src.name, i);
    let name = base;
    let n = 1;
    // First-wins: whoever reached this name earlier keeps it.
    while (taken.has(foldKey(name))) {
      name = `${base}_${n}`;
      n += 1;
    }
    taken.add(foldKey(name));
    const type = src && COLUMN_TYPES.has(src.type as string) ? (src.type as ColumnType) : 'text';
    out.push({ name, type, physical: `c${i}` });
  }
  return out;
}

/**
 * The `CREATE OR REPLACE VIEW … AS SELECT …;` statement that defines the view.
 *
 * PURE — builds a string, executes nothing, opens nothing, touches no disk. That
 * is what makes the cast rules testable without a database.
 *
 * THROWS (rather than returning null) on an unusable spec — an invalid view
 * name, a missing/rejected parquet path (`parquetStore.relationSql` validates
 * and escapes it; it is the only place a path becomes SQL). `ensureView`
 * converts that into `false`.
 */
export function viewSql(spec: ViewSpec): string {
  if (!spec || typeof spec !== 'object') {
    throw new TypeError('datasetView: spec must be an object');
  }
  if (!isViewName(spec.name)) {
    throw new TypeError(`datasetView: unsafe view name ${JSON.stringify(spec.name)}`);
  }
  const relation = relationSql(spec.parquetPath); // validates + escapes, or throws
  const cols = viewColumns(spec.columns);

  const select =
    cols.length === 0
      ? // Row count preserved, zero user columns, no empty select list.
        `CAST(NULL AS VARCHAR) AS ${quoteIdent(EMPTY_MARK)}`
      : cols.map((c) => `${projection(c)} AS ${quoteIdent(c.name)}`).join(', ');

  return `CREATE OR REPLACE VIEW ${quoteIdent(spec.name)} AS SELECT ${select} FROM ${relation};`;
}

/**
 * Create (or replace) the view on the shared DuckDB connection.
 *
 * Returns false — never throws — for an unusable spec, a missing/corrupt Parquet
 * file, a width mismatch between the spec and the file, or a dead bridge. DuckDB
 * binds a view at CREATE time, so a missing or non-Parquet file fails here
 * rather than at first query (measured: `IO Error: No files found…` /
 * `Invalid Input Error: … too small to be a Parquet file`).
 *
 * Idempotent by construction: `CREATE OR REPLACE` on the same spec is a no-op
 * with the same result.
 */
export function ensureView(spec: ViewSpec): boolean {
  try {
    const sql = viewSql(spec);
    if (!duck.isAvailable()) return false;
    duck.exec(sql);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drop the view. Returns false — never throws — for an unsafe name or a dead
 * bridge. `IF EXISTS`, so dropping a view that was never created succeeds:
 * the postcondition is "no view by that name", and that is idempotent.
 */
export function dropView(name: string): boolean {
  try {
    if (!isViewName(name)) return false;
    if (!duck.isAvailable()) return false;
    duck.exec(`DROP VIEW IF EXISTS ${quoteIdent(name)};`);
    return true;
  } catch {
    return false;
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * THE TYPE GATE. Only a DECLARED `number` is cast; `text` and `date` are passed
 * through as VARCHAR. See rule 1 in the header — this is the one line that keeps
 * `'007'` from becoming `7`.
 *
 * The outer `CAST(… AS VARCHAR)` on the text path is belt-and-braces: our own
 * files are all-VARCHAR by construction, so it is the identity there, but it
 * keeps the view well-typed over a Parquet file written by something else
 * instead of leaking a foreign physical type into `DESCRIBE`.
 */
function projection(c: ViewColumn): string {
  const p = c.physical;
  if (c.type !== 'number') return `CAST(${p} AS VARCHAR)`;
  return `CAST(CASE WHEN isfinite(TRY_CAST(${p} AS DOUBLE)) THEN TRY_CAST(${p} AS DOUBLE) END AS DOUBLE)`;
}

/** The whole escape: double an embedded `"`. Everything else is inert inside `"…"`. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * DuckDB's identifier equality folds ASCII ONLY — measured: `"a"`/`"A"` collide,
 * `"É"`/`"é"` and `"İ"`/`"i"` do not. `String.toLowerCase()` would map `İ` onto
 * `i` and invent a collision the engine does not have, so fold by hand.
 */
function foldKey(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
}

/**
 * The name before de-duplication. Replaces WHOLESALE (never partially rewrites)
 * the three names a view cannot carry: a non-string, `''`, and anything holding
 * a NUL byte. The fallback is 1-based to read as "the 3rd column", while
 * `physical` stays 0-based `c2` to match the file.
 */
function baseName(raw: unknown, i: number): string {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) return `column_${i + 1}`;
  return raw;
}
