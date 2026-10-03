// DuckDB query bridge — MAIN PROCESS ONLY. Two call paths, one worker, one
// DuckDB connection.
//
// `@duckdb/node-api` is async-only (every call returns a Promise), but the code
// that consumes it (transforms, metrics, viz data) is synchronous. So the
// original — and still primary — path gives the main process a genuinely
// SYNCHRONOUS `query()` by parking DuckDB in a worker thread and blocking on
// `Atomics.wait`:
//
//   main thread                          worker thread
//   ───────────                          ─────────────
//   ctl[0] = PENDING
//   worker.postMessage({sql, params}) ─▶ runAndReadAll(sql, params)
//   Atomics.wait(ctl, 0, PENDING)        encode payload → SharedArrayBuffer
//        ⟵ unblocks ⟵                    ctl[0] = OK; Atomics.notify(ctl, 0)
//   read bytes out of the SAB, parse
//
// ── WHY THERE IS ALSO AN ASYNC PATH ──────────────────────────────────────────
// Blocking is correct for BATCH COMPUTE — one metric, one aggregate, one
// pipeline fold, where the answer is wanted on the next line and the freeze is
// milliseconds. It is catastrophic for INTERACTIVE, HIGH-FREQUENCY callers: a
// Mosaic brush drag issues queries every animation frame, and every one of them
// would freeze the whole Electron main process — all five windows, the menu bar,
// the global hotkey (docs/phase-3 blocker B3). `queryAsync`/`execAsync` serve
// those callers off the worker's `message` event instead, so the event loop
// keeps turning. Nothing about the sync path changed; pick by caller:
//
//   query() / exec()            batch compute, answer needed on the next line
//   queryAsync() / execAsync()  interactive/high-frequency, per-frame, UI-driven
//
// The async replies come back through `postMessage`, which is available to them
// precisely because they DO reach the event loop — the constraint that forced
// the SharedArrayBuffer on the sync path does not apply. Async replies never
// touch the control block or the payload buffer, which is what makes mixing the
// two safe (see MIXING below).
//
// ASYNC TRANSPORT, measured (100k×5 and 1M×3 wire payloads, Apple M4, medians of
// 7, worker→main round trip including encode and decode):
//   post the JSON string           29 ms / 213 ms   ← chosen
//   transfer an ArrayBuffer of the
//     same JSON as UTF-8 bytes     30 ms / 227 ms
//   structuredClone {columns,rows} 43 ms / 409 ms
// Transferables do NOT help: the payload has to be built as a string anyway, so
// transferring only adds a UTF-8 encode on one side and a decode on the other,
// which costs more than V8's own string clone. So there is ONE encoder
// (`encodeText` in src/duckdbWorker.ts) and ONE decoder (`decodeRows` here); the
// only difference between the paths is whether those bytes ride a memcpy into
// the SAB or a `postMessage`. Structured cloning the row objects directly —
// which would skip JSON entirely — is 1.5–1.9× SLOWER and was rejected.
//
// ── MIXING THE TWO (the ordering that looks like a deadlock and is not) ───────
// The worker serializes every request through one promise queue. So:
//   1. `queryAsync(A)` is in flight. Main issues `query(B)` and parks in
//      `Atomics.wait`.
//   2. The worker finishes A and posts its reply. That reply CANNOT be delivered
//      — main is not at its event loop. It sits in the port queue. The worker is
//      not blocked by this: `postMessage` just enqueues.
//   3. The worker dequeues B, writes the SAB, `Atomics.notify`.
//   4. Main wakes, returns B's rows, and later — on its next event-loop turn —
//      drains A's buffered reply and resolves that promise.
// The sync signal is what releases the async replies. The reverse ordering
// cannot arise: a single-threaded main cannot issue an async call while it is
// parked, so "sync then async" always means the sync call already returned.
// Verified by test in scripts/test-duckdb.ts in both orders, with several async
// calls in flight across a sync call, including a sync call issued from inside
// an async continuation. NO ordering was found that deadlocks.
// The one thing that would break this is an async completion writing the control
// block: it would forge the parked caller's signal. The worker therefore never
// does — enforced by the reply channel being chosen from the presence of an
// `id`, in one place.
// The honest caveat: an async call is only as timely as the main thread's next
// event-loop turn, so a long sync query DELAYS every async promise behind it.
// That is a latency cost, not a deadlock, and it is inherent to sharing one
// thread — the fix is for interactive callers not to mix in sync calls.
//
// ⚠ KNOWN LIMITATION — a leading U+FEFF (BOM) is LOST on every returned string,
//   on BOTH paths (verified): the strip happens inside @duckdb/node-api's
//   accessors, before either transport sees a value, so it is not something a
//   transport can avoid.
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
//   • `postMessage` transferables are USELESS to the SYNC path: a transferred
//     buffer is delivered through the event loop, and a blocking call never
//     reaches the event loop. Its results MUST travel through a
//     SharedArrayBuffer. The memcpy that costs measured ~0.83 ms for a 100k-row
//     result — noise next to the native→JS materialization the binding itself
//     does. (The async path CAN use `postMessage`, and measurement says it
//     should post a plain string rather than transfer — see ASYNC TRANSPORT.)
//   • The SAB is GROWABLE (`{ maxByteLength }`), so there is no pre-sizing tax:
//     it starts at 1 MiB and the worker grows it in place, visible on both
//     threads without re-posting.
//   • `@duckdb/node-api` ships NO Arrow support (every Arrow binding in its
//     .d.ts is commented out), so results are materialized JS values. The
//     encode/decode pair below is deliberately isolated (`encodeText` in
//     src/duckdbWorker.ts ⟷ `decodeRows` here) so an Arrow/columnar payload can
//     replace it later without touching either transport.
//
// Contract:
//   • LAZY — importing this module starts nothing. The worker (~115 ms) spins up
//     on the first `query`/`exec`/`queryAsync`/`execAsync`/`isAvailable` call.
//     Started from an async call, the ~115 ms handshake is awaited, not blocked
//     on — the async path never enters `Atomics.wait`, not even once, not even
//     for startup.
//   • NEVER fatal — if the worker or the native binding fails to load,
//     `isAvailable()` returns false and every call throws a typed `DuckDBError`
//     the caller can catch to fall back to the pure-JS path.
//   • PARAMETERS ARE BOUND, never interpolated. SQL text is app-generated; every
//     user/AI value crosses as a bound parameter (same invariant as the Postgres
//     path in connectionRun.ts). No shell is involved anywhere.
//   • Blocking is the point OF `query`/`exec`: a slow query freezes the main
//     thread. Those callers are responsible for keeping queries small enough to
//     feel synchronous. `queryAsync`/`execAsync` carry no such obligation — that
//     is the whole reason they exist.
//   • NOTHING IS LEFT PENDING. Worker death, a wedged worker, and `shutdown()`
//     all SETTLE every in-flight async promise (rejecting with `unavailable` or
//     `timeout`) rather than abandoning it.

