'use strict';

// parquetStore — Parquet is where a dataset's TABLE DATA lives (Phase 2).
//
// One dataset = one `<id>.parquet` file. The record's JSON keeps everything that
// is *metadata* (column names, Ordinate `ColumnType`s, steps, sourceKind); this
// module only moves cells to and from disk, losslessly.
//
// ── The three decisions ─────────────────────────────────────────────────────
//
// 1. EVERY COLUMN IS STORED AS VARCHAR. The Parquet physical type is NOT
//    Ordinate's `ColumnType`. docs/phase-0/06-duckdb-verification.md §2 measured
//    that a leading-zero value past the sniffer's 20,480-row sample window
//    silently becomes an integer (`007` → `7`); the same class of bug loses a
//    zip code's zero and a >15-digit id's low digits. Storing `String(cell)`
//    with NULL preserved is the one choice that cannot corrupt a value, and it
//    is exactly the contract `sqlGen.ts` and `pipelineDuck.ts` already assume.
//    `null` and `''` stay distinguishable, which `transforms.isEmptyCell`
//    depends on.
//
// 2. PHYSICAL COLUMN NAMES ARE POSITIONAL — `c0..cN`, same as `sqlGen.ts`.
//    A CSV header is user data: it can be `''`, a duplicate, `Name "X"`, or
//    contain a newline. Rather than try to round-trip that through a Parquet
//    schema (and through SQL identifier quoting on every later query), the file
//    carries no user-facing name at all. `readTable` therefore returns
//    `c0..cN` / type `'text'`, POSITIONALLY ALIGNED to the caller's stored
//    `ParsedColumn[]`, and the caller re-labels. Pass your stored columns as the
//    second argument and `readTable` does the re-labelling *and* the type
//    inverse for you (see 3) — that is the intended integration.
//    THE JSON RECORD IS THE ONLY SOURCE OF TRUTH FOR NAMES AND TYPES. Nothing
//    is duplicated into the Parquet file, so a rename (`datasets.updateDataset`)
//    stays a pure metadata edit and can never drift out of sync with the cells.
//
// 3. READ-BACK IS THE INVERSE OF `String(cell)`, NOT A RE-PARSE. Reusing
//    `parse.coerceValue` here would be wrong and was a real Phase 1 bug: it maps
//    `'' → null` (parse.ts:219), which is an *ingest* rule. Storage already
//    holds exactly `String(cell)`, so the inverse is: null → null; text/date →
//    the string verbatim (`''` and whitespace included); number → `Number(s)`.
//    Identical to `pipelineDuck.toCell` — the two must stay in lockstep.
//
// Everything runs through the existing synchronous bridge in `src/duckdb.ts`.
// No second DuckDB connection, no new dependency.
//
// ── Why a temp NDJSON file instead of INSERT ────────────────────────────────
// Loading 100k rows with bound-parameter INSERTs costs ~1,650 ms — the per-row
// bridge crossing, not the engine (see the note at the top of pipelineDuck.ts).
// Serialising the same rows to newline-delimited JSON and letting DuckDB read
// that file costs ~65 ms, a 25x win, and JSON is the one text format that keeps
// `null` and `''` distinct with no quoting convention to get wrong.

import * as fs from 'fs';
import { randomUUID } from 'crypto';
import type { ParsedColumn } from './parse';
import type { Cell } from './transforms';
import * as duck from './duckdb';

export interface ParquetTable {
  columns: ParsedColumn[];
  rows: Cell[][];
}

// The single physical column written for a 0-column table, so its ROW COUNT
// survives (a pipeline can drop every column and still have 40 rows). Parquet
// has no concept of a zero-column relation and DuckDB rejects the projection
// (06 §4 G7), so this sentinel is the encoding. It cannot collide: real columns
// are always `c<digits>`.
const EMPTY_MARK = '__empty';

// ZSTD over the SNAPPY default: measured ~20% smaller on real column data for no
// meaningful read cost, and this phase is partly about on-disk size.
const COMPRESSION = 'ZSTD';

