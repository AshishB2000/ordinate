// The compute pool — MAIN PROCESS. Hands one op to a compute worker
// (./computeWorker.ts) and gives back a promise, progress and cancel.
//
// Up to MAX_WORKERS threads (the same three as the jobs system runs at once),
// ONE op per thread at a time, reused while warm and closed after IDLE_MS so
// their DuckDB memory goes back. Cancel TERMINATES the thread running that op
// — an op inside a synchronous DuckDB call cannot be interrupted any other
// way — which only ever costs that one op, because a thread never holds two.
//
// When worker threads are unavailable (or `ORDINATE_COMPUTE_INLINE=1`) callers
// get `null` from `available()` and run the same code on the main thread, the
// way every resident path already falls back.

import * as path from 'path';
import { Worker } from 'worker_threads';

export const MAX_WORKERS = 3;
const IDLE_MS = 30_000;

interface Slot {
  worker: Worker;
  busy: boolean;
  idleTimer: NodeJS.Timeout | null;
}

interface Pending {
  slot: Slot;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onProgress?: (fraction: number, note?: string) => void;
}

export class ComputeCancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'JobCancelled'; // the jobs system reads a cancel by name
  }
}

const slots: Slot[] = [];
const waiting: Array<() => void> = [];
const pending = new Map<number, Pending>();
let nextId = 1;
let workerFile = path.join(__dirname, 'computeWorker.js');

export function available(): boolean {
  return process.env.ORDINATE_COMPUTE_INLINE !== '1';
}

/** Test hook: point the pool at a different worker script. */
export function setWorkerFileForTest(file: string): void {
  workerFile = file;
}

function spawn(): Slot {
  const worker = new Worker(workerFile);
  const slot: Slot = { worker, busy: false, idleTimer: null };
  worker.on('message', (msg: { id: number; type: string; fraction?: number; note?: string; result?: unknown; message?: string }) => {
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.type === 'progress') {
      if (p.onProgress) p.onProgress(Number(msg.fraction) || 0, msg.note);
      return;
    }
    pending.delete(msg.id);
    release(slot);
    if (msg.type === 'done') p.resolve(msg.result);
    else p.reject(new Error(msg.message || 'Compute failed'));
  });
  const die = (err: unknown) => {
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
    for (const [id, p] of pending) {
      if (p.slot !== slot) continue;
      pending.delete(id);
      p.reject(err instanceof Error ? err : new Error('The compute worker stopped'));
    }
    const next = waiting.shift();
    if (next) next();
  };
  worker.on('error', die);
  worker.on('exit', () => die(new Error('The compute worker stopped')));
  worker.unref();
  slots.push(slot);
  return slot;
}

function release(slot: Slot): void {
  slot.busy = false;
  slot.worker.unref();
  const next = waiting.shift();
  if (next) { next(); return; }
  if (slot.idleTimer) clearTimeout(slot.idleTimer);
  slot.idleTimer = setTimeout(() => {
    if (!slot.busy) void slot.worker.terminate();
  }, IDLE_MS);
  slot.idleTimer.unref();
}

async function acquire(): Promise<Slot> {
  for (;;) {
    const free = slots.find((s) => !s.busy);
    if (free) return claim(free);
    if (slots.length < MAX_WORKERS) return claim(spawn());
    await new Promise<void>((r) => waiting.push(r));
  }
}

function claim(slot: Slot): Slot {
  slot.busy = true;
  if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }
  slot.worker.ref(); // an op in flight keeps the process alive; an idle thread does not
  return slot;
}

/**
 * Run one op in a worker. Rejects with ComputeCancelled when `signal` aborts
 * (the worker running it is terminated), or with the op's own error.
 */
export async function run<T>(
  op: string,
  args: unknown,
  opts: { onProgress?: (fraction: number, note?: string) => void; signal?: AbortSignal } = {},
): Promise<T> {
  if (opts.signal && opts.signal.aborted) throw new ComputeCancelled();
  const slot = await acquire();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { slot, resolve: resolve as (v: unknown) => void, reject, onProgress: opts.onProgress });
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new ComputeCancelled());
        void slot.worker.terminate(); // 'exit' removes the slot and wakes a waiter
      }, { once: true });
    }
    slot.worker.postMessage({ id, op, args });
  });
}

/** Close every worker (app quit, tests). */
export async function shutdown(): Promise<void> {
  const all = slots.splice(0);
  await Promise.all(all.map((s) => s.worker.terminate()));
}
