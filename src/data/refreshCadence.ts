// How often an unattended refresh may run, and whether it keeps up — MAIN
// PROCESS, pure: no fs, no clock (callers pass `now`).
//
// ONE table of cadences. The sanitizer (datasetRecord.ts), the scheduler's due
// rule (src/app/refreshScheduler.ts), the Pipelines page (src/app/pipelineView.ts)
// and the RPC handlers all read it, so a cadence added here is a cadence
// everywhere instead of a list that drifts.
//
// THE FAST CADENCES (L0.3, docs/live-data/00-plan.md). Every 5 or 15 minutes is
// offered only to a dataset with INCREMENTAL refresh on: a full re-fetch that
// often would hammer the source (and rewrite up to a million rows twelve times
// an hour), while an incremental run fetches only the rows past the mark. The
// rule is enforced where a schedule is written AND where one is read back, so a
// hand-edited or imported record cannot get round it.
//
// BEHIND SCHEDULE. A cadence is a promise: "this data is never more than N old".
// A scheduled run that takes longer than its own interval — waiting for a job
// slot included — breaks it, and the dataset says so instead of quietly
// falling behind. `lastAutoMs` is that run's length, written by the scheduler
// when it finishes.

import type { AutoRefresh, AutoRefreshEvery } from './datasets';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Every cadence a schedule may have, shortest first. */
export const AUTO_REFRESH_EVERY: readonly AutoRefreshEvery[] = ['5min', '15min', 'hourly', 'daily', 'weekly'];

/** How long each cadence waits between two scheduled runs. */
export const INTERVAL_MS: Readonly<Record<AutoRefreshEvery, number>> = {
  '5min': 5 * MIN,
  '15min': 15 * MIN,
  hourly: HOUR,
  daily: DAY,
  weekly: 7 * DAY,
};

/** Cadences only an incremental refresh may run at. */
const FAST: ReadonlySet<string> = new Set<AutoRefreshEvery>(['5min', '15min']);

/** A run longer than this is a stuck stamp, not a measurement (and stays a finite JSON number). */
const MAX_RUN_MS = 30 * DAY;

export function isAutoRefreshEvery(v: unknown): v is AutoRefreshEvery {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(INTERVAL_MS, v);
}

/** True for the cadences a full refresh may not run at. */
export function needsIncremental(every: unknown): boolean {
  return typeof every === 'string' && FAST.has(every);
}

/** May a dataset run on `every`, given whether its incremental refresh is on? */
export function cadenceAllowed(every: unknown, incrementalOn: boolean): every is AutoRefreshEvery {
  return isAutoRefreshEvery(every) && (incrementalOn || !needsIncremental(every));
}

/** A stored `lastAutoMs`, whitelisted: a whole, non-negative, bounded number of ms, or undefined. */
export function sanitizeRunMs(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_RUN_MS ? Math.round(v) : undefined;
}

/**
 * Did the last scheduled run take longer than the schedule's own interval?
 * Undefined `lastAutoMs` (never measured, or a record from before it existed)
 * is NOT behind: no run has been seen to be late.
 */
export function behindSchedule(auto: Pick<AutoRefresh, 'every' | 'lastAutoMs'> | undefined): boolean {
  if (!auto || !isAutoRefreshEvery(auto.every) || auto.lastAutoMs === undefined) return false;
  return auto.lastAutoMs > INTERVAL_MS[auto.every];
}

/**
 * How far past due a schedule is at `now`, in ms, or null when it is not due.
 * Never run, or an unparseable `lastAutoAt`, is infinitely overdue: a corrupt
 * stamp read as "never" lets the schedule self-heal, where read as "just ran"
 * it would silently disable it forever.
 */
export function overdueMs(auto: Pick<AutoRefresh, 'every' | 'lastAutoAt'>, now: number): number | null {
  if (!isAutoRefreshEvery(auto.every)) return null;
  const last = auto.lastAutoAt ? Date.parse(auto.lastAutoAt) : NaN;
  if (!Number.isFinite(last)) return Infinity;
  const late = now - (last + INTERVAL_MS[auto.every]);
  return late >= 0 ? late : null; // >=: a tick landing exactly on the boundary counts
}