// Rows per write to the temp NDJSON file. Bounds peak string memory instead of
// materialising the whole serialised table at once.
const CHUNK_ROWS = 4096;

// ── Public API ───────────────────────────────────────────────────────────────

/** True when the DuckDB bridge is up. Never throws. Starts the worker on first call. */
export function isSupported(): boolean {
  try {
    return duck.isAvailable();
  } catch {
    return false;
  }
}

/**
 * A `read_parquet(...)` expression usable directly as a FROM target, e.g.
 * `SELECT "c0" FROM ${relationSql(p)}`. The returned relation's columns are the
 * physical `c0..cN` (or `__empty`).
 *
 * Throws on an invalid path — a caller must not be able to smuggle a broken or
 * hostile path into generated SQL. The path is a single-quoted DuckDB string
 * literal with `'` doubled; backslash is not an escape character in DuckDB
 * string literals, so nothing else needs escaping.
 */
export function relationSql(
  filePath: string,
  opts: { fileRowNumber?: boolean } = {},
): string {
  assertPath(filePath);
  // `file_row_number` exposes the 0-based position of each row IN THE FILE.
  // The prepare pipeline needs it because a bare GROUP BY does not preserve
  // first-seen order and whether it reorders is machine-dependent, so every
  // generated ORDER BY ends on that ordinal. Off by default: it is an extra
  // column, and readers that only want cells should not pay for it.
  const args = opts.fileRowNumber ? ', file_row_number=true' : '';
  return `read_parquet('${filePath.replace(/'/g, "''")}'${args})`;
}

/**
 * Write `rows` to `filePath` as Parquet, atomically.
 *
 * Only the CELLS are written; `columns` is used for its LENGTH and nothing else
 * (each row is padded/truncated to it, so a ragged caller cannot desynchronise
 * the file from the record). Names and types stay in the caller's JSON.
 *
 * Atomic: DuckDB writes a temp sibling, then `rename` publishes it — a reader
 * never observes a partial `.parquet`, matching `datasets.writeJsonAtomic`.
 *
 * Throws if the bridge is unavailable or the write fails; a failed save must be
 * visible to the caller, unlike a failed read.
 */
export function writeTable(filePath: string, columns: ParsedColumn[], rows: Cell[][]): void {
  assertPath(filePath);
  if (!Array.isArray(columns) || !Array.isArray(rows)) {
    throw new TypeError('parquetStore.writeTable: columns and rows must be arrays');
  }
  if (!isSupported()) {
    throw new duck.DuckDBError('unavailable', 'parquetStore: DuckDB is not available');
  }

  const stem = `${filePath}.${randomUUID()}`;
  const tmpParquet = `${stem}.tmp`; // NOT *.parquet — a stray temp must never be globbed as data
  const tmpJson = `${stem}.ndjson.tmp`;

  try {
    const source = columns.length === 0 ? emptySourceSql(rows.length) : jsonSourceSql(tmpJson, columns.length, rows);
    duck.exec(`COPY (${source}) TO '${sqlStr(tmpParquet)}' (FORMAT PARQUET, COMPRESSION ${COMPRESSION});`);
    fs.renameSync(tmpParquet, filePath); // atomic on the same filesystem
  } catch (err) {
    unlinkQuiet(tmpParquet);
    throw err;
  } finally {
    unlinkQuiet(tmpJson);
  }
}

/**
 * Read a Parquet file back. Returns `null` — never throws — when the file is
 * missing, truncated, not Parquet, or when the bridge is unavailable, so a
 * corrupt record is SKIPPED rather than fatal (`datasets.listDatasets`
 * convention). Use `isSupported()` to tell "no DuckDB" from "bad file".
 *
 * Without `schema`, the result is the raw storage view: columns named `c0..cN`,
 * all typed `'text'`, every cell a string or null. Pass the record's stored
 * `ParsedColumn[]` as `schema` and the result is re-labelled and re-typed
 * through the inverse of `String(cell)` — that is the exact `Cell[][]` that went
 * in. `schema` only ever renames/retypes positionally; it can never change the
 * column COUNT the file actually holds.
 */
