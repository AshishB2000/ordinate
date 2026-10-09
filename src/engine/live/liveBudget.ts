// What a Live question may cost the warehouse — MAIN PROCESS ONLY.
// docs/live-data/00-plan.md L2.3 (the hook), L2.7 (the limits), D9, R-L2.
//
// Every warehouse statement the executor (./liveQuery.ts) sends passes here
// first, and nowhere else, so each limit is one function:
//
//   acquire(org, datasetId, signal)   LIVE_MAX_CONCURRENT statements in flight
//                                     per org PER POD (default 4). The next one
//                                     waits its turn, first come first served;
//                                     a caller that hangs up while waiting
//                                     leaves the queue and never reaches the
//                                     warehouse. L2.3.
//   checkDaily(use)                   LIVE_DAILY_QUERY_LIMIT per org per UTC day
//                                     (default 10,000; 0 = none), shared across
//                                     pods through Postgres (`live_usage`,
//                                     src/server/live/usageStore.ts). ADMITTING
//                                     A STATEMENT COUNTS IT, in one step, so N
//                                     pods cannot all pass at limit − 1. Asked
//                                     once a slot is held, so a question that
//                                     hangs up in the queue is never counted.
//                                     A refusal is served like a warehouse
//                                     failure: the cached answer, labelled
//                                     stale, or the typed error carrying
//                                     `message`; the org's first refusal of the
//                                     day tells its admins (../../server/live/
//                                     limitNotice.ts). L2.7.
//   noteCall(ticket, bytes)           the bytes the warehouse reported billing
//                                     for an admitted statement (BigQuery; null
//                                     elsewhere), added to its usage row. L2.7.
//   cacheAgeFloorSec()                LIVE_MIN_CACHE_AGE_PUBLIC_SEC (default 60)
//                                     inside a published /p/ page's request,
//                                     else 0: the least age a figure may have
//                                     there, whatever the dataset's own. L2.7.
//
// Per pod, on purpose: a semaphore across pods would put a Postgres round trip
// in front of every warehouse call, and the daily limit is what bounds the
// bill org-wide. N pods allow N × LIVE_MAX_CONCURRENT at once.

import { isPublishedRequest } from '../../server/context';
import { liveDailyQueryLimit, liveMaxConcurrent, liveMinCacheAgePublicSec } from '../../server/liveEnv';
import * as usage from '../../server/live/usageStore';
import type { Ticket, UsageKey } from '../../server/live/usageStore';
import { safeError } from '../../connectors/types';
import * as msg from '../liveQueryMessages';

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

/** Whose statement is asking to be sent: the org, the connection it goes through (and its project), the dataset. */
export interface UsageOf extends UsageKey {
  readonly org: string;
  readonly datasetId: string;
}

/** Admitted (and counted: `ticket` takes its bytes), or refused with a catalog sentence for the viewer. */
export type DailyCheck = { ok: true; ticket?: Ticket } | { ok: false; message: string };

type DailyOverride = (org: string, datasetId: string) => DailyCheck | Promise<DailyCheck>;
let dailyOverride: DailyOverride | null = null;

/** LIVE_DAILY_QUERY_LIMIT, re-read per statement (env.ts refused a bad value at startup). */
export function dailyLimit(): number {
  try {
    return liveDailyQueryLimit(process.env.LIVE_DAILY_QUERY_LIMIT);
  } catch {
    return liveDailyQueryLimit(undefined);
  }
}

/**
 * Admit one statement under the org's daily limit — counting it — or refuse
 * it (counting the refusal). Throws when the count cannot be written (Postgres
 * down): the executor then serves the stale answer or a typed failure, never
 * an uncounted statement.
 */
export async function checkDaily(use: UsageOf): Promise<DailyCheck> {
  if (dailyOverride) return dailyOverride(use.org, use.datasetId);
  const limit = dailyLimit();
  const a = await usage.admit(usage.liveUsageDb()?.pool ?? null, use, limit);
  if (a.admitted) return { ok: true, ticket: a.ticket };
  if (a.first) {
    // Lazy: the push loads server delivery, which a plain self-check of the executor never needs.
    const notice = require('../../server/live/limitNotice') as typeof import('../../server/live/limitNotice');
    void notice.tellAdmins(use.org, { day: a.day, limit });
  }
  return { ok: false, message: msg.liveDailyLimit(limit.toLocaleString('en-US')) };
}

/** Test hook: stand in for the limit, so the executor's handling of a refusal is exercised without a count. */
export function setDailyCheckForTest(fn: DailyOverride | null): void {
  dailyOverride = fn;
}

/**
 * An admitted statement settled. `bytes`: what the warehouse reported billing
 * (BigQuery), else undefined — nothing is guessed. Never throws or waits: a
 * byte count that cannot be written is logged, the figure is not held up.
 */
export function noteCall(ticket: Ticket | undefined, bytes: number | undefined): void {
  if (!ticket || bytes === undefined) return;
  void usage.addBytes(ticket, bytes).catch((err: unknown) => {
    console.warn(`[live] usage: ${bytes} bytes of org ${ticket.org} not recorded — ${safeError(err)}`);
  });
}

/** LIVE_MIN_CACHE_AGE_PUBLIC_SEC, re-read per question (env.ts refused a bad value at startup). */
export function publicFloorSec(): number {
  try {
    return liveMinCacheAgePublicSec(process.env.LIVE_MIN_CACHE_AGE_PUBLIC_SEC);
  } catch {
    return liveMinCacheAgePublicSec(undefined);
  }
}

/** The least age a figure may have for THIS request: the public floor on a /p/ page's request, else 0. */
export function cacheAgeFloorSec(): number {
  return isPublishedRequest() ? publicFloorSec() : 0;
}
