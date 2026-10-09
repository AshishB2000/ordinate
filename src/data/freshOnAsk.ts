// Fresh on ask: pull the new rows before answering (docs/live-data/00-plan.md
// L3.1) — MAIN PROCESS, server only.
//
// `ensureFresh(projectId, datasetIds)` is the one call every figure door makes
// first — `vizDataFor` (charts, publish, export), `computeCardMetric` (KPI
// tiles, metrics, alerts), `computeStatsTile` and `computeCard` (answers) —
// BEFORE the door reads the record for its answer-cache key, so an answer that
// waited for a pull is computed over the new rows (the write moved
// `updatedAt`, the key) rather than served from the cache.
//
// For each dataset (once per request — ./freshOnAskState.ts):
//
//   1. Read the record (metadata only) and apply the pure due rule
//      (./freshOnAskRule.ts): off · fresh · full → answer from the copy now.
//   2. `due`: start ONE pull for the pod (`pulls`), then for every pod:
//        CLAIM the window — under a short advisory lock of its own (the
//        refresh lock's primitive on the key `fresh-on-ask:<id>`, never the
//        refresh lock itself), re-read the record, and unless another pod
//        stamped `freshOnAsk.triggeredAt` inside this window (or the rows
//        landed meanwhile), stamp it. With Postgres the record is a `records`
//        row and the lock is cross-pod, so exactly one pod claims a window;
//        without it there is one process, and `pulls` + the record suffice.
//        Then `startRefresh(…, { incrementalOnly })` — L0.4's single-flight
//        door: a refresh already running anywhere (a ↻, the schedule, another
//        pod) starts nothing, and is waited for instead.
//   3. `held` (a pull started inside this window): wait for this pod's pull,
//      or watch the refresh lock while any pod still refreshes it.
//   4. Wait at most FRESH_ON_ASK_WAIT_MS — counted from the request's FIRST
//      ask, for all its datasets together — and never past the request's
//      abort signal. Landed in time → the door answers over the new rows. Not
//      yet → it answers from the copy, and its `asOf` says `refreshing`
//      (./figureAsOf.ts): the pull goes on, and L0.1's push
//      (`hub:dataset-refreshed`) redraws every open tab when it lands.
//      Nothing here blocks the event loop: it awaits a promise, a timer and
//      (cross-pod) a pg_locks read every POLL_MS.
//
// WHY THE RECORD, AND NOT A TABLE OF ITS OWN, for the window. The record is
// already the cross-pod truth every check reads (it is the row the due rule
// needs anyway), so the stamp costs no extra read on the hot path and no
// migration; the claim lock turns its read-modify-write into a compare-and-set
// across pods. This pod also remembers its own starts (`triggered`, orgKey'd),
// so a stamp that could not be written still holds the window here.
//
// THE PULL RUNS DETACHED from the request that started it: as the system, in
// the org (like a scheduled refresh — no one's Jobs list, no one's tab), and in
// an async context captured when this module loaded, so it carries no
// request abort signal (a closed tab must not cancel a refresh other readers
// wait for), no display currency and no as-of scope. After it lands,
// `afterRefresh` runs as after a ↻: alerts, quality checks, republish, the SQL
// datasets built on it.

import { AsyncResource } from 'async_hooks';
import * as datasets from './datasets';
import { dataAt } from './figureAsOf';
import { asOfIso } from './asOf';
import { fullReason } from './incrementalRefresh';
import { refreshRunning, startRefresh } from './refreshJob';
import { ageMs, freshOnAskVerdict } from './freshOnAskRule';
import { stampTriggered } from './freshOnAskRecord';
import { memoKey, podKey, pulls, requestMemo, type Memo, type Outcome, type PullEnd, type RequestMemo } from './freshOnAskState';
import { isValidId } from '../app/ids';
import { ctx, runInContext, type Identity } from '../server/context';
import { withRefreshLock } from '../server/jobs/refreshLock';
import { freshOnAskWaitMs } from '../server/env';