export function readTable(filePath: string, schema?: ParsedColumn[]): ParquetTable | null {
  try {
    assertPath(filePath);
    if (!isSupported()) return null;

    const relation = relationSql(filePath);
    const described = duck.query(`DESCRIBE SELECT * FROM ${relation};`);
    const physical = described.map((r) => String(r.column_name ?? ''));

    // 0-column table: the sentinel carries only the row count.
    if (physical.length === 1 && physical[0] === EMPTY_MARK) {
      const n = Number(duck.query(`SELECT count(*) AS n FROM ${relation};`)[0]?.n ?? 0);
      const rows: Cell[][] = [];
      for (let i = 0; i < n; i++) rows.push([]);
      return { columns: [], rows };
    }

    const projection = physical.map((p) => bomSafe(`"${p.replace(/"/g, '""')}"`)).join(', ');
    const out = duck.query(`SELECT ${projection} FROM ${relation};`);

    const width = physical.length;
    const columns: ParsedColumn[] = physical.map((name, i) => ({
      name: schema?.[i]?.name ?? name,
      type: schema?.[i]?.type ?? 'text',
    }));
    const rows: Cell[][] = out.map((row) => {
      const cells: Cell[] = new Array(width);
      for (let c = 0; c < width; c++) cells[c] = toCell(row[physical[c]] ?? null, columns[c].type);
      return cells;
    });
    return { columns, rows };
  } catch {
    // Missing file, truncated file, non-Parquet bytes, dead bridge — all the
    // same answer: this record has no readable table.
    return null;
  }
}

// ── Storage contract (must mirror pipelineDuck.toStorage / toCell) ───────────

function toStorage(cell: Cell): string | null {
  return cell == null ? null : String(cell);
}

