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
// Everything runs through the one bridge in `src/engine/duckdb.ts` — no second
// DuckDB connection, no new dependency. Every read and write here is on the
// ASYNC bridge (the loop keeps turning). The synchronous `readTable`/`writeTable`
// live in ./parquetStoreSync.ts — tests, benches and fixtures only; nothing a
// request reaches may import it (scripts/test-asyncReach.ts). The helpers marked
// `export` below the public API are shared with it, not public API.
//
// ── Why a temp NDJSON file instead of INSERT ────────────────────────────────
// Loading 100k rows with bound-parameter INSERTs costs ~1,650 ms — the per-row
// bridge crossing, not the engine (see the note at the top of pipelineDuck.ts).
// Serialising the same rows to newline-delimited JSON and letting DuckDB read
// that file costs ~65 ms, a 25x win, and JSON is the one text format that keeps
// `null` and `''` distinct with no quoting convention to get wrong.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { ParsedColumn } from '../data/parse';
import type { Cell } from '../data/transforms';
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
export const EMPTY_MARK = '__empty';

// ZSTD over the SNAPPY default: measured ~20% smaller on real column data for no
// meaningful read cost, and this phase is partly about on-disk size.
export const COMPRESSION = 'ZSTD';

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

/** Progress (0–1) and a cancel check a background job hands in; both optional. */
export interface WriteProgress {
  onProgress?: (fraction: number, note?: string) => void;
  checkCancelled?: () => void;
  /** For an s3:// target: a LOCAL directory the org's worker may read, for the NDJSON staging file. */
  stageDir?: string;
}

/** True when the bridge is up, WITHOUT blocking the event loop to start it. */
export async function isSupportedAsync(): Promise<boolean> {
  try {
    await duck.queryAsync('SELECT 1 AS ok;');
    return true;
  } catch {
    return false;
  }
}

/**
 * `writeTable` for a background job: the same file, byte for byte, but the
 * NDJSON is written in awaited chunks (the event loop turns between them, and
 * progress/cancel are checked there) and DuckDB's COPY runs on the ASYNC
 * bridge, so a 1M-row save never parks the main thread. `onProgress` covers
 * serialising (0–0.8) and the COPY (0.8–1); a cancel leaves no file behind.
 */
export async function writeTableAsync(
  filePath: string,
  columns: ParsedColumn[],
  rows: Cell[][],
  opts: WriteProgress = {},
): Promise<void> {
  assertPath(filePath);
  if (!Array.isArray(columns) || !Array.isArray(rows)) {
    throw new TypeError('parquetStore.writeTableAsync: columns and rows must be arrays');
  }
  if (!(await isSupportedAsync())) {
    throw new duck.DuckDBError('unavailable', 'parquetStore: DuckDB is not available');
  }
  // An s3:// target (src/engine/storage.ts) is COPYed to directly — the object
  // appears only when its upload completes, so there is no temp to rename — and
  // the NDJSON staging file goes to `opts.stageDir` (the org's temp) instead.
  const remote = filePath.startsWith('s3://');
  if (remote && !opts.stageDir) throw new TypeError('parquetStore.writeTableAsync: an s3:// target needs opts.stageDir');
  const stem = remote ? path.join(opts.stageDir!, randomUUID()) : `${filePath}.${randomUUID()}`;
  const tmpParquet = remote ? filePath : `${stem}.tmp`;
  const tmpJson = `${stem}.ndjson.tmp`;
  try {
    let source: string;
    if (columns.length === 0) {
      source = emptySourceSql(rows.length);
    } else if (rows.length === 0) {
      source = emptyTypedSql(columns.length);
    } else {
      const names = physicalNames(columns.length);
      await writeNdjsonAsync(tmpJson, names, rows, false, opts);
      const read = readJsonSql(tmpJson, names);
      try {
        await duck.queryAsync(`SELECT 1 FROM ${read} LIMIT 1;`);
      } catch (err) {
        if (!isMalformedJson(err)) throw err;
        await writeNdjsonAsync(tmpJson, names, rows, true, opts);
        await duck.queryAsync(`SELECT 1 FROM ${read} LIMIT 1;`);
      }
      source = `SELECT ${names.map((n) => `"${n}"`).join(', ')} FROM ${read}`;
    }
    if (opts.checkCancelled) opts.checkCancelled();
    if (opts.onProgress) opts.onProgress(0.8, 'Writing Parquet');
    await duck.execAsync(`COPY (${source}) TO '${sqlStr(tmpParquet)}' (FORMAT PARQUET, COMPRESSION ${COMPRESSION});`);
    if (!remote) await fs.promises.rename(tmpParquet, filePath);
    if (opts.onProgress) opts.onProgress(1);
  } catch (err) {
    if (!remote) unlinkQuiet(tmpParquet);
    throw err;
  } finally {
    unlinkQuiet(tmpJson);
  }
}

/**
 * `readTable` on the ASYNC bridge: DuckDB scans in its worker while the main
 * thread keeps turning, then the rows are decoded here exactly as `readTable`
 * decodes them. Same null-on-any-failure contract.
 */
