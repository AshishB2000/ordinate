// DuckDB synchronous query bridge — MAIN PROCESS ONLY.
//
// `@duckdb/node-api` is async-only (every call returns a Promise), but the code
// that will consume it (transforms, metrics, viz data) is synchronous today.
// This module gives the main process a genuinely SYNCHRONOUS `query()` by
// parking DuckDB in a worker thread and blocking on `Atomics.wait`:
//
//   main thread                          worker thread
//   ───────────                          ─────────────
//   ctl[0] = PENDING
//   worker.postMessage({sql, params}) ─▶ runAndReadAll(sql, params)
//   Atomics.wait(ctl, 0, PENDING)        encode payload → SharedArrayBuffer
//        ⟵ unblocks ⟵                    ctl[0] = OK; Atomics.notify(ctl, 0)
//   read bytes out of the SAB, parse
//
// ⚠ KNOWN LIMITATION — a leading U+FEFF (BOM) is LOST on every returned string.
//   `SELECT chr(65279) || 'x'` has length 2 inside DuckDB and arrives here as
//   'x'. This is NOT this module's doing: every accessor the binding exposes
//   (getRowsJson, getRows, getColumnsJS, getRowObjects) strips it identically,
//   so the loss is below the JS layer in @duckdb/node-api and cannot be fixed
//   by switching accessor or by post-processing — by the time a string reaches
//   JS there is no way to know a BOM was ever there. Only a BOM at position 0
//   is affected; one anywhere else survives.
//   The only correct fix is at projection time, in SQL, before the value
//   crosses: double a leading BOM so the transport's strip is an exact inverse.
//   `parquetStore.readTable` does this (`bomSafe`) because storage fidelity is
//   non-negotiable. `pipelineDuck` does NOT, so a text cell beginning with a
//   BOM would round-trip lossily through the (default-off) SQL pipeline path.
//   Pinned by a test in scripts/test-duckdb.ts so it stays visible.
//
// Facts this design rests on (all measured in a spike, not assumed):
//   • `Atomics.wait` IS permitted on Electron's/Node's main thread (it is only
//     banned on a *browser* main thread). SharedArrayBuffer needs no flags.
//   • `postMessage` transferables are USELESS here: a transferred buffer is
//     delivered through the event loop, and a blocking call never reaches the
//     event loop. Results MUST travel through a SharedArrayBuffer. The memcpy
//     that costs measured ~0.83 ms for a 100k-row result — noise next to the
//     native→JS materialization the binding itself does.
//   • The SAB is GROWABLE (`{ maxByteLength }`), so there is no pre-sizing tax:
//     it starts at 1 MiB and the worker grows it in place, visible on both
//     threads without re-posting.
//   • `@duckdb/node-api` ships NO Arrow support (every Arrow binding in its
//     .d.ts is commented out), so results are materialized JS values. The
//     encode/decode pair below is deliberately isolated (`encodeRows` in
//     src/duckdbWorker.ts ⟷ `decodeRows` here) so an Arrow/columnar payload can
//     replace it later without touching the transport.
//
// Contract:
//   • LAZY — importing this module starts nothing. The worker (~115 ms) spins up
//     on the first `query`/`exec`/`isAvailable` call.
//   • NEVER fatal — if the worker or the native binding fails to load,
//     `isAvailable()` returns false and every call throws a typed `DuckDBError`
//     the caller can catch to fall back to the pure-JS path.
//   • PARAMETERS ARE BOUND, never interpolated. SQL text is app-generated; every
//     user/AI value crosses as a bound parameter (same invariant as the Postgres
//     path in connectionRun.ts). No shell is involved anywhere.
//   • Blocking is the point: a slow query freezes the main thread. Callers are
//     responsible for keeping queries small enough to feel synchronous.

import * as path from 'path';
import { Worker } from 'worker_threads';

// ── Public API ───────────────────────────────────────────────────────────────

/** A cell as it comes back from DuckDB. See TYPE MAPPING below. */
export type DuckValue = string | number | null;

export interface DuckRow {
  [col: string]: DuckValue;
}

export type DuckErrorCode =
  | 'unavailable' // worker/native module never came up — use the JS fallback
  | 'query' // DuckDB rejected the SQL, or a caller passed a bad argument
  | 'overflow' // result larger than the shared buffer ceiling
  | 'timeout' // worker stopped answering; bridge shut down
  | 'config'; // configure() called at the wrong time

