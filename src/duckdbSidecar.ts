// The DuckDB sidecar CLIENT — parent side. Presents the same surface
// src/duckdb.ts does, over a child process instead of a worker thread plus a
// SharedArrayBuffer.
//
// THE ONE QUESTION THIS MODULE ANSWERS: can a synchronous query() survive?
//
// src/duckdb.ts's invariant 1 is a sync `query()` that nine modules call, bought
// today with `Atomics.wait` over a growable SAB. Node sets child stdio pipes
// NON-BLOCKING, so `fs.readSync` on one throws EAGAIN when no data is ready —
// which is why "just read the pipe" looks impossible at first glance. It is not:
// spinning on EAGAIN is a correct blocking read, and it is cheap because the
// reply is already in flight when the spin starts.
//
// TRANSPORT, measured on this machine (medians of 201 round trips, echo child):
//
//   payload                spin-on-EAGAIN pipe     blocking FIFO
//   scalar                         0.009 ms           0.009 ms
//   83 KB (Explore page)           0.076 ms           0.114 ms
//
//   EAGAIN spins per 83 KB call: 18.7
//
// So the sync API survives and no caller has to become `async` — which is the
// large, risky change this design exists to avoid.
//
// BUT THIS IS NOT A SPEEDUP, and docs/phase-6/01 §4.2 is wrong to imply it is.
// That section priced the transport ALONE against an echo child. Measured END TO
// END against real DuckDB queries, the sidecar is at parity on a scalar and
// modestly slower on real payloads, because transport is a small fraction of a
// query's cost and the extra copy is not free:
//
//   metric  (one scalar)   worker 0.35 ms   sidecar 0.34 ms    -4%
//   chart   (40 groups)    worker 1.76 ms   sidecar 1.97 ms   +12%
//   page    (500 rows)     worker 1.12 ms   sidecar 1.27 ms   +14%
//
// The case for this module is COMPLEXITY and ROBUSTNESS, not speed: it retires
// 534 lines of SharedArrayBuffer/Atomics machinery, and a child process can be
// killed mid-native-call where a wedged worker thread can only be orphaned.
//
// WHAT THIS DOES NOT DO YET. It does not replace src/duckdb.ts. It is built and
// tested alongside it so the two can be compared value-for-value first — the
// same discipline every resident-SQL module in this repo was landed with.

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type Scalar = string | number | null;
export interface SidecarRow {
  [col: string]: Scalar;
}

export type SidecarErrorCode = 'unavailable' | 'query' | 'overflow' | 'timeout' | 'config';

export class SidecarError extends Error {
  readonly code: SidecarErrorCode;
  constructor(code: SidecarErrorCode, message: string) {
    super(message);
    this.name = 'SidecarError';
    this.code = code;
  }
}

export interface SidecarOptions {
  dbPath?: string;
  /** Hard ceiling for a single result payload. Default 512 MiB, matching duckdb.ts. */
  maxBytes?: number;
}

const DEFAULT_DB = ':memory:';
const DEFAULT_MAX_BYTES = 512 << 20;
const STARTUP_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
const READ_CHUNK = 1 << 20;

type State = 'idle' | 'ready' | 'failed';

let state: State = 'idle';
let child: ChildProcess | null = null;
let inFd = -1;
let outFd = -1;
let carry = '';
let nextId = 1;
let failReason = '';
let lastMicros = 0;
let opts: Required<SidecarOptions> = { dbPath: DEFAULT_DB, maxBytes: DEFAULT_MAX_BYTES };

/** Set the database path / ceiling. Must be called before the sidecar starts. */
export function configure(next: SidecarOptions): void {
  if (state === 'ready') {
    throw new SidecarError('config', 'configure() must be called before the sidecar starts (call shutdown() first)');
  }
  opts = {
    dbPath: next.dbPath ?? opts.dbPath,
    maxBytes: Math.max(1024, next.maxBytes ?? opts.maxBytes),
  };
  state = 'idle';
  failReason = '';
}

/** True when the sidecar can serve queries. Starts it on first call. Never throws. */
export function isAvailable(): boolean {
  return ensureStarted();
}