export async function readTableAsync(filePath: string, schema?: ParsedColumn[]): Promise<ParquetTable | null> {
  try {
    assertPath(filePath);
    const relation = relationSql(filePath);
    const described = await duck.queryAsync(`DESCRIBE SELECT * FROM ${relation};`);
    const physical = described.map((r) => String(r.column_name ?? ''));
    if (physical.length === 1 && physical[0] === EMPTY_MARK) {
      const n = Number((await duck.queryAsync(`SELECT count(*) AS n FROM ${relation};`))[0]?.n ?? 0);
      const rows: Cell[][] = [];
      for (let i = 0; i < n; i++) rows.push([]);
      return { columns: [], rows };
    }
    const projection = physical.map((p) => bomSafe(`"${p.replace(/"/g, '""')}"`)).join(', ');
    const out = await duck.queryAsync(`SELECT ${projection} FROM ${relation};`);
    return decodeTable(physical, out, schema);
  } catch {
    return null;
  }
}

export function decodeTable(physical: string[], out: Record<string, unknown>[], schema?: ParsedColumn[]): ParquetTable {
  const width = physical.length;
  const columns: ParsedColumn[] = physical.map((name, i) => ({
    name: schema?.[i]?.name ?? name,
    type: schema?.[i]?.type ?? 'text',
  }));
  const rows: Cell[][] = out.map((row) => {
    const cells: Cell[] = new Array(width);
    for (let c = 0; c < width; c++) cells[c] = toCell((row[physical[c]] ?? null) as string | number | null, columns[c].type);
    return cells;
  });
  return { columns, rows };
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
export function bomSafe(quotedName: string): string {
  const v = `CAST(${quotedName} AS VARCHAR)`;
  return `CASE WHEN starts_with(${v}, ${BOM}) THEN ${BOM} || ${v} ELSE ${v} END AS ${quotedName}`;
}

// A 0-column table: N rows of a single all-NULL sentinel column.
export function emptySourceSql(rowCount: number): string {
  const n = Math.max(0, Math.floor(Number(rowCount) || 0));
  return n === 0
    ? `SELECT CAST(NULL AS VARCHAR) AS "${EMPTY_MARK}" WHERE 1=0`
    : `SELECT CAST(NULL AS VARCHAR) AS "${EMPTY_MARK}" FROM range(${n})`;
}

// Serialise the rows to a temp NDJSON sibling and hand DuckDB an explicit
// all-VARCHAR schema. `columns=` is given, so no sniffing happens and a `007`
// can never be re-typed on the way in.
export function physicalNames(width: number): string[] {
  const names: string[] = [];
  for (let i = 0; i < width; i++) names.push(physicalName(i));
  return names;
}

// read_json cannot read a zero-byte file; a 0-row table projects the schema.
export function emptyTypedSql(width: number): string {
  const nulls = physicalNames(width).map((n) => `CAST(NULL AS VARCHAR) AS "${n}"`).join(', ');
  return `SELECT ${nulls} WHERE 1=0`;
}

export function readJsonSql(tmpJson: string, names: string[]): string {
  const spec = names.map((n) => `'${n}':'VARCHAR'`).join(', ');
  return `read_json('${sqlStr(tmpJson)}', format='newline_delimited', columns={${spec}})`;
}

export function isMalformedJson(err: unknown): boolean {
  return err instanceof Error && /Malformed JSON|surrogate/i.test(err.message);
}

/** One NDJSON line per row — the storage encoding both writers share. */
export function ndjsonLine(names: string[], row: Cell[], sanitize: boolean): string {
  const obj: Record<string, string | null> = {};
  for (let c = 0; c < names.length; c++) {
    const v = toStorage(row[c] ?? null);
    obj[names[c]] = v !== null && sanitize ? wellFormed(v) : v;
  }
  return JSON.stringify(obj) + '\n';
}

// Rows per awaited chunk in the async writer: big enough that the awaits are
// noise (~2 ms of serialising each), small enough that the UI never notices.
const ASYNC_CHUNK_ROWS = 16_384;

async function writeNdjsonAsync(
  file: string,
  names: string[],
  rows: Cell[][],
  sanitize: boolean,
  opts: WriteProgress,
): Promise<void> {
  const fh = await fs.promises.open(file, 'w');
  try {
    for (let start = 0; start < rows.length; start += ASYNC_CHUNK_ROWS) {
      if (opts.checkCancelled) opts.checkCancelled();
      const end = Math.min(rows.length, start + ASYNC_CHUNK_ROWS);
      let buf = '';
      for (let r = start; r < end; r++) buf += ndjsonLine(names, rows[r] || [], sanitize);
      await fh.write(buf, null, 'utf8');
      if (opts.onProgress) {
        opts.onProgress(0.8 * (end / rows.length), `${end.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')} rows`);
      }
    }
  } finally {
    await fh.close();
  }
}

// String.prototype.toWellFormed is ES2024 (Node 20+); the manual
// replacement keeps this working if the lib target ever lags the runtime.
function wellFormed(s: string): string {
  const anyStr = s as unknown as { toWellFormed?: () => string };
  if (typeof anyStr.toWellFormed === 'function') return anyStr.toWellFormed();
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

// ── Path handling ────────────────────────────────────────────────────────────

// Paths are BUILT BY THE CALLER (datasets.ts owns id→path, with its UUID guard).
// This is a defensive last line: reject anything that could not be one of ours.
export function assertPath(filePath: unknown): asserts filePath is string {
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

export function sqlStr(s: string): string {
  return s.replace(/'/g, "''");
}

export function unlinkQuiet(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone, or never created */
  }
}
