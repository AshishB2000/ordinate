// What this request and this pod know about fresh-on-ask pulls
// (docs/live-data/00-plan.md L3.1) — MAIN PROCESS. Kept apart from
// ./freshOnAsk.ts (which starts and waits for pulls) so the figure stamp
// (./figureAsOf.ts) can read it without loading the refresh machinery.
//
// PER REQUEST. Every door that reads a dataset for a figure — a chart, a KPI,
// a statistics tile, an answer — asks `ensureFresh` first, so one dashboard
// load (one `analysis:tiles` batch of N tiles) would ask N times. The answer is
// memoised on the request's own context object (`ctx()`, a new object per
// request, so a WeakMap entry dies with it): the first tile of a dataset
// checks it, every other tile of that dataset in the same request shares the
// same promise — one metadata read, one pull, one wait.
//
// PER POD. `pulls` holds the pulls THIS pod started and has not seen land,
// keyed with orgKey() (record ids repeat across orgs after an import). A second
// request asking while one is in flight joins it rather than starting another.
//
// Only on the server: outside server mode there is no request to memoise on
// (`ctx()` is one fixed desktop context), no job queue shared with readers and
// no push, so fresh on ask does nothing there.

import type { AsOf } from '../api/asOf';
import { ctx, orgKey, serverDataDir } from '../server/context';

/** How one dataset stood for one request once its check settled. */
export interface Outcome {
  /** The figure is read from the copy while a newer one is still being pulled. */
  refreshing: boolean;
  /** When refreshing: the copy's time as the check saw it (ISO) — what the figure was read from. */
  at?: string;
}

export interface Memo {
  promise: Promise<Outcome>;
  settled?: Outcome;
}

/** One request's checks, and the one deadline they share. */
export interface RequestMemo {
  /** Epoch ms: no check of this request waits past it — FRESH_ON_ASK_WAIT_MS from its first ask, in all. */
  deadline: number;
  checks: Map<string, Memo>;
}

/** How a pull this pod started ended. `elsewhere`: another pod (or a ↻ / schedule) is refreshing it instead. */
export type PullEnd = 'landed' | 'failed' | 'skipped' | 'elsewhere';

const perRequest = new WeakMap<object, RequestMemo>();

/** This pod's pulls in flight, by orgKey(projectId/datasetId). */
export const pulls = new Map<string, Promise<PullEnd>>();

/** The key of a dataset in this pod's maps (caller's org). */
export function podKey(projectId: string, datasetId: string): string {
  return orgKey(projectId + '/' + datasetId);
}

/** The memo key of a dataset inside one request (a request is one org). */
export const memoKey = (projectId: string, datasetId: string): string => projectId + '/' + datasetId;

/**
 * The current request's memo, created on first use with its deadline
 * `waitMs` from now — or null where fresh on ask does not run: outside server
 * mode, or on the server outside a request. One deadline per request, so a
 * request that asks several datasets one after another (a join, a preview)
 * never waits longer in all than one ask may.
 */
export function requestMemo(waitMs?: number): RequestMemo | null {
  if (serverDataDir() === null) return null;
  let c: object;
  try {
    c = ctx();
  } catch {
    return null;
  }
  let m = perRequest.get(c) ?? null;
  if (!m && waitMs !== undefined) {
    m = { deadline: Date.now() + waitMs, checks: new Map() };
    perRequest.set(c, m);
  }
  return m;
}

/**
 * `asOf` with `refreshing: true` when a dataset under the figure is being
 * pulled — as this request's check found it, or, for a dataset this request
 * never checked, while this pod's own pull of it is in flight. Refreshing
 * moves `at` back to the copy the check saw when the stamp's fresher read
 * raced a landing pull: a caption may understate freshness, never overstate
 * it. PURE apart from reading the two maps.
 */
export function withPulls(asOf: AsOf, projectId: string, datasetIds: ReadonlyArray<string | undefined>): AsOf {
  const memo = requestMemo();
  if (!memo && serverDataDir() === null) return asOf;
  let refreshing = false;
  let at = asOf.at;
  for (const id of datasetIds) {
    if (typeof id !== 'string' || id === '') continue;
    const o = memo?.checks.get(memoKey(projectId, id))?.settled;
    if (o) {
      if (!o.refreshing) continue;
      refreshing = true;
      if (o.at && o.at < at) at = o.at;
      continue;
    }
    try {
      if (pulls.has(podKey(projectId, id))) refreshing = true;
    } catch {
      // outside a request: no org to key by, nothing in flight for it
    }
  }
  return refreshing ? { ...asOf, at, refreshing: true } : asOf;
}