/** Run a query and return its rows. SYNCHRONOUS — blocks the calling thread. */
export function query(sql: string, params?: readonly Scalar[]): SidecarRow[] {
  const text = call('query', sql, params);
  return text ? decodeRows(text) : [];
}

/** Run a statement for its side effects (DDL/DML). SYNCHRONOUS. */
export function exec(sql: string): void {
  call('exec', sql, undefined);
}

/** Worker-side elapsed microseconds for the last call (diagnostic). */
export function lastCallMicros(): number {
  return lastMicros;
}

/**
 * Stop the sidecar. Idempotent. Unlike the worker bridge this can always be done
 * safely: a process can be killed mid-native-call without aborting the host,
 * which is exactly what `Worker.terminate()` cannot promise.
 */
export function shutdown(): void {
  const c = child;
  child = null;
  inFd = -1;
  outFd = -1;
  carry = '';
  state = 'idle';
  failReason = '';
  if (!c) return;
  try {
    c.stdin?.end();
  } catch {
    /* already gone */
  }
  try {
    c.kill();
  } catch {
    /* already gone */
  }
}

// ── Startup ──────────────────────────────────────────────────────────────────

function ensureStarted(): boolean {
  if (state === 'ready') return true;
  if (state === 'failed') return false;
  try {
    start();
    // Cast: TypeScript cannot see that start() mutates module state, so it
    // narrows `state` to the 'idle' it was on entry.
    return (state as State) === 'ready';
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return false;
  }
}

function start(): void {
  // `process.execPath` under Electron is the app binary; ELECTRON_RUN_AS_NODE
  // makes it behave as plain Node. No extra binary ships for this.
  const childScript = path.join(__dirname, 'duckdbSidecarChild.js');
  const c = spawn(process.execPath, [childScript, opts.dbPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (!c.stdin || !c.stdout) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
    throw new Error('sidecar stdio unavailable');
  }
  // Raw descriptors, because every read on this path is synchronous. Touching
  // the streams would let Node's reader consume bytes this module must see.
  inFd = (c.stdin as unknown as { _handle: { fd: number } })._handle.fd;
  outFd = (c.stdout as unknown as { _handle: { fd: number } })._handle.fd;
  child = c;
  c.on('exit', () => {
    if (child === c) fail('sidecar exited');
  });

  const hello = readLine(STARTUP_TIMEOUT_MS);
  const msg = JSON.parse(hello) as { type?: string; message?: string };
  if (msg.type !== 'ready') {
    throw new Error(msg.message || 'sidecar did not report ready');
  }
  state = 'ready';
  failReason = '';
}

function fail(reason: string): void {
  state = 'failed';
  failReason = reason;
  const c = child;
  child = null;
  inFd = -1;
  outFd = -1;
  carry = '';
  if (c) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
}

// ── Call path ────────────────────────────────────────────────────────────────

function call(kind: 'query' | 'exec', sql: string, params?: readonly Scalar[]): string {
  if (!ensureStarted() || child === null) {
    throw new SidecarError('unavailable', 'DuckDB sidecar is not available' + (failReason ? ': ' + failReason : ''));
  }
  if (typeof sql !== 'string' || !sql) {
    throw new SidecarError('query', 'sql must be a non-empty string');
  }
  const bound = checkParams(params);
  const id = nextId++;
  writeLine(JSON.stringify({ id, kind, sql, params: bound }));

  const line = readLine(CALL_TIMEOUT_MS);
  const reply = JSON.parse(line) as {
    id: number;
    ok: boolean;
    text?: string;
    code?: string;
    message?: string;
    micros?: number;
  };
  lastMicros = typeof reply.micros === 'number' ? reply.micros : 0;
  if (reply.id !== id) {
    // Replies are strictly ordered, so this means the stream desynchronised.
    // Tearing down beats guessing: a mismatched reply could be handed to the
    // wrong caller as a correct-looking answer.
    fail('sidecar reply out of order (expected ' + id + ', got ' + reply.id + ')');
    throw new SidecarError('timeout', 'DuckDB sidecar desynchronised; bridge shut down');
  }
  if (!reply.ok) throw new SidecarError('query', reply.message || 'DuckDB error');

  const text = reply.text ?? '';
  // The ceiling is applied HERE and nowhere else, so there is one limit to keep
  // in step rather than two.
  if (Buffer.byteLength(text, 'utf8') > opts.maxBytes) {
    throw new SidecarError(
      'overflow',
      `result of ${Buffer.byteLength(text, 'utf8')} bytes exceeds the ${opts.maxBytes}-byte ceiling ` +
        '(add a LIMIT, aggregate in SQL, or raise maxBytes via configure())',
    );
  }
  return text;
}

// Values reach DuckDB as BOUND PARAMETERS, never as SQL text. Anything that is
// not a plain scalar is rejected here rather than stringified into a statement.
function checkParams(params?: readonly Scalar[]): Scalar[] {
  if (params === undefined) return [];
  if (!Array.isArray(params)) throw new SidecarError('query', 'params must be an array');
  return params.map((v, i) => {
    if (v === null || typeof v === 'string' || typeof v === 'number') return v;
    throw new SidecarError('query', `params[${i}] must be a string, number, or null (got ${typeof v})`);
  });
}

function writeLine(line: string): void {
  const buf = Buffer.from(line + '\n', 'utf8');
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(inFd, buf, off, buf.length - off);
    } catch (err: any) {
      if (err && (err.code === 'EAGAIN' || err.code === 'EINTR')) continue;
      throw new SidecarError('unavailable', 'sidecar write failed: ' + (err?.message ?? String(err)));
    }
  }
}

