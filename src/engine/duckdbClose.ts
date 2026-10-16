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

// Every DuckDB worker started on this thread, until its 'exit'.
const alive = new Set<Worker>();

/** Count `w` as a DuckDB worker until it exits, so `closeEvery()` waits for it. */
export function track(w: Worker): void {
  alive.add(w);
  w.once('exit', () => alive.delete(w));
}

/** Ask `w` to exit through its own queue, and hold the event loop open until it has (bounded). */
export function closeWorker(w: Worker): void {
  try {
    w.postMessage({ kind: 'close' });
  } catch {
    void w.terminate(); // port already gone ⇒ nothing native can be in flight
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
 * Close every tracked worker and resolve once each has EXITED — busy, idle,
 * starting, or already asked to close. A second close behind an earlier one is
 * never read: the first one exits.
 */
export function closeEvery(): Promise<void> {
  // Held open by a timer, not only the workers' refs: a pool worker's DuckClient
  // unrefs it when its last reply lands. Bounded like closeWorker.
  const hold = setTimeout(() => undefined, GIVE_UP_MS);
  return Promise.all(
    [...alive].map((w) => new Promise<void>((resolve) => {
      w.once('exit', () => resolve());
      closeWorker(w);
    })),
  ).then(() => clearTimeout(hold));
}
