// ── Shared DuckDB engine ─────────────────────────────────────────────────────
//
// The parts of the engine that are NOT transport: the DuckDB→JS type mapping,
// the result encoder, and opening a connection. Extracted from
// src/duckdbWorker.ts so the worker bridge and the stdio sidecar share ONE
// definition — a second copy of the converter table would drift silently, and
// the type mapping is the part callers actually depend on.
//
// Pure: no worker_threads, no child_process, no SharedArrayBuffer, no Electron.

import type { DuckDBConnection, DuckDBResultReader } from '@duckdb/node-api';

export type Scalar = string | number | null;
// ── Payload encode ───────────────────────────────────────────────────────────
// Pairs with `decodeRows` in src/duckdb.ts. `@duckdb/node-api` has no Arrow
// support today (every Arrow binding in its .d.ts is commented out), so this is
// columnar JSON: {columns, rows}. It is the ONLY place result values are shaped
// — swap this function and its decoder together to move to Arrow later.

/**
 * DuckDB's JSON converter already yields JSON-safe values with the right
 * precision (BIGINT/HUGEINT → decimal string, DATE/TIMESTAMP → text), so it does
 * the heavy lifting. Only three cases need fixing up, chosen per COLUMN (never
 * per value, so a column's JS type never varies with the magnitude of a row):
 *   DECIMAL  → number  (JSON gives a string; charts/metrics need a number)
 *   BOOLEAN  → 'true'/'false' (the workspace has no boolean cell type)
 *   objects  → JSON text (INTERVAL, LIST, STRUCT, MAP, …)
 */
export const DECIMAL_TYPE_ID = 19;
const BOOLEAN_TYPE_ID = 1;
// Ids whose JSON form is already string | number | null, verbatim.
const PASSTHROUGH_TYPE_IDS = new Set<number>([
  2, 3, 4, 6, 7, 8, // TINYINT SMALLINT INTEGER UTINYINT USMALLINT UINTEGER
  10, 11, // FLOAT DOUBLE
  5, 9, 16, 32, 35, // BIGINT UBIGINT HUGEINT UHUGEINT BIGNUM → decimal strings
  12, 13, 14, 20, 21, 22, 30, 31, // TIMESTAMP DATE TIME TIMESTAMP_S/_MS/_NS TIME_TZ TIMESTAMP_TZ
  17, 18, 23, 27, 29, 36, 37, 38, 39, // VARCHAR BLOB ENUM UUID BIT SQLNULL literals TIME_NS
]);

type Converter = (v: unknown) => Scalar;

const passthrough: Converter = (v) =>
  typeof v === 'string' || typeof v === 'number' ? v : v === null || v === undefined ? null : String(v);
const toNumber: Converter = (v) => (v === null || v === undefined ? null : Number(v));
const toBool: Converter = (v) => (v === null || v === undefined ? null : v ? 'true' : 'false');
const toJson: Converter = (v) =>
  v === null || v === undefined ? null : typeof v === 'string' || typeof v === 'number' ? v : JSON.stringify(v);

export function converterFor(typeId: number): Converter {
  if (PASSTHROUGH_TYPE_IDS.has(typeId)) return passthrough;
  if (typeId === DECIMAL_TYPE_ID) return toNumber;
  if (typeId === BOOLEAN_TYPE_ID) return toBool;
  return toJson; // INTERVAL, LIST, STRUCT, MAP, UNION, ARRAY, GEOMETRY, VARIANT, unknown
}

/**
 * Shape a result into the wire JSON. Both transports carry these exact bytes —
 * the sync path memcpys them into the shared buffer, the async path posts the
 * string — so a result cannot differ between the two paths by construction.
 * (Why a string and not a transferred ArrayBuffer on the async path: measured,
 * see the transport note in src/duckdb.ts.)
 */
export function encodeText(reader: DuckDBResultReader): string {
  const columns = reader.deduplicatedColumnNames();
  const converters = reader.columnTypes().map((t) => converterFor(t.typeId));
  // getRowsJson(): row-major, already JSON-safe, BIGINT/HUGEINT as exact strings.
  const raw = reader.getRowsJson();
  const rows: Scalar[][] = new Array(raw.length);
  for (let r = 0; r < raw.length; r++) {
    const src = raw[r];
    const out: Scalar[] = new Array(columns.length);
    for (let c = 0; c < columns.length; c++) out[c] = converters[c](src[c]);
    rows[r] = out;
  }
  return JSON.stringify({ columns, rows });
}


/**
 * Open a DuckDB connection and warm it. The `import()` is lazy and deliberate:
 * a missing or unloadable native module must land in the caller's catch, not
 * take the host process down before any error handler exists.
 */
export async function openConnection(dbPath: string): Promise<DuckDBConnection> {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  await connection.run('SELECT 1'); // warm the engine before reporting ready
  return connection;
}
