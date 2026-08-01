// DuckDB worker thread — serves BOTH bridges in src/duckdb.ts from one
// connection. Runs in a worker_threads Worker; owns the only DuckDB connection.
// Never imports Electron and never touches the filesystem beyond the database
// path it is handed.
//
// TWO REPLY CHANNELS, chosen per message by whether it carries an `id`:
//
//   no `id`  → SYNCHRONOUS caller, parked in `Atomics.wait`. Reply by writing
//              the payload into the shared buffer and moving the control block.
//              `postMessage` is useless to it: the caller never reaches its
//              event loop, so a posted reply would sit in the port forever.
//   has `id` → ASYNCHRONOUS caller, waiting on a `message` event. Reply by
//              `postMessage({ id, … })` and DO NOT TOUCH THE CONTROL BLOCK OR
//              THE PAYLOAD BUFFER. That separation is what makes the two paths
//              safe to interleave: there is exactly one control block, so if an
//              async completion could write it, an async reply landing while a
//              sync caller is parked would forge that caller's signal.
//
// Control protocol (mirror of src/duckdb.ts), sync path only:
//   control: Int32Array(4) over a SharedArrayBuffer
//     [0] signal  0 = pending, 1 = ok, 2 = error, 3 = overflow
//     [1] payload byte length
//     [2] bytes required (only meaningful on overflow)
//     [3] worker-side elapsed microseconds (diagnostic)
//   payload: growable SharedArrayBuffer holding the UTF-8 JSON result
//
// The main thread is blocked in `Atomics.wait` while we serve a sync call, so
// EVERY exit path from `handleSync()` must end in exactly one `finish()` — a
// missed signal hangs the app until the caller's timeout fires. Messages are
// serialized through a promise queue (the single control block cannot serve two
// sync calls at once) and the queue is chained off the init handshake, so a
// message can never reach `handle()` before the connection exists.

import { parentPort, workerData } from 'worker_threads';
import type { DuckDBConnection, DuckDBResultReader } from '@duckdb/node-api';

type Scalar = string | number | null;

interface WorkerInit {
  control: SharedArrayBuffer;
  payload: SharedArrayBuffer;
  dbPath: string;
  /** Result ceiling. The async path has no shared buffer, so it needs this told. */
  maxBytes: number;
}

interface CallMessage {
  kind: 'query' | 'exec';
  sql: string;
  params: Scalar[];
  /** Present ⇒ reply by postMessage, never through the shared buffer. */
  id?: number;
}

/** Async reply. Mirrors `WorkerReply` in src/duckdb.ts — change both together. */
type AsyncReply =
  | { id: number; ok: true; text: string; micros: number }
  | { id: number; ok: false; code: 'query'; message: string; micros: number }
  | { id: number; ok: false; code: 'overflow'; need: number; micros: number };

// ES2024 growable SharedArrayBuffer — not in this project's ES2022 lib, so its
// shape is declared locally (see the same declaration in src/duckdb.ts).
interface GrowableSAB extends SharedArrayBuffer {
  readonly growable: boolean;
  readonly maxByteLength: number;
  grow(newLength: number): void;
}

const SIG = 0;
const LEN = 1;
const NEED = 2;
const MICROS = 3;

const OK = 1;
const ERROR = 2;
const OVERFLOW = 3;

const init = workerData as WorkerInit;
const ctl = new Int32Array(init.control);
const sab = init.payload as GrowableSAB;
let view = new Uint8Array(sab);
let connection: DuckDBConnection | null = null;

function finish(signal: number, bytes: number): void {
  Atomics.store(ctl, LEN, bytes);
  Atomics.store(ctl, SIG, signal);
  Atomics.notify(ctl, SIG);
}

/**
 * Async reply. `postMessage` is non-blocking on this side even when the main
 * thread is parked in `Atomics.wait` — the message lands in the port's queue and
 * is delivered whenever the main thread next reaches its event loop, which the
 * sync signal above is what eventually lets it do.
 */
function reply(msg: AsyncReply): void {
  if (parentPort) parentPort.postMessage(msg);
}

/**
 * Copy bytes into the shared payload buffer, growing it in place when needed.
 * A growable SharedArrayBuffer grows in place and the growth is visible on every
 * thread holding a reference, so nothing has to be re-posted. Returns false (and
 * signals OVERFLOW) when the result cannot fit under the ceiling — the bridge
 * stays usable for the next call.
 */
function writePayload(bytes: Buffer): boolean {
  if (bytes.length > sab.byteLength) {
    if (sab.growable && bytes.length <= sab.maxByteLength) {
      sab.grow(bytes.length);
      view = new Uint8Array(sab);
    } else {
      Atomics.store(ctl, NEED, bytes.length);
      finish(OVERFLOW, 0);
      return false;
    }
  }
  view.set(bytes);
  return true;
}

