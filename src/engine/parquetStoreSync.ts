// parquetStoreSync — the SYNCHRONOUS Parquet read/write, for tests, benches and
// fixtures ONLY. The same files byte for byte as parquetStore's `…Async` twins
// (one encoding, its helpers imported from ./parquetStore), but every query here
// parks the calling thread on the sync bridge, which freezes a server.
//
// NOTHING UNDER src/ IMPORTS THIS FILE. scripts/test-asyncReach.ts walks the
// require graph from every RPC handler and fails if it ever becomes reachable.

import * as fs from 'fs';
import { randomUUID } from 'crypto';
import type { ParsedColumn } from '../data/parse';
import type { Cell } from '../data/transforms';
import * as duck from './duckdb';
import {
  COMPRESSION, EMPTY_MARK, assertPath, bomSafe, decodeTable, emptySourceSql, emptyTypedSql, isMalformedJson,
  isSupported, ndjsonLine, physicalNames, readJsonSql, relationSql, sqlStr, unlinkQuiet,
} from './parquetStore';
import type { ParquetTable } from './parquetStore';

// Rows per write to the temp NDJSON file. Bounds peak string memory instead of
// materialising the whole serialised table at once.
const CHUNK_ROWS = 4096;

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
    throw new TypeError('parquetStoreSync.writeTable: columns and rows must be arrays');
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
    return decodeTable(physical, out, schema);
  } catch {
    // Missing file, truncated file, non-Parquet bytes, dead bridge — all the
    // same answer: this record has no readable table.
    return null;
  }
}

function jsonSourceSql(tmpJson: string, width: number, rows: Cell[][]): string {
  const names = physicalNames(width);
  const select = names.map((n) => `"${n}"`).join(', ');
  if (rows.length === 0) return emptyTypedSql(width);

  writeNdjson(tmpJson, names, rows, false);
  const read = readJsonSql(tmpJson, names);
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

// Chunked so a large table never needs its whole serialised form in memory.
function writeNdjson(file: string, names: string[], rows: Cell[][], sanitize: boolean): void {
  const fd = fs.openSync(file, 'w');
  try {
    let buf = '';
    let pending = 0;
    for (let r = 0; r < rows.length; r++) {
      buf += ndjsonLine(names, rows[r] || [], sanitize);
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