/** How often a wait for ANOTHER pod's refresh looks at the lock. */
export const POLL_MS = 200;
/** The advisory-lock key prefix of a window's claim (src/server/jobs/refreshLock.ts `lockKey`). */
export const CLAIM_PREFIX = 'fresh-on-ask:';

const QUIET: Outcome = { refreshing: false };

/** This pod's last pull start per dataset (orgKey'd, epoch ms): the window, even if the stamp failed. */
const triggered = new Map<string, number>();

/** The async context this module loaded in: no request, no as-of read, no display currency. */
const ROOT = new AsyncResource('ordinate:fresh-on-ask');

/** FRESH_ON_ASK_WAIT_MS, re-read per ask (env.ts refused a bad value at startup). */
export function waitMs(): number {
  try {
    return freshOnAskWaitMs(process.env.FRESH_ON_ASK_WAIT_MS);
  } catch {
    return freshOnAskWaitMs(undefined);
  }
}

/**
 * Before reading these datasets for a figure: pull the new rows of every one
 * that asks for it, waiting a moment. Resolves with the ids still being pulled
 * when the wait ended (the figure then says "refreshing…"). Never throws, and
 * returns at once outside the server, inside an as-of read (the past is not
 * refreshed) and for any dataset without fresh on ask.
 */
export async function ensureFresh(projectId: string, datasetIds: ReadonlyArray<string | undefined>): Promise<{ refreshing: Set<string> }> {
  const refreshing = new Set<string>();
  if (asOfIso() !== undefined || !isValidId(projectId)) return { refreshing };
  const memo = requestMemo(waitMs());
  if (!memo) return { refreshing };
  const ids = [...new Set(datasetIds.filter((d): d is string => typeof d === 'string' && isValidId(d)))];
  const outs = await Promise.all(ids.map((id) => once(memo, projectId, id)));
  outs.forEach((o, i) => { if (o.refreshing) refreshing.add(ids[i]); });
  return { refreshing };
}

/** One check per dataset per request: later tiles share the first one's promise. */
function once(memo: RequestMemo, projectId: string, id: string): Promise<Outcome> {
  const k = memoKey(projectId, id);
  const had = memo.checks.get(k);
  if (had) return had.promise;
  const entry: Memo = {
    promise: check(projectId, id, memo.deadline).catch((): Outcome => QUIET).then((o) => {
      entry.settled = o;
      return o;
    }),
  };
  memo.checks.set(k, entry);
  return entry.promise;
}

async function check(projectId: string, id: string, deadline: number): Promise<Outcome> {
  const started = Date.now();
  const meta = await datasets.getDatasetMeta(projectId, id);
  if (!meta?.freshOnAsk || !meta.incremental?.enabled) return QUIET; // the common case: one metadata read
  const key = podKey(projectId, id);
  const verdict = freshOnAskVerdict({
    mode: meta.mode,
    freshOnAsk: meta.freshOnAsk,
    incremental: meta.incremental,
    lastRefreshedAt: meta.lastRefreshedAt,
    triggeredAtMs: latest(triggered.get(key), meta.freshOnAsk.triggeredAt),
    fullReason: fullReason(meta.incremental, meta.sourceColumns ?? meta.columns, meta.resident),
  }, started);
  if (verdict !== 'due' && verdict !== 'held') return QUIET;
  let own = pulls.get(key) ?? null;
  if (!own && verdict === 'due') own = startPull(projectId, id, key, meta.freshOnAsk.maxStalenessSec * 1000);
  const settled = await settle(projectId, id, own, deadline, ctx().signal);
  return settled ? QUIET : { refreshing: true, at: dataAt(meta) ?? undefined };
}

/** The later of this pod's start and the record's stamp, as epoch ms. */
function latest(mine: number | undefined, stamped: string | undefined): number | undefined {
  const s = stamped ? Date.parse(stamped) : NaN;
  if (mine === undefined) return Number.isFinite(s) ? s : undefined;
  return Number.isFinite(s) ? Math.max(mine, s) : mine;
}

