// The async half of a DuckDB worker conversation, over a Worker (the per-org
// pool, main thread) or a MessagePort (a compute thread's leased line to its
// org's worker). Speaks src/engine/duckdbWorker.ts's async protocol: a call
// carries an id, the reply comes back by message with the same id.
//
// What it adds over src/engine/duckdb.ts's own async path: a call can be
// STOPPED. Past its time limit, or when the request that asked is aborted, the
// promise rejects at once (`timeout` / `cancelled`) and the worker is told to
// interrupt it — `connection.interrupt()` if it is running, skip it if it is
// still queued. The worker survives and serves the next call; a late reply for
// a settled id is dropped.

import { DuckDBError } from './duckdb';
import type { DuckValue } from './duckdb';

type Reply =
  | { id: number; ok: true; text: string }
  | { id: number; ok: false; code: 'query'; message: string }
  | { id: number; ok: false; code: 'overflow'; need: number };

/** What a Worker and a MessagePort both are, as far as this client needs. */
interface Line {
  postMessage(msg: unknown): void;
  on(event: 'message' | 'close', fn: (msg: unknown) => void): unknown;
  ref(): void;
  unref(): void;
}

interface Pending {
  resolve(text: string): void;
  reject(err: unknown): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class DuckClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private dead: DuckDBError | null = null;

  constructor(
    private readonly to: Line,
    private readonly timeoutMs: number,
  ) {
    to.on('message', (m: unknown) => this.onReply(m as Reply));
    // A port's other end closed (the org worker exited or was evicted).
    to.on('close', () => this.fail(new DuckDBError('unavailable', 'the DuckDB worker went away')));
  }

  /** Calls in flight — the pool evicts only a worker with none. */
  get busy(): number {
    return this.pending.size;
  }

  call(kind: 'query' | 'exec', sql: string, params: DuckValue[], signal?: AbortSignal): Promise<string> {
    if (this.dead) return Promise.reject(this.dead);
    if (signal?.aborted) return Promise.reject(cancelled());
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      const stop = (err: DuckDBError): void => {
        if (!this.settle(id)) return;
        this.to.postMessage({ kind: 'interrupt', id });
        reject(err);
      };
      const timer = setTimeout(
        () => stop(new DuckDBError('timeout', `the query ran past ${this.timeoutMs} ms and was interrupted`)),
        this.timeoutMs,
      );
      timer.unref();
      const onAbort = signal ? (): void => stop(cancelled()) : undefined;
      if (signal && onAbort) signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      this.to.ref(); // an awaited reply holds the process open; an idle worker does not
      this.to.postMessage({ kind, sql, params, id });
    });
  }

  /** Reject everything in flight and every later call (worker exit, eviction failure). */
  fail(err: DuckDBError): void {
    this.dead ??= err;
    for (const [id, p] of this.pending) {
      this.settle(id);
      p.reject(err);
    }
  }

  private settle(id: number): Pending | null {
    const p = this.pending.get(id);
    if (!p) return null;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
    if (this.pending.size === 0) this.to.unref();
    return p;
  }

  private onReply(m: Reply): void {
    if (!m || typeof m.id !== 'number') return; // the pool's ready / init-error handshake
    const p = this.settle(m.id);
    if (!p) return; // timed out or cancelled already
    if (m.ok) p.resolve(m.text);
    else if (m.code === 'overflow') p.reject(new DuckDBError('overflow', `result of ${m.need} bytes exceeds the result ceiling (add a LIMIT or aggregate in SQL)`));
    else p.reject(new DuckDBError('query', m.message || 'DuckDB error'));
  }
}

function cancelled(): DuckDBError {
  return new DuckDBError('cancelled', 'the request was cancelled; its query was interrupted');
}