export class DuckDBError extends Error {
  readonly code: DuckErrorCode;
  constructor(code: DuckErrorCode, message: string) {
    super(message);
    this.name = 'DuckDBError';
    this.code = code;
  }
}

export interface DuckDBOptions {
  /** Database file, or ':memory:' (default). Applied only before the first use. */
  dbPath?: string;
  /** Initial shared payload buffer. Default 1 MiB. */
  initialBytes?: number;
  /** Hard ceiling for a single result payload. Default 512 MiB. */
  maxBytes?: number;
}

// ── TYPE MAPPING (DuckDB → DuckValue) ────────────────────────────────────────
// Decided in src/duckdbWorker.ts; documented here because it is what callers see.
//
//   TINYINT…INTEGER, FLOAT, DOUBLE   → number
//   DECIMAL                          → number  (may round past ~15 significant
//                                      digits — cast to VARCHAR in SQL if exact)
//   BIGINT/UBIGINT/HUGEINT/UHUGEINT  → string  ← precision, see below
//   BOOLEAN                          → 'true' | 'false'
//   DATE/TIME/TIMESTAMP(+TZ)/UUID/…  → string  ('2024-01-01', '2024-01-01 10:00:00')
//   INTERVAL/LIST/STRUCT/MAP/…       → string  (JSON text)
//   NULL                             → null
//
// BIGINT DECISION: 64-bit-and-wider integers come back as DECIMAL STRINGS, never
// JS numbers. `SUM(INTEGER)` in DuckDB returns HUGEINT, and the naive paths
// (CLI `-json`, `Number(bigint)`) silently round anything past 2^53 — the spike
// caught `9007199254740993` becoming …992. A whole column is typed the same way
// regardless of the magnitude of individual rows, so downstream code never sees
// a column that is number for small rows and string for big ones. Callers that
// want arithmetic should cast in SQL (`SUM(x)::DOUBLE`) and accept the rounding
// explicitly rather than have the bridge decide it for them.

const DEFAULT_DB = ':memory:';
const DEFAULT_INITIAL_BYTES = 1 << 20; // 1 MiB
const DEFAULT_MAX_BYTES = 512 << 20; // 512 MiB
const STARTUP_TIMEOUT_MS = 20_000; // native module load + first connect
const CALL_TIMEOUT_MS = 120_000; // a wedged worker must not hang the app forever

// Control block slots (Int32Array over a 16-byte SAB).
const SIG = 0; // signal, see below
const LEN = 1; // payload byte length
const NEED = 2; // bytes required, on overflow
const MICROS = 3; // worker-side elapsed µs (diagnostic)

const PENDING = 0;
const OK = 1;
const ERROR = 2;
const OVERFLOW = 3;

// ── Growable SharedArrayBuffer (ES2024) ──────────────────────────────────────
// tsconfig targets ES2022, whose lib has no `maxByteLength`/`grow`/`growable`.
// Rather than widen the whole project's lib for one file, the shape is declared
// locally and the global constructor is narrowed to it once.
interface GrowableSAB extends SharedArrayBuffer {
  readonly growable: boolean;
  readonly maxByteLength: number;
  grow(newLength: number): void;
}
type GrowableSABCtor = new (byteLength: number, options?: { maxByteLength?: number }) => GrowableSAB;
const SAB = SharedArrayBuffer as unknown as GrowableSABCtor;

// ── Module state ─────────────────────────────────────────────────────────────

type State = 'idle' | 'ready' | 'failed';

let state: State = 'idle';
let worker: Worker | null = null;
let ctl: Int32Array | null = null;
let dataSab: GrowableSAB | null = null;
let dataView: Uint8Array | null = null;
let failReason = '';
let opts: Required<DuckDBOptions> = {
  dbPath: DEFAULT_DB,
  initialBytes: DEFAULT_INITIAL_BYTES,
  maxBytes: DEFAULT_MAX_BYTES,
};

/**
 * Set the database path / buffer sizes. Must be called BEFORE the first use
 * (call `shutdown()` first to reconfigure a running bridge). Throws if the
 * bridge is already up, rather than silently ignoring the new options.
 */