/** Start this pod's pull of a dataset — synchronously registered, so a second ask on this pod joins it. */
function startPull(projectId: string, id: string, key: string, windowMs: number): Promise<PullEnd> {
  const now = Date.now();
  triggered.set(key, now);
  if (triggered.size > 10_000) for (const [k, t] of triggered) if (now - t > 86_400_000) triggered.delete(k);
  const org = ctx().org;
  const p: Promise<PullEnd> = detached(org, () => pull(projectId, id, windowMs)).finally(() => {
    if (pulls.get(key) === p) pulls.delete(key);
  });
  pulls.set(key, p);
  return p;
}

/** Runs `fn` as the system, in `org`, outside the asking request's async context. */
function detached<T>(org: Identity['org'], fn: () => Promise<T>): Promise<T> {
  const system: Identity = { user: { email: 'jobs@system', role: 'admin' }, org: { id: org.id } };
  return ROOT.runInAsyncScope(() => runInContext(system, `fresh-on-ask:${org.id}`, fn));
}

async function pull(projectId: string, id: string, windowMs: number): Promise<PullEnd> {
  try {
    if (!(await claim(projectId, id, windowMs))) return 'elsewhere';
    const started = await startRefresh(projectId, id, { incrementalOnly: true });
    if (started.status === 'already_running') return 'elsewhere';
    const r = await started.done;
    if (!r.ok) return r.skipped ? 'skipped' : 'failed';
    // As after a ↻ (src/ipc/datasets.ts): alerts, quality, republish, dependents. Not awaited by anyone asking.
    void (require('../ipc/datasets') as typeof import('../ipc/datasets')).afterRefresh(projectId, id).catch(() => undefined);
    return 'landed';
  } catch {
    return 'failed';
  }
}

/** Claim this window for this pod — the cross-pod compare-and-set described above. */
async function claim(projectId: string, id: string, windowMs: number): Promise<boolean> {
  const got = await withRefreshLock(CLAIM_PREFIX + id, async () => {
    const meta = await datasets.getDatasetMeta(projectId, id);
    const fo = meta?.freshOnAsk;
    if (!meta || !fo) return false;
    const now = Date.now();
    if (ageMs(meta.lastRefreshedAt, now) < windowMs) return false; // landed meanwhile
    const prev = fo.triggeredAt ? Date.parse(fo.triggeredAt) : NaN;
    if (Number.isFinite(prev) && now - prev < windowMs) return false; // another pod claimed this window
    return stampTriggered(projectId, id, new Date(now).toISOString());
  });
  return got.ran && got.value;
}

/**
 * Wait for a pull until `deadline`: this pod's own (when there is one), then —
 * when it turned out to be another pod's or a ↻ — the refresh lock. True when
 * nothing is pulling any more (landed, failed, or never ran), false when the
 * time ran out or the asker went away.
 */
async function settle(projectId: string, id: string, own: Promise<PullEnd> | null, deadline: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (own) {
    const end = await until(own, deadline, signal);
    if (end === TIMEOUT) return false;
    if (end !== 'elsewhere') return true;
  }
  for (;;) {
    if (!(await refreshRunning(projectId, id).catch(() => null))) return true;
    if (Date.now() >= deadline || signal?.aborted) return false;
    await until(null, Math.min(deadline, Date.now() + POLL_MS), signal);
  }
}

const TIMEOUT = Symbol('timeout');

/** `p`'s value, or TIMEOUT at `deadline` or on abort — whichever first; the timer and listener are always cleared. */
function until<T>(p: Promise<T> | null, deadline: number, signal: AbortSignal | undefined): Promise<T | typeof TIMEOUT> {
  const left = deadline - Date.now();
  if (signal?.aborted || (left <= 0 && !p)) return Promise.resolve(TIMEOUT);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: T | typeof TIMEOUT): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(v);
    };
    const onAbort = (): void => finish(TIMEOUT);
    const timer = setTimeout(() => finish(TIMEOUT), Math.max(0, left));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (p) p.then(finish, () => finish(TIMEOUT));
  });
}
