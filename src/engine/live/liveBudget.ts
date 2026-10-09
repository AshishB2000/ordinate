// What a Live question may cost the warehouse — MAIN PROCESS ONLY.
// docs/live-data/00-plan.md L2.3 (the hook), L2.7 (the limits), D9.
//
// Every warehouse statement the executor (./liveQuery.ts) sends passes here
// first, and nowhere else, so each limit is one function:
//
//   acquire(org, datasetId, signal)   LIVE_MAX_CONCURRENT statements in flight
//                                     per org PER POD (default 4). The next one
//                                     waits its turn, first come first served;
//                                     a caller that hangs up while waiting
//                                     leaves the queue and never reaches the
//                                     warehouse. Built here, L2.3.
//   checkDaily(org, datasetId)        THE SEAM for L2.7's per-org daily query
//                                     limit (`live_usage`, LIVE_DAILY_QUERY_LIMIT,
//                                     shared across pods through Postgres).
//                                     Always ok until then. A refusal is served
//                                     like a warehouse failure: the cached answer,
//                                     labelled stale, or the typed error carrying
//                                     `message`.
//   noteCall(org, datasetId)          THE SEAM for L2.7's usage count (one
//                                     upsert per warehouse call). A no-op now.
//   cacheAgeFloorSec()                THE SEAM for L2.7's public-page floor
//                                     (LIVE_MIN_CACHE_AGE_PUBLIC_SEC on /p/). 0 now.
//
// Per pod, on purpose: a semaphore across pods would put a Postgres round trip
// in front of every warehouse call, and the daily limit (L2.7) is what bounds
// the bill org-wide. N pods allow N × LIVE_MAX_CONCURRENT at once.

import { liveMaxConcurrent } from '../../server/env';

/** A caller stopped waiting for a slot: its signal fired (it hung up, or every asker of a shared question did). */
export class LiveQueueAbort extends Error {
  constructor() {
    super('The question was cancelled while it waited for the warehouse.');
    this.name = 'LiveQueueAbort';
  }
}

interface Waiter {
  start: () => void;
}

interface OrgSlots {
  running: number;
  queue: Waiter[];
}

const orgs = new Map<string, OrgSlots>();

/** LIVE_MAX_CONCURRENT, re-read per call (env.ts refused a bad value at startup). */
function cap(): number {
  try {
    return liveMaxConcurrent(process.env.LIVE_MAX_CONCURRENT);
  } catch {
    return liveMaxConcurrent(undefined);
  }
}

function slotsOf(org: string): OrgSlots {
  let s = orgs.get(org);
  if (!s) orgs.set(org, (s = { running: 0, queue: [] }));
  return s;
}

/** Hand freed slots to the queue, oldest first; forget an org with nothing running or waiting. */
function pump(org: string): void {
  const s = orgs.get(org);
  if (!s) return;
  while (s.running < cap() && s.queue.length) {
    s.running += 1;
    s.queue.shift()!.start();
  }
  if (s.running === 0 && s.queue.length === 0) orgs.delete(org);
}

/**
 * A slot for one warehouse statement of `org`. Resolves with its release
 * (idempotent — call it once the connector has settled, not when the caller
 * stopped waiting, or a cancelled statement still running in the warehouse
 * would not count). Rejects with LiveQueueAbort when `signal` fires first.
 */
export function acquire(org: string, _datasetId: string, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) return Promise.reject(new LiveQueueAbort());
  const s = slotsOf(org);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    s.running -= 1;
    pump(org);
  };
  if (s.running < cap() && s.queue.length === 0) {
    s.running += 1;
    return Promise.resolve(release);
  }
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      start: () => {
        signal?.removeEventListener('abort', leave);
        resolve(release);
      },
    };
    function leave(): void {
      const at = s.queue.indexOf(waiter);
      if (at >= 0) s.queue.splice(at, 1);
      pump(org);
      reject(new LiveQueueAbort());
    }
    signal?.addEventListener('abort', leave, { once: true });
    s.queue.push(waiter);
  });
}

/** In flight and waiting, per org — for a test, or a gauge one day. */
export function stats(org: string): { running: number; waiting: number } {
  const s = orgs.get(org);
  return { running: s?.running ?? 0, waiting: s?.queue.length ?? 0 };
}

/** The daily-limit seam (L2.7). `message` is a catalog sentence for the viewer. */
export type DailyCheck = { ok: true } | { ok: false; message: string };

let dailyOverride: ((org: string, datasetId: string) => DailyCheck) | null = null;

/** L2.7 replaces this body with the `live_usage` lookup; until then every org is within its day. */
export function checkDaily(org: string, datasetId: string): DailyCheck {
  return dailyOverride ? dailyOverride(org, datasetId) : { ok: true };
}

/** Test hook: stand in for L2.7's limit, so the executor's handling of a refusal is exercised now. */
export function setDailyCheckForTest(fn: ((org: string, datasetId: string) => DailyCheck) | null): void {
  dailyOverride = fn;
}

/** The usage seam (L2.7): one warehouse call made for `org`. A no-op until `live_usage` exists. */
export function noteCall(_org: string, _datasetId: string): void {
  // L2.7: upsert live_usage(org_id, day, queries + 1, bytes) — shared across pods.
}

/** The cache-age floor (L2.7: LIVE_MIN_CACHE_AGE_PUBLIC_SEC on a published page). 0 until then. */
export function cacheAgeFloorSec(): number {
  return 0;
}