export function configure(next: DuckDBOptions): void {
  if (state === 'ready') {
    throw new DuckDBError('config', 'configure() must be called before the bridge starts (call shutdown() first)');
  }
  opts = {
    dbPath: next.dbPath ?? opts.dbPath,
    initialBytes: Math.max(1024, next.initialBytes ?? opts.initialBytes),
    maxBytes: Math.max(1024, next.maxBytes ?? opts.maxBytes),
  };
  if (opts.initialBytes > opts.maxBytes) opts.initialBytes = opts.maxBytes;
  state = 'idle'; // a previous failure may have been caused by the old options
  failReason = '';
}

/**
 * True when DuckDB can serve queries. Starts the worker on first call (this is
 * the "is the fast path available?" probe, so it must actually try), and never
 * throws — a false answer means: use the pure-JS path.
 */
export function isAvailable(): boolean {
  return ensureStarted();
}

/** Run a query and return its rows. SYNCHRONOUS — blocks the calling thread. */
export function query(sql: string, params?: readonly DuckValue[]): DuckRow[] {
  const text = call('query', sql, params);
  return text ? decodeRows(text) : [];
}

/** Run a statement for its side effects (DDL/DML). SYNCHRONOUS. */
export function exec(sql: string): void {
  call('exec', sql, undefined);
}

/**
 * Terminate the worker and release the shared buffers. Idempotent: calling it
 * twice, or before the bridge ever started, is a no-op. A later `query()` starts
 * a fresh worker (and, for an in-memory database, a fresh empty catalog).
 */
export function shutdown(): void {
  const w = worker;
  worker = null;
  ctl = null;
  dataSab = null;
  dataView = null;
  state = 'idle';
  failReason = '';
  if (w) void w.terminate();
}

// ── Startup ──────────────────────────────────────────────────────────────────

function ensureStarted(): boolean {
  if (state === 'ready') return true;
  if (state === 'failed') return false;
  try {
    start();
    state = 'ready';
    return true;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return false;
  }
}

function fail(reason: string): void {
  failReason = reason;
  const w = worker;
  worker = null;
  ctl = null;
  dataSab = null;
  dataView = null;
  state = 'failed';
  if (w) void w.terminate();
}

function start(): void {
  const control = new SharedArrayBuffer(16);
  ctl = new Int32Array(control);

  // Growable if the runtime supports it (Node 20+/Electron); otherwise fall back
  // to allocating the ceiling up front so the bridge still works.
  let payload: GrowableSAB;
  try {
    payload = new SAB(opts.initialBytes, { maxByteLength: opts.maxBytes });
    if (!payload.growable) payload = new SAB(opts.maxBytes);
  } catch {
    payload = new SAB(opts.maxBytes);
  }
  dataSab = payload;
  dataView = new Uint8Array(payload);

  // The worker is the emitted sibling of src/duckdbWorker.ts, resolved relative
  // to this file (CommonJS emit → __dirname is src/, packaged or not).
  const workerPath = path.join(__dirname, 'duckdbWorker.js');
  Atomics.store(ctl, SIG, PENDING);
  const w = new Worker(workerPath, {
    workerData: { control, payload, dbPath: opts.dbPath },
  });
  worker = w;
  // Never let the worker keep the process (or an Electron quit) alive, and never
  // let an 'error'/'exit' event become an uncaught exception. These handlers run
  // only when the event loop turns, i.e. never while we are blocked — the
  // timeout below is what actually protects a blocked caller.
  w.unref();
  w.on('error', (err: Error) => fail('duckdb worker error: ' + err.message));
  w.on('exit', () => {
    if (worker === w) fail('duckdb worker exited');
  });

  // Ready handshake. A worker that dies before signalling (missing native
  // module, bad file) can only be detected by this timeout, because its 'error'
  // event needs an event-loop turn we are not going to give it.
  block(STARTUP_TIMEOUT_MS);
}

// ── Call path ────────────────────────────────────────────────────────────────