/**
 * Block until a whole line is available, then return it.
 *
 * The spin is the point. Node marks the pipe non-blocking, so `readSync` throws
 * EAGAIN whenever the child has not answered yet; spinning on that is a correct
 * blocking read. It costs CPU only for the microseconds the reply is in flight —
 * measured at 18.7 spins for an 83 KB payload — and unlike `Atomics.wait` it
 * needs no shared memory, no control block, and no second thread.
 */
function readLine(timeoutMs: number): string {
  const chunk = Buffer.allocUnsafe(READ_CHUNK);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const i = carry.indexOf('\n');
    if (i >= 0) {
      const line = carry.slice(0, i);
      carry = carry.slice(i + 1);
      return line;
    }
    if (outFd < 0) throw new SidecarError('unavailable', 'DuckDB sidecar is not running');
    let n = 0;
    try {
      n = fs.readSync(outFd, chunk, 0, chunk.length, null);
    } catch (err: any) {
      if (err && (err.code === 'EAGAIN' || err.code === 'EINTR')) {
        if (Date.now() > deadline) {
          fail('sidecar did not respond within ' + timeoutMs + 'ms');
          throw new SidecarError('timeout', 'DuckDB did not respond within ' + timeoutMs + 'ms; sidecar shut down');
        }
        continue; // no data yet — spin
      }
      fail('sidecar read failed: ' + (err?.message ?? String(err)));
      throw new SidecarError('unavailable', 'sidecar read failed');
    }
    if (n === 0) {
      // EOF: the child is gone. Fail loudly rather than spin to the deadline.
      fail('sidecar closed the pipe');
      throw new SidecarError('unavailable', 'DuckDB sidecar exited');
    }
    carry += chunk.toString('utf8', 0, n);
  }
}

// ── Payload decode ───────────────────────────────────────────────────────────
// Byte-identical to `decodeRows` in src/duckdb.ts, against the same columnar
// payload `encodeText` produces. One wire format, one shape, two transports.

interface WirePayload {
  columns: string[];
  rows: Scalar[][];
}

function decodeRows(text: string): SidecarRow[] {
  const payload = JSON.parse(text) as WirePayload;
  const cols = payload.columns;
  const out: SidecarRow[] = new Array(payload.rows.length);
  for (let r = 0; r < payload.rows.length; r++) {
    const src = payload.rows[r];
    const row: SidecarRow = {};
    for (let c = 0; c < cols.length; c++) row[cols[c]] = src[c] ?? null;
    out[r] = row;
  }
  return out;
}