function fail(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const bytes = Buffer.from(message, 'utf8');
  if (bytes.length <= sab.byteLength) {
    view.set(bytes);
    finish(ERROR, bytes.length);
  } else {
    finish(ERROR, 0);
  }
}

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
const DECIMAL_TYPE_ID = 19;
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

function converterFor(typeId: number): Converter {
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
function encodeText(reader: DuckDBResultReader): string {
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

// ── Message loop ─────────────────────────────────────────────────────────────

function handle(msg: CallMessage): Promise<void> {
  return msg.id === undefined ? handleSync(msg) : handleAsync(msg, msg.id);
}

/** Reply through the control block. The caller is parked in `Atomics.wait`. */
async function handleSync(msg: CallMessage): Promise<void> {
  const t0 = process.hrtime.bigint();
  try {
    if (!connection) throw new Error('DuckDB connection is not open');
    if (msg.kind === 'exec') {
      // Bound parameters are a query-path concept; exec is app-generated DDL/DML.
      await connection.run(msg.sql);
      Atomics.store(ctl, MICROS, elapsedMicros(t0));
      finish(OK, 0);
      return;
    }
    // Values are BOUND here — never concatenated into the SQL text.
    const reader = await connection.runAndReadAll(msg.sql, msg.params as (string | number | null)[]);
    const bytes = Buffer.from(encodeText(reader), 'utf8');
    Atomics.store(ctl, MICROS, elapsedMicros(t0));
    if (writePayload(bytes)) finish(OK, bytes.length);
  } catch (err) {
    Atomics.store(ctl, MICROS, elapsedMicros(t0));
    fail(err);
  }
}

/**
 * Reply by `postMessage`. Touches NEITHER the control block nor the payload
 * buffer — see the header. The result ceiling is still applied (and reported as
 * the same `overflow` code) so the two paths agree on what "too big" means even
 * though only one of them has a buffer to overflow; `Buffer.byteLength` costs
 * ~1.3 ms on an 11 MB payload (~9 GB/s), i.e. nothing next to the query.
 */
async function handleAsync(msg: CallMessage, id: number): Promise<void> {
  const t0 = process.hrtime.bigint();
  try {
    if (!connection) throw new Error('DuckDB connection is not open');
    if (msg.kind === 'exec') {
      await connection.run(msg.sql);
      reply({ id, ok: true, text: '', micros: elapsedMicros(t0) });
      return;
    }
    const reader = await connection.runAndReadAll(msg.sql, msg.params as (string | number | null)[]);
    const text = encodeText(reader);
    const need = Buffer.byteLength(text, 'utf8');
    const micros = elapsedMicros(t0);
    if (need > init.maxBytes) reply({ id, ok: false, code: 'overflow', need, micros });
    else reply({ id, ok: true, text, micros });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply({ id, ok: false, code: 'query', message, micros: elapsedMicros(t0) });
  }
}

function elapsedMicros(t0: bigint): number {
  return Number((process.hrtime.bigint() - t0) / 1000n);
}

// Ready handshake. A failure here (native module missing, unreadable database)
// must still SIGNAL — a blocked main thread would otherwise wait for its
// timeout — and must ALSO post, because an async first-caller is watching the
// message channel rather than the control block.
const ready = (async () => {
  // Required lazily so that a load failure lands in this catch rather than
  // killing the worker before any handler exists.
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(init.dbPath);
  connection = await instance.connect();
  await connection.run('SELECT 1'); // warm the engine before reporting ready
  finish(OK, 0);
  if (parentPort) parentPort.postMessage({ type: 'ready' });
})().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  fail(new Error('DuckDB init failed: ' + message));
  if (parentPort) parentPort.postMessage({ type: 'init-error', message });
});

// Serialize calls: concurrent sync postMessages would race on the single control
// block, and DuckDB's own connection is not re-entrant either. The chain starts
// at `ready`, so no message can be handled before the connection exists — an
// async caller is admitted the moment `ready` resolves, with no blocking
// handshake to wait on. A rejected `handle()` must not poison the chain: every
// exit path already replies, and the `catch` here only keeps the queue alive.
let queue: Promise<void> = ready;
if (parentPort) {
  parentPort.on('message', (msg: CallMessage | { kind: 'close' }) => {
    queue = queue.then(() => (msg.kind === 'close' ? closeNow() : handle(msg as CallMessage))).catch(() => undefined);
  });
}

/**
 * Voluntary shutdown, requested by src/duckdb.ts instead of `Worker.terminate()`
 * when a call may still be running. It arrives through the SAME serialized
 * queue, so by the time it executes every queued call has settled and no native
 * DuckDB call is outstanding — which is exactly the condition `terminate()`
 * cannot guarantee, and violating it aborts the whole process. See the note on
 * `closeWorker` in src/duckdb.ts for the reproduction.
 */
async function closeNow(): Promise<void> {
  connection = null;
  process.exit(0); // exits this worker thread, not the app
}