function call(kind: 'query' | 'exec', sql: string, params?: readonly DuckValue[]): string {
  if (!ensureStarted() || !worker || !ctl) {
    throw new DuckDBError('unavailable', 'DuckDB is not available' + (failReason ? ': ' + failReason : ''));
  }
  if (typeof sql !== 'string' || !sql) {
    throw new DuckDBError('query', 'sql must be a non-empty string');
  }
  const bound = checkParams(params);
  Atomics.store(ctl, SIG, PENDING);
  Atomics.store(ctl, LEN, 0);
  Atomics.store(ctl, NEED, 0);
  worker.postMessage({ kind, sql, params: bound });
  return block(CALL_TIMEOUT_MS);
}

// Values reach DuckDB as BOUND PARAMETERS, never as SQL text. Anything that is
// not a plain scalar is rejected here rather than stringified into a statement.
function checkParams(params?: readonly DuckValue[]): DuckValue[] {
  if (params === undefined) return [];
  if (!Array.isArray(params)) throw new DuckDBError('query', 'params must be an array');
  return params.map((v, i) => {
    if (v === null || typeof v === 'string' || typeof v === 'number') return v;
    throw new DuckDBError('query', `params[${i}] must be a string, number, or null (got ${typeof v})`);
  });
}

/**
 * Block until the worker signals, then return the payload as text.
 * Throws (typed) on a DuckDB error, a payload over the ceiling, or a timeout.
 */
function block(timeoutMs: number): string {
  const c = ctl;
  const sab = dataSab;
  if (!c || !sab) throw new DuckDBError('unavailable', 'DuckDB bridge is not running');

  // Atomics.wait can return spuriously ('ok') without the value changing, so
  // loop until the signal actually moves off PENDING or the deadline passes.
  const deadline = Date.now() + timeoutMs;
  while (Atomics.load(c, SIG) === PENDING) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    Atomics.wait(c, SIG, PENDING, left);
  }

  const signal = Atomics.load(c, SIG);
  if (signal === PENDING) {
    // The worker is wedged or dead. It may still write into the shared buffer
    // later, which would corrupt a subsequent call — so tear the bridge down
    // instead of leaving it in a state we cannot reason about.
    fail('worker did not respond within ' + timeoutMs + 'ms');
    throw new DuckDBError('timeout', 'DuckDB did not respond within ' + timeoutMs + 'ms; bridge shut down');
  }

  if (signal === OVERFLOW) {
    const need = Atomics.load(c, NEED);
    // Nothing was written; the bridge stays usable for the next (smaller) call.
    throw new DuckDBError(
      'overflow',
      `result of ${need} bytes exceeds the ${sab.maxByteLength ?? sab.byteLength}-byte shared buffer ceiling ` +
        '(add a LIMIT, aggregate in SQL, or raise maxBytes via configure())'
    );
  }

  const len = Atomics.load(c, LEN);
  // A length-tracking view over a growable SAB updates itself, but re-wrap
  // defensively in case the runtime handed back a fixed-length view.
  if (!dataView || dataView.byteLength < len) dataView = new Uint8Array(sab);
  // Buffer over shared memory: no TextDecoder (whose SAB behaviour differs
  // between Node and Chromium builds), one copy in toString.
  const text = len > 0 ? Buffer.from(sab as unknown as ArrayBuffer, 0, len).toString('utf8') : '';
  if (signal === ERROR) throw new DuckDBError('query', text || 'DuckDB error');
  return text;
}

/** Worker-side elapsed time of the last call, in microseconds (diagnostic). */
export function lastCallMicros(): number {
  return ctl ? Atomics.load(ctl, MICROS) : 0;
}

// ── Payload decode ───────────────────────────────────────────────────────────
// Pairs with `encodeRows` in src/duckdbWorker.ts — swap BOTH together to move to
// an Arrow/columnar payload. Columnar JSON ({columns, rows}) rather than row
// objects: the column names appear once instead of once per row, which is both
// smaller on the wire and cheaper to parse.

interface WirePayload {
  columns: string[];
  rows: DuckValue[][];
}

function decodeRows(text: string): DuckRow[] {
  const payload = JSON.parse(text) as WirePayload;
  const cols = payload.columns;
  const out: DuckRow[] = new Array(payload.rows.length);
  for (let r = 0; r < payload.rows.length; r++) {
    const src = payload.rows[r];
    const row: DuckRow = {};
    for (let c = 0; c < cols.length; c++) row[cols[c]] = src[c] ?? null;
    out[r] = row;
  }
  return out;
}
