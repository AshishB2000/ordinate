// DuckDB worker thread — serves BOTH bridges in src/duckdb.ts from one
// connection. Runs in a worker_threads Worker; owns the only DuckDB connection.
// Never imports Electron and never touches the filesystem beyond the database
// path it is handed.
//
// On the server (T4.3) one of these runs PER ORG (src/engine/duckdbPool.ts):
// started with `setup` statements that lock it to the org's directory before
// `ready`, spoken to only asynchronously, and also serving ports the pool
// leases to compute threads. An async call can be interrupted by id.
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
import type { MessagePort } from 'worker_threads';
import type { DuckDBConnection } from '@duckdb/node-api';
// The type mapping and result encoder live in src/duckdbEngine.ts so the stdio
// sidecar shares exactly ONE definition of them with this worker.
import { encodeText } from './duckdbEngine';
import type { Scalar } from './duckdbEngine';


interface WorkerInit {
  control: SharedArrayBuffer;
  payload: SharedArrayBuffer;
  dbPath: string;
  /** Result ceiling. The async path has no shared buffer, so it needs this told. */
  maxBytes: number;
  /**
   * Statements run once after connecting and BEFORE `ready` (src/engine/duckdbPool.ts:
   * memory_limit, threads, the org's allowed_directories and the lock). A failure
   * is an init failure — a worker that could not lock itself never answers.
   */
  setup?: string[];
}

/**
 * Who sent a call: the parent (src/engine/duckdb.ts or the per-org pool), or a
 * port the pool leased to a compute thread. Ids are per sender. Calls from one
 * sender are served in order, so `lastStarted` tells a finished id from a
 * queued one when an interrupt arrives.
 */
interface Sender {
  post(msg: AsyncReply): void;
  skip: Set<number>;
  lastStarted: number;
  closed: boolean;
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
// The async call DuckDB is running now — what an interrupt for its id stops.
let running: { from: Sender; id: number; stopping?: NodeJS.Timeout } | null = null;

function finish(signal: number, bytes: number): void {
  Atomics.store(ctl, LEN, bytes);
  Atomics.store(ctl, SIG, signal);
  Atomics.notify(ctl, SIG);
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

// ── Message loop ─────────────────────────────────────────────────────────────

function handle(msg: CallMessage, from: Sender): Promise<void> {
  return msg.id === undefined ? handleSync(msg) : handleAsync(msg, msg.id, from);
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
async function handleAsync(msg: CallMessage, id: number, from: Sender): Promise<void> {
  const t0 = process.hrtime.bigint();
  from.lastStarted = id;
  // Cancelled or timed out while queued, or its sender is gone: never start it.
  // The caller already settled, so this reply is read by nobody.
  if (from.closed || from.skip.delete(id)) {
    from.post({ id, ok: false, code: 'query', message: 'cancelled before it started', micros: 0 });
    return;
  }
  // Async reply. `postMessage` is non-blocking on this side even when the main
  // thread is parked in `Atomics.wait` — the message lands in the port's queue
  // and is delivered when the main thread next reaches its event loop.
  const reply = (m: AsyncReply): void => from.post(m);
  const me: NonNullable<typeof running> = { from, id };
  running = me;
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
  } finally {
    clearInterval(me.stopping);
    running = null;
  }
}

/**
 * Stop call `id` from `from` (a timeout or a cancel on the caller's side).
 * Handled the moment it arrives, NOT through the queue: the queue is busy
 * awaiting exactly the call to stop. Running → `connection.interrupt()`, the
 * query rejects with DuckDB's INTERRUPT error and the connection serves the next
 * call (measured: a 10^10-row scan stops in ~2 ms, `SELECT 42` answers after).
 * Still queued → skipped when its turn comes. Already finished → nothing.
 * Never `Worker.terminate()`: that aborts the process mid-native-call (see
 * `closeWorker` in src/engine/duckdb.ts).
 */
function interrupt(from: Sender, id: number): void {
  if (running && running.from === from && running.id === id) stopRunning();
  else if (id > from.lastStarted) from.skip.add(id);
}

/**
 * Interrupt the running call, and KEEP interrupting it until it settles. DuckDB
 * drops an interrupt that arrives while nothing is executing (it clears the flag
 * when a query begins), and one call is several native steps — extract, prepare,
 * run, each queued on libuv's pool — so a single interrupt that fell between
 * them was lost and the statement ran to completion (scripts/test-duckdbPool.ts
 * pins it). Re-sent every 10 ms, the first one after execution begins lands.
 */
function stopRunning(): void {
  if (!running || running.stopping) return;
  connection?.interrupt();
  running.stopping = setInterval(() => connection?.interrupt(), 10);
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
  for (const sql of init.setup ?? []) await connection.run(sql);
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

type Inbound = CallMessage | { kind: 'close' } | { kind: 'interrupt'; id: number } | { kind: 'port'; port: MessagePort };

function listen(on: (fn: (msg: Inbound) => void) => void, post: (msg: AsyncReply) => void): Sender {
  const from: Sender = { post, skip: new Set(), lastStarted: 0, closed: false };
  on((msg) => {
    if (msg.kind === 'interrupt') return interrupt(from, msg.id);
    // A compute thread's own line to this worker (src/engine/duckdbPool.ts
    // `lease`): same queue, same connection, replies on that port.
    if (msg.kind === 'port') {
      attach(msg.port);
      return;
    }
    queue = queue.then(() => (msg.kind === 'close' ? closeNow() : handle(msg, from))).catch(() => undefined);
  });
  return from;
}

function attach(port: MessagePort): void {
  const from = listen((fn) => port.on('message', fn), (m) => port.postMessage(m));
  // The compute thread finished, or was terminated by a cancel: stop what it
  // was running and skip what it queued.
  port.on('close', () => {
    from.closed = true;
    if (running && running.from === from) stopRunning();
  });
}

if (parentPort) {
  const pp = parentPort;
  listen((fn) => pp.on('message', fn), (m) => pp.postMessage(m));
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