function toCell(raw: string | number | null, type: ParsedColumn['type']): Cell {
  if (raw == null) return null;
  if (type !== 'number') return typeof raw === 'string' ? raw : String(raw);
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ── SQL sources for COPY ─────────────────────────────────────────────────────

function physicalName(i: number): string {
  return `c${i}`;
}

// ── The leading-BOM workaround ───────────────────────────────────────────────
//
// `src/duckdb.ts` loses exactly ONE leading U+FEFF from every returned string:
// the worker builds its payload from `@duckdb/node-api`'s `getRowsJson()`, which
// eats a BOM at the start of a value. Measured: `SELECT chr(65279) || 'x'` has
// `length() = 2` inside DuckDB but arrives as `'x'`; a BOM anywhere other than
// position 0 is untouched, and a doubled leading BOM arrives as a single one.
//
// The Parquet file itself is FAITHFUL — this is a transport bug, so it also hits
// the Phase 1 `pipelineDuck` path and belongs upstream in duckdb.ts. Until it is
// fixed there, doubling a leading BOM in the projection is an EXACT inverse:
// values that do not start with one are untouched, so there is no sentinel to
// collide with. `starts_with(NULL, …)` is NULL, so NULLs take the ELSE branch and
// stay NULL. Measured cost on 100k x 7: none (within run-to-run noise).
//
// The CAST is belt-and-braces: our own files are all VARCHAR by construction,
// but it keeps `readTable` working (as text) on a Parquet file written by
// something else, instead of failing the whole read on a typed column.
const BOM = 'chr(65279)';
function bomSafe(quotedName: string): string {
  const v = `CAST(${quotedName} AS VARCHAR)`;
  return `CASE WHEN starts_with(${v}, ${BOM}) THEN ${BOM} || ${v} ELSE ${v} END AS ${quotedName}`;
}

// A 0-column table: N rows of a single all-NULL sentinel column.
function emptySourceSql(rowCount: number): string {
  const n = Math.max(0, Math.floor(Number(rowCount) || 0));
  return n === 0
    ? `SELECT CAST(NULL AS VARCHAR) AS "${EMPTY_MARK}" WHERE 1=0`
    : `SELECT CAST(NULL AS VARCHAR) AS "${EMPTY_MARK}" FROM range(${n})`;
}

// Serialise the rows to a temp NDJSON sibling and hand DuckDB an explicit
// all-VARCHAR schema. `columns=` is given, so no sniffing happens and a `007`
// can never be re-typed on the way in.
function jsonSourceSql(tmpJson: string, width: number, rows: Cell[][]): string {
  const names: string[] = [];
  for (let i = 0; i < width; i++) names.push(physicalName(i));
  const spec = names.map((n) => `'${n}':'VARCHAR'`).join(', ');
  const select = names.map((n) => `"${n}"`).join(', ');

  if (rows.length === 0) {
    // read_json cannot read a zero-byte file; project the schema instead.
    const nulls = names.map((n) => `CAST(NULL AS VARCHAR) AS "${n}"`).join(', ');
    return `SELECT ${nulls} WHERE 1=0`;
  }

  writeNdjson(tmpJson, names, rows, false);
  const read = `read_json('${sqlStr(tmpJson)}', format='newline_delimited', columns={${spec}})`;
  try {
    // Force the parse now (rather than inside the COPY) so a JSON-level failure
    // can be retried on a sanitised file — see wellFormed().
    duck.query(`SELECT 1 FROM ${read} LIMIT 1;`);
  } catch (err) {
    if (!isMalformedJson(err)) throw err;
    // The only value class JSON cannot carry is an unpaired UTF-16 surrogate.
    // Rewriting those as U+FFFD is lossy but total; failing the save is worse,
    // and the input can only have come from a source that was already broken.
    writeNdjson(tmpJson, names, rows, true);
    duck.query(`SELECT 1 FROM ${read} LIMIT 1;`);
  }
  return `SELECT ${select} FROM ${read}`;
}

function isMalformedJson(err: unknown): boolean {
  return err instanceof Error && /Malformed JSON|surrogate/i.test(err.message);
}

// Chunked so a large table never needs its whole serialised form in memory.
function writeNdjson(file: string, names: string[], rows: Cell[][], sanitize: boolean): void {
  const width = names.length;
  const fd = fs.openSync(file, 'w');
  try {
    let buf = '';
    let pending = 0;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || [];
      const obj: Record<string, string | null> = {};
      for (let c = 0; c < width; c++) {
        const v = toStorage(row[c] ?? null);
        obj[names[c]] = v !== null && sanitize ? wellFormed(v) : v;
      }
      buf += JSON.stringify(obj) + '\n';
      if (++pending >= CHUNK_ROWS) {
        fs.writeSync(fd, buf, null, 'utf8');
        buf = '';
        pending = 0;
      }
    }
    if (buf) fs.writeSync(fd, buf, null, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// String.prototype.toWellFormed is ES2024 (Node 20+/Electron 42); the manual
// replacement keeps this working if the lib target ever lags the runtime.
function wellFormed(s: string): string {
  const anyStr = s as unknown as { toWellFormed?: () => string };
  if (typeof anyStr.toWellFormed === 'function') return anyStr.toWellFormed();
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

// ── Path handling ────────────────────────────────────────────────────────────

// Paths are BUILT BY THE CALLER (datasets.ts owns id→path, with its UUID guard).
// This is a defensive last line: reject anything that could not be one of ours.
function assertPath(filePath: unknown): asserts filePath is string {
  if (typeof filePath !== 'string' || filePath === '') {
    throw new TypeError('parquetStore: path must be a non-empty string');
  }
  if (filePath.includes('\0')) {
    throw new TypeError('parquetStore: path must not contain a null byte');
  }
  if (!filePath.toLowerCase().endsWith('.parquet')) {
    throw new TypeError('parquetStore: path must end in .parquet');
  }
}

function sqlStr(s: string): string {
  return s.replace(/'/g, "''");
}

function unlinkQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone, or never created */
  }
}