import * as path from 'path';
import { Worker, isMainThread } from 'worker_threads';

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
  | 'config' // configure() called at the wrong time
  | 'sync'; // query()/exec() on the main thread after forbidSyncOnMainThread()

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
// 1 = OK. Named only on the worker side (src/duckdbWorker.ts, which writes it);
// this side decodes by elimination — anything not PENDING/OVERFLOW/ERROR is a
// success — so a local `OK` constant here would be write-only.
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

// 'starting' exists only because an async first-caller spawns the worker without
// blocking on the handshake. A sync call arriving in that window must NOT spawn
// a second worker — it joins the same handshake through the control block.
type State = 'idle' | 'starting' | 'ready' | 'failed';

/** Reply shape posted by the worker. Mirrors `AsyncReply` in src/duckdbWorker.ts. */
type WorkerReply =
  | { type: 'ready' }
  | { type: 'init-error'; message: string }
  | { id: number; ok: true; text: string; micros: number }
  | { id: number; ok: false; code: 'query'; message: string; micros: number }
  | { id: number; ok: false; code: 'overflow'; need: number; micros: number };

interface InFlight {
  resolve: (text: string) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
}

let state: State = 'idle';
let worker: Worker | null = null;
let ctl: Int32Array | null = null;
let dataSab: GrowableSAB | null = null;
let dataView: Uint8Array | null = null;
let failReason = '';
let nextCallId = 1;
let asyncMicros = 0;
const inFlight = new Map<number, InFlight>();
let startWaiters: Array<{ resolve: () => void; reject: (err: unknown) => void }> = [];
let startTimer: NodeJS.Timeout | null = null;
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
  if (state === 'ready' || state === 'starting') {
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

// SERVER MODE. One process serves every request, so a sync call parks ALL of
// them, not one window. `forbidSyncOnMainThread()` makes `query()`/`exec()`
// THROW on the main thread instead, so a sync call site still reachable from a
// request fails loudly rather than freezing the server. Worker threads (the
// compute pool) are exempt — parking their own thread is what they are for.
// The web server (src/server/main.ts) calls it at boot (T4.2) and
// scripts/test-asyncReach.ts proves no RPC handler reaches a sync call; the
// desktop never calls it. `isAvailable()` is NOT guarded: it blocks only for the
// one-time ~115 ms startup handshake, which the server pays at boot (/readyz).
let syncForbidden = false;

/** Make the sync API throw on the main thread (`false` lifts it — tests). */
export function forbidSyncOnMainThread(on = true): void {
  syncForbidden = on;
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
 * Run a query and resolve with its rows WITHOUT blocking the event loop — for
 * interactive/high-frequency callers (per-frame brush queries, cross-filtering).
 * Same worker, same DuckDB connection, same result bytes as `query()`; only the
 * reply channel differs. Rejects with the same `DuckDBError` codes `query()`
 * throws. Requests are served in the order they were issued.
 */
export async function queryAsync(sql: string, params?: readonly DuckValue[]): Promise<DuckRow[]> {
  const text = await callAsync('query', sql, params);
  return text ? decodeRows(text) : [];
}

/** Run a statement for its side effects (DDL/DML). Non-blocking twin of `exec()`. */
export async function execAsync(sql: string): Promise<void> {
  await callAsync('exec', sql, undefined);
}

/**
 * Terminate the worker and release the shared buffers. Idempotent: calling it
 * twice, or before the bridge ever started, is a no-op. A later `query()` starts
 * a fresh worker (and, for an in-memory database, a fresh empty catalog).
 *
 * In-flight async calls are SETTLED, not abandoned: each rejects with
 * `unavailable`. A promise that can never settle is a leak the caller cannot
 * see, so the shutdown path owes them an answer.
 */
export function shutdown(): void {
  const w = worker;
  worker = null;
  ctl = null;
  dataSab = null;
  dataView = null;
  state = 'idle';
  failReason = '';
  const busy = inFlight.size > 0;
  settleAllPending(new DuckDBError('unavailable', 'DuckDB bridge was shut down while the call was in flight'));
  if (w) closeWorker(w, busy);
}

/**
 * Stop a worker. `terminate()` when it is idle; ASK IT TO EXIT when a call may
 * still be running.
 *
 * ⚠ `Worker.terminate()` while an `@duckdb/node-api` native call is in flight
 *   ABORTS THE PROCESS — `libc++abi: terminating due to uncaught exception of
 *   type Napi::Error`, not a catchable JS error. Reproduced in ~15 lines with
 *   nothing from this module involved: a bare worker that opens an instance,
 *   starts `connection.run(...)`, and is terminated before it resolves. The
 *   binding's completion callback lands in a torn-down N-API environment.
 *   This was unreachable before the async path existed, because a sync caller
 *   holds the main thread for the whole query and so cannot call `shutdown()`
 *   during one. `queryAsync` makes it reachable, so it has to be handled.
 * The fix uses the machinery already there: the close request goes through the
 * worker's serialized queue, so it runs only after every queued call has
 * settled, at which point exiting is safe. There is deliberately NO terminate
 * backstop — a worker wedged badly enough to ignore the request is exactly the
 * worker that terminating would abort on. It is left orphaned and unref'ed, so
 * it holds nothing open and dies with the process. Leaking one thread in a
 * pathological case beats aborting the app.
 * Consequence worth knowing: a FILE-backed database restarted immediately after
 * a busy shutdown may briefly race the old worker for the file lock. The app
 * uses ':memory:' plus `read_parquet`, so this is theoretical today.
 */
function closeWorker(w: Worker, busy: boolean): void {
  if (!busy) {
    void w.terminate();
    return;
  }
  try {
    w.postMessage({ kind: 'close' });
  } catch {
    void w.terminate(); // port already gone ⇒ nothing native can be in flight
    return;
  }
  // Hold the event loop open until it actually goes. An `unref`ed orphan is NOT
  // enough: tearing the PROCESS down around a live native call aborts it exactly
  // as `terminate()` does (same reproduction, just triggered by exit instead).
  // We asked it to leave; we wait for it to leave. The wait is bounded by the
  // in-flight query, and by the same ceiling any single call already has — past
  // that the worker is wedged, and waiting longer buys nothing.
  w.ref();
  const giveUp = setTimeout(() => w.unref(), CALL_TIMEOUT_MS);
  giveUp.unref();
  w.once('exit', () => clearTimeout(giveUp));
}

/**
 * Reject every waiting async caller (in-flight calls and anyone awaiting the
 * startup handshake). Called from `shutdown()` and `fail()` — the two ways the
 * bridge can stop being able to answer.
 */
function settleAllPending(err: DuckDBError): void {
  if (startTimer) {
    clearTimeout(startTimer);
    startTimer = null;
  }
  const calls = [...inFlight.values()];
  inFlight.clear();
  const waiters = startWaiters;
  startWaiters = [];
  for (const c of calls) {
    clearTimeout(c.timer);
    c.reject(err);
  }
  for (const w of waiters) w.reject(err);
}

// ── Startup ──────────────────────────────────────────────────────────────────

function ensureStarted(): boolean {
  if (state === 'ready') return true;
  if (state === 'failed') return false;
  try {
    // 'starting' ⇒ an async caller already spawned the worker. Join its
    // handshake instead of spawning a second one: the worker signals the control
    // block on init regardless of who asked, and if it already has, `block()`
    // sees a non-PENDING signal and returns immediately.
    if (state !== 'starting') spawn();
    block(STARTUP_TIMEOUT_MS);
    markStarted();
    return true;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Start the worker without blocking, and resolve when it reports ready over the
 * message channel. This is why the worker posts a `ready` message as well as
 * signalling the control block: an async first-caller has no business parking
 * the main thread for the ~115 ms handshake.
 */
function ensureStartedAsync(): Promise<void> {
  if (state === 'ready') return Promise.resolve();
  if (state === 'failed') return Promise.reject(unavailable());
  if (state === 'idle') {
    try {
      spawn();
      state = 'starting';
      startTimer = setTimeout(() => fail('worker did not start within ' + STARTUP_TIMEOUT_MS + 'ms'), STARTUP_TIMEOUT_MS);
      startTimer.unref();
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
      return Promise.reject(unavailable());
    }
  }
  return new Promise<void>((resolve, reject) => {
    startWaiters.push({ resolve, reject });
    updateRef();
  });
}

/** Promote to 'ready' and release anyone awaiting the handshake. Idempotent. */
function markStarted(): void {
  if (state === 'failed') return;
  state = 'ready';
  if (startTimer) {
    clearTimeout(startTimer);
    startTimer = null;
  }
  const waiters = startWaiters;
  startWaiters = [];
  for (const w of waiters) w.resolve();
  updateRef();
}

function unavailable(): DuckDBError {
  return new DuckDBError('unavailable', 'DuckDB is not available' + (failReason ? ': ' + failReason : ''));
}

function fail(reason: string): void {
  failReason = reason;
  const w = worker;
  worker = null;
  ctl = null;
  dataSab = null;
  dataView = null;
  state = 'failed';
  const busy = inFlight.size > 0;
  settleAllPending(new DuckDBError('unavailable', 'DuckDB is not available: ' + reason));
  if (w) closeWorker(w, busy);
}

/**
 * Hold the event loop open EXACTLY while async work is outstanding. The worker
 * is `unref`ed so it can never delay an app quit, but `Worker.unref()` also
 * unrefs its message port — so with nothing else pending, Node would happily
 * exit with an async reply still in the port. Ref while something is waiting for
 * it; unref the moment nothing is.
 */
function updateRef(): void {
  const w = worker;
  if (!w) return;
  if (inFlight.size > 0 || startWaiters.length > 0) w.ref();
  else w.unref();
}

function spawn(): void {
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

  // The worker is the emitted sibling of src/engine/duckdbWorker.ts, resolved
  // relative to this file (CommonJS emit → __dirname is src/engine/, packaged or
  // not). This resolves ONLY because the whole engine cluster shares a directory.
  const workerPath = path.join(__dirname, 'duckdbWorker.js');
  Atomics.store(ctl, SIG, PENDING);
  const w = new Worker(workerPath, {
    // maxBytes is told to the worker because the async path has no shared buffer
    // to overflow, yet must enforce the same ceiling.
    workerData: { control, payload, dbPath: opts.dbPath, maxBytes: opts.maxBytes },
  });
  worker = w;
  // Never let the worker keep the process (or an Electron quit) alive, and never
  // let an 'error'/'exit' event become an uncaught exception. These handlers run
  // only when the event loop turns, i.e. never while a sync call is blocked —
  // its timeout is what actually protects a blocked caller. `updateRef()` re-refs
  // the worker for exactly as long as an async caller is waiting on it.
  w.on('message', (reply: WorkerReply) => onWorkerMessage(w, reply));
  w.on('error', (err: Error) => fail('duckdb worker error: ' + err.message));
  w.on('exit', () => {
    if (worker === w) fail('duckdb worker exited');
  });
  w.unref();
}

/**
 * The async reply channel. Also carries the startup handshake, so that a caller
 * who never blocks can still learn the worker came up (or did not).
 */
function onWorkerMessage(w: Worker, reply: WorkerReply): void {
  if (worker !== w) return; // from a worker we already discarded — inert
  if ('type' in reply) {
    if (reply.type === 'ready') markStarted();
    else fail('DuckDB init failed: ' + reply.message);
    return;
  }
  const pending = inFlight.get(reply.id);
  // No entry ⇒ the call already timed out or was settled by shutdown/fail. A
  // late reply is harmless precisely because it lands on the message channel and
  // not in the shared buffer, where it could have corrupted a later sync call.
  if (!pending) return;
  inFlight.delete(reply.id);
  clearTimeout(pending.timer);
  updateRef();
  asyncMicros = reply.micros;
  if (reply.ok) pending.resolve(reply.text);
  else if (reply.code === 'overflow') {
    pending.reject(
      new DuckDBError(
        'overflow',
        `result of ${reply.need} bytes exceeds the ${opts.maxBytes}-byte result ceiling ` +
          '(add a LIMIT, aggregate in SQL, or raise maxBytes via configure())'
      )
    );
  } else pending.reject(new DuckDBError('query', reply.message || 'DuckDB error'));
}

// ── Call path ────────────────────────────────────────────────────────────────

function call(kind: 'query' | 'exec', sql: string, params?: readonly DuckValue[]): string {
  if (syncForbidden && isMainThread) {
    throw new DuckDBError('sync', `synchronous duck.${kind}() on the main thread is forbidden in server mode — use ${kind}Async()`);
  }
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

/**
 * Non-blocking twin of `call()`. Same validation, same worker, same serialized
 * queue — the only differences are that the request carries an `id` (which is
 * what tells the worker to reply by message) and that nothing here touches the
 * control block. That second point is load-bearing: a sync caller may be parked
 * in `Atomics.wait` when this reply arrives, and the control block is that
 * caller's private channel.
 */
function callAsync(kind: 'query' | 'exec', sql: string, params?: readonly DuckValue[]): Promise<string> {
  let bound: DuckValue[];
  try {
    // Argument errors reject rather than throw synchronously, so an async caller
    // has exactly one failure channel to handle.
    if (typeof sql !== 'string' || !sql) throw new DuckDBError('query', 'sql must be a non-empty string');
    bound = checkParams(params);
  } catch (err) {
    return Promise.reject(err);
  }
  // Post NOW when the bridge is already up, rather than after an `await` that
  // would defer it by a microtask. Otherwise a sync call issued later in the
  // same tick would reach the worker FIRST and be served ahead of async work
  // that was requested before it — issue order must be service order, and the
  // two paths share one queue in the worker. Only a cold start defers, and then
  // there is nothing to be out of order with.
  if (state === 'ready' && worker) return submit(kind, sql, bound, worker);
  return ensureStartedAsync().then(() => {
    const w = worker;
    if (!w || state !== 'ready') throw unavailable();
    return submit(kind, sql, bound, w);
  });
}

function submit(kind: 'query' | 'exec', sql: string, bound: DuckValue[], w: Worker): Promise<string> {
  const id = nextCallId++;
  return new Promise<string>((resolve, reject) => {
    // A wedged worker must not leave a promise pending forever. Unlike the sync
    // timeout this does NOT tear the bridge down: a late async reply carries an
    // id nobody is holding and is discarded, so there is nothing to protect
    // against, and killing the worker would punish every other in-flight call.
    const timer = setTimeout(() => {
      const pending = inFlight.get(id);
      if (!pending) return;
      inFlight.delete(id);
      updateRef();
      pending.reject(new DuckDBError('timeout', 'DuckDB did not respond within ' + CALL_TIMEOUT_MS + 'ms'));
    }, CALL_TIMEOUT_MS);
    timer.unref(); // the worker ref, not this timer, is what holds the loop open
    inFlight.set(id, { resolve, reject, timer });
    updateRef();
    w.postMessage({ kind, sql, params: bound, id });
  });
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

/** Worker-side elapsed time of the last SYNC call, in microseconds (diagnostic). */
export function lastCallMicros(): number {
  return ctl ? Atomics.load(ctl, MICROS) : 0;
}

/**
 * Worker-side elapsed time of the last ASYNC call, in microseconds (diagnostic).
 * Separate from `lastCallMicros` because the async path deliberately never
 * writes the control block; it carries its timing in the reply message instead.
 * The gap between this and the caller's wall clock is transport + queueing.
 */
export function lastAsyncCallMicros(): number {
  return asyncMicros;
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
