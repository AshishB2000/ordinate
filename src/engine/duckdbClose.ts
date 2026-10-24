// Closing a DuckDB worker — the one safe way — and waiting for every one before
// the process exits. Used by the bridge (./duckdb.ts) and the per-org pool
// (./duckdbPool.ts), for the workers they start on their own thread.
//
// ⚠ Tearing a worker down from outside — `Worker.terminate()`, or the process
//   exiting around it — ABORTS THE PROCESS with `libc++abi: terminating due to
//   uncaught exception of type Napi::Error`, not a catchable JS error:
//   • with an `@duckdb/node-api` call in flight: every time (40/40; the
//     binding's completion callback lands in a torn-down N-API environment);
//   • with the worker IDLE, every reply received: sometimes — test-geoAgg run
//     280 times 16 at a time aborted 33 times exiting around its idle worker,
//     19 times terminating it first, 0 times closing it through the queue and
//     waiting for 'exit'. CI saw it as a suite that failed after its last check.
// So a worker is only ever ASKED to exit, through its own serialized queue: the
// close runs after every queued call has settled, and the worker leaves on its
// own (duckdbWorker `closeNow`) — the one exit measured safe. There is
// deliberately NO terminate backstop — a worker wedged badly enough to ignore
// the request is exactly the worker that terminating would abort on. It is left
// orphaned and unref'ed, so it holds nothing open and dies with the process.
// Leaking one thread in a pathological case beats aborting the app.
// Consequence worth knowing: a FILE-backed database restarted immediately after
// a close may briefly race the old worker for the file lock. The app uses
// ':memory:' plus `read_parquet`, so this is theoretical today.

import type { Worker } from 'worker_threads';

// The bridge's per-call ceiling: past it a worker is wedged and waiting buys nothing.
const GIVE_UP_MS = 120_000;

// Every DuckDB worker started on this thread, until its 'exit', with what it
// serves (an org id, the readiness probe, or the bridge) for the shutdown log.
const alive = new Map<Worker, string>();

/** Count `w` as a DuckDB worker until it exits, so `closeEvery()` waits for it. */
export function track(w: Worker, label = 'bridge'): void {
  alive.set(w, label);
  w.once('exit', () => alive.delete(w));
}

/**
 * Server shutdown: ask every tracked worker to stop — its running call is
 * interrupted and every queued call skipped, at once, not through its queue
 * (duckdbWorker `stopAll`). The worker stays alive until it is closed.
 */
export function stopEvery(): void {
  for (const w of alive.keys()) {
    try {
      w.postMessage({ kind: 'stop' });
    } catch {
      /* already gone */
    }
  }
}

/** Ask `w` to exit through its own queue, and hold the event loop open until it has (bounded). */
export function closeWorker(w: Worker): void {
  try {
    w.postMessage({ kind: 'close' });
  } catch {
    // The port is gone, so the worker is exiting on its own. Never `terminate()`:
    // that is the abort this module exists to avoid.
    return;
  }
  // An `unref`ed orphan is NOT enough: the process ending around it aborts as
  // `terminate()` does. We asked it to leave; we wait for it to leave.
  w.ref();
  const giveUp = setTimeout(() => w.unref(), GIVE_UP_MS);
  giveUp.unref();
  w.once('exit', () => clearTimeout(giveUp));
}

/**
 * Close every tracked worker — busy, idle, starting, or already asked to
 * close — and resolve once each has EXITED, or at `deadlineAt`, with the labels
 * of the workers still alive then (none: every one is gone). A second close
 * behind an earlier one is never read: the first one exits. A survivor stays
 * ref'd (closeWorker): the caller decides what to do; it never terminates one.
 */
export function closeEvery(deadlineAt = Date.now() + GIVE_UP_MS): Promise<string[]> {
  const left = Math.max(0, deadlineAt - Date.now());
  const exits = [...alive.keys()].map((w) => new Promise<void>((resolve) => {
    w.once('exit', () => resolve());
    closeWorker(w);
  }));
  return new Promise((resolve) => {
    // Held open by this timer too, not only the workers' refs: a pool worker's
    // DuckClient unrefs it when its last reply lands.
    const cap = setTimeout(() => resolve([...alive.values()]), left);
    void Promise.all(exits).then(() => {
      clearTimeout(cap);
      resolve([]);
    });
  });
}
