// One warehouse call per live question, however many ask — MAIN PROCESS ONLY.
// docs/live-data/00-plan.md L2.3. Split out of ./liveQuery.ts (which asks the
// questions) when L2.4's lookup would have taken that file past 500 lines.
// The statement itself goes through ./liveWarehouse (L2.7, the one door), whose
// `LiveCallError` a hang-up rejects with.
//
// A "flight" is one warehouse call shared by every concurrent asker of the
// same question, always — even at cache age 0. It is cancelled only when EVERY
// asker has hung up: one closed tab must not fail the tile another viewer is
// waiting on. An asker that hangs up stops waiting at once.

import { LiveCallError } from './liveWarehouse';

// ── Flights: one warehouse call per question, however many ask ──────────────

interface Flight<T> {
  promise: Promise<T>;
  ctl: AbortController;
  askers: number;
}

const flights = new Map<string, Flight<unknown>>();

/**
 * Join the question in flight under `key`, or start it. Resolves with the
 * answer (a copy for every asker but the one who started it) and whether this
 * asker started it. When `signal` fires the asker leaves at once; when the
 * last asker leaves, the shared call is aborted and forgotten, so the next
 * asker starts afresh rather than joining a cancelled call.
 */
export function fly<T>(key: string, signal: AbortSignal | undefined, start: (shared: AbortSignal) => Promise<T>): Promise<{ value: T; owner: boolean }> {
  let found = flights.get(key) as Flight<T> | undefined;
  const owner = !found;
  if (!found) {
    const ctl = new AbortController();
    const fresh: Flight<T> = { promise: start(ctl.signal), ctl, askers: 0 };
    flights.set(key, fresh);
    const land = (): void => {
      if (flights.get(key) === fresh) flights.delete(key);
    };
    void fresh.promise.then(land, land);
    found = fresh;
  }
  const f = found;
  f.askers += 1;
  return new Promise((resolve, reject) => {
    let done = false;
    const leave = (): void => {
      if (done) return;
      done = true;
      f.askers -= 1;
      if (f.askers === 0) {
        if (flights.get(key) === f) flights.delete(key);
        f.ctl.abort();
      }
      reject(new LiveCallError('cancelled'));
    };
    if (signal?.aborted) {
      leave();
      return;
    }
    signal?.addEventListener('abort', leave, { once: true });
    void f.promise.then(
      (value) => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', leave);
        resolve({ value: owner ? value : structuredClone(value), owner });
      },
      (err: unknown) => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', leave);
        reject(err);
      },
    );
  });
}

/** Test hook: flights in the air (the suite checks none is left behind). */
export function flightsInAir(): number {
  return flights.size;
}
