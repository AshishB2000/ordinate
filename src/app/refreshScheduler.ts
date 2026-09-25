// Unattended dataset refresh — MAIN PROCESS ONLY.
//
// THE HONEST CONSTRAINT, and it is stated in the UI too: Ordinate is a desktop
// app with no daemon. A schedule fires while the app is RUNNING. Anything that
// came due while it was closed catches up on the next launch, because the first
// tick after start finds it overdue like any other — there is deliberately no
// special "catch-up" path to keep correct.
//
// This module CALLS datasetRefresh and changes nothing inside it: the pipeline
// preservation, the never-destroy-data-on-failure rule and the combined/composed
// cycle guard are all already right there, and a second copy of any of them
// would be a second thing to keep right.
//
// Two properties the tick must hold, both about not freezing the app:
//
//   1. STRICTLY SERIAL. Refreshes run one after another, never in parallel, and
//      a tick that arrives while the previous one is still working is skipped
//      outright (`running`). Overlapping refreshes would contend on the same
//      records and could interleave two writes to one file.
//   2. ASYNC PATHS ONLY. A blocking DuckDB call freezes every window, the menu
//      bar and the hotkey. Nothing here blocks: it reads metadata, and
//      refreshDataset is itself async.
//
// The DUE CHECK is a pure exported function taking `now`, so it can be tested
// directly rather than by waiting for wall-clock time to pass.

import * as datasets from '../data/datasets';
import type { AutoRefreshEvery, DatasetSummary } from '../data/datasets';
import * as projects from './projects';
import { refreshDataset } from '../data/datasetRefresh';
import { refreshDependents } from '../data/datasetDependents';
import type { AlertEvent } from '../analysis/alerts';
// Imported, not injected like the alert hook: it decides nothing about WHEN and
// notifies no one itself — its events join this tick's batch below.
import { runQualityChecks } from '../analysis/qualityRun';

/** How often the tick looks for work. The schedules themselves are hours apart. */
const TICK_MS = 60_000;

const INTERVAL_MS: Record<AutoRefreshEvery, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

/** One dataset the scheduler may act on, as the enumeration sees it. */
export interface ScheduledMeta {
  projectId: string;
  id: string;
  name: string;
  originKind?: DatasetSummary['originKind'];
  autoRefresh?: DatasetSummary['autoRefresh'];
}

/**
 * Which of these are due at `now` — pure, and the whole scheduling rule.
 *
 * `now` is a parameter on purpose: nothing in src/ should call Date.now() inside
 * logic a test wants to pin.
 *
 * A dataset that has NEVER run is due immediately. So is one whose `lastAutoAt`
 * is unparseable — treating a corrupt stamp as "never" makes the schedule
 * self-heal, where treating it as "just ran" would silently disable the
 * schedule forever.
 */
export function dueDatasets<T extends ScheduledMeta>(metas: T[], now: number): T[] {
  const out: T[] = [];
  for (const m of Array.isArray(metas) ? metas : []) {
    const auto = m && m.autoRefresh;
    if (!auto || !INTERVAL_MS[auto.every]) continue;
    // Belt and braces: datasets.sanitizeAutoRefresh already drops a schedule
    // from a record with no origin, so this only catches a caller that built a
    // meta by hand.
    if (!m.originKind) continue;
    if (!auto.lastAutoAt) { out.push(m); continue; }
    const last = Date.parse(auto.lastAutoAt);
    if (!Number.isFinite(last)) { out.push(m); continue; }
    if (now - last >= INTERVAL_MS[auto.every]) out.push(m);
  }
  return out;
}

/** Every scheduled dataset across every project, metadata only. */
export async function scheduledMetas(): Promise<ScheduledMeta[]> {
  const out: ScheduledMeta[] = [];
  let list: Array<{ id: string }> = [];
  try {
    list = await projects.listProjects();
  } catch (_) {
    return out;
  }
  for (const p of list) {
    let summaries: DatasetSummary[] = [];
    try {
      summaries = await datasets.listDatasets(p.id);
    } catch (_) {
      continue; // one unreadable project must not stop the rest
    }
    for (const s of summaries) {
      if (!s.autoRefresh) continue;
      out.push({ projectId: p.id, id: s.id, name: s.name, originKind: s.originKind, autoRefresh: s.autoRefresh });
    }
  }
  return out;
}

/** What one auto-refresh did, for the caller that reports it. */
export interface AutoRefreshOutcome {
  projectId: string;
  datasetId: string;
  name: string;
  ok: boolean;
  error?: string;
  rowsBefore: number;
  rowsAfter: number;
  /** Alert rules on this dataset that fired this run. App-computed; no model. */
  alertsFired?: number;
}

type Reporter = (outcome: AutoRefreshOutcome) => void;
let report: Reporter | null = null;
/** main.ts hands over how to tell the user; this module never notifies directly. */
export function onRefreshed(fn: Reporter): void {
  report = fn;
}

/**
 * Ride-along work for the END of a tick, after every due refresh has finished.
 *
 * ONE hook, and it deliberately takes no arguments and returns nothing: this is
 * "the refresh pass is done", not a second scheduler. Scheduled reports use it
 * because a report prints figures and must be generated after the data under it
 * has moved — which only holds if there is one tick, in one order, not two
 * timers racing. It fires on EVERY tick, including one that refreshed nothing,
 * because a report's own cadence is independent of any dataset's.
 *
 * NOT the same thing as `onTickAlerts` below, and the difference is the whole
 * reason both exist: this one answers "the pass is over" and carries nothing,
 * so a report can run on its own cadence. That one answers "here is what fired"
 * and carries the events, because a digest cannot be built without them.
 */
type AfterTick = () => void;
// A list, not a slot: reports and the Trash purge (src/ipc/trash.ts) both ride
// the tick, and a second caller must not silently unhook the first.
const afterTickFns: AfterTick[] = [];
export function afterTick(fn: AfterTick): void {
  afterTickFns.push(fn);
}

/**
 * THE ALERT HOOK — the one thing this module gained when alerts landed.
 *
 * Set by main.ts to `alertStore.evaluateProject`, and AWAITED inside the tick
 * rather than fired off beside it. Awaiting is what makes "one digest per
 * refresh tick" possible: the tick knows when every rule has been considered,
 * and a caller that dispatched evaluation and moved on would have no such
 * moment to batch at.
 *
 * It replaced `runWatch`, which was a second, parallel notification path for the
 * one question "did something change that I care about". An `anomaly` rule now
 * answers that question, `alertStore.syncWatchRules` turns the existing
 * per-dataset watch toggle into one, and there is a single mechanism again.
 *
 * Injected, not imported, for the reason every hook in this file is: the
 * scheduler's job is deciding WHEN, and a module that also decided what to say
 * would be two jobs (and, here, a cycle back through the IPC layer).
 */
type Evaluator = (projectId: string, datasetId: string) => Promise<AlertEvent[]>;
let evaluate: Evaluator | null = null;
export function onEvaluateAlerts(fn: Evaluator): void {
  evaluate = fn;
}

/**
 * Everything the tick fired, once, grouped by project — the batching point the
 * "digest instead of individual" option needs.
 *
 * The evaluator deliberately does NOT notify; it only decides. Delivery happens
 * here, after the last dataset, so a tick that refreshed four datasets and fired
 * six rules can be one banner instead of six.
 */
export interface TickAlerts { projectId: string; events: AlertEvent[] }
type TickReporter = (batches: TickAlerts[]) => void;
let reportTick: TickReporter | null = null;
export function onTickAlerts(fn: TickReporter): void {
  reportTick = fn;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
/** The master switch, read from config on every tick by the callback main sets. */
let enabled: () => boolean = () => true;
export function setEnabledCheck(fn: () => boolean): void {
  enabled = fn;
}

/**
 * One pass. Exported so a test — and the real-app walk — can force it without
 * waiting a minute.
 */
export async function tickNow(now = Date.now()): Promise<AutoRefreshOutcome[]> {
  const outcomes: AutoRefreshOutcome[] = [];
  const byProject = new Map<string, AlertEvent[]>();
  if (running) return outcomes; // the previous tick is still working
  running = true;
  try {
    if (!enabled()) return outcomes;
    const due = dueDatasets(await scheduledMetas(), now);
    for (const m of due) {
      // Stamp FIRST, win or lose. A source that is failing then waits its whole
      // interval instead of retrying every 60 seconds; the failure itself stays
      // visible in lastRefreshStatus, which is where the row reads it.
      await datasets.setAutoRefresh(m.projectId, m.id, { lastAutoAt: new Date(now).toISOString() });
      const before = await datasets.getDatasetMeta(m.projectId, m.id);
      const res = await refreshDataset(m.projectId, m.id);
      const after = await datasets.getDatasetMeta(m.projectId, m.id);
      const outcome: AutoRefreshOutcome = {
        projectId: m.projectId,
        datasetId: m.id,
        name: m.name,
        ok: Boolean(res && res.ok),
        rowsBefore: (before && before.rowCount) || 0,
        rowsAfter: (after && after.rowCount) || 0,
      };
      if (!outcome.ok) outcome.error = (res as any).error || 'Refresh failed.';
      // AWAITED, unlike the IPC call sites: the tick is strictly serial, and
      // a dependent re-run is part of this refresh's work. Never rejects.
      else await refreshDependents(m.projectId, m.id);
      // The alert pass runs on FRESH data, which is why it is here rather than
      // in the reporter: a rule evaluated before the refresh landed would be
      // reporting yesterday's number as today's.
      if (outcome.ok && evaluate) {
        try {
          const fired = await evaluate(m.projectId, m.id);
          outcome.alertsFired = fired.length;
          if (fired.length) {
            const bucket = byProject.get(m.projectId) || [];
            for (const e of fired) bucket.push(e);
            byProject.set(m.projectId, bucket);
          }
        } catch (_) {
          // An evaluation that throws must not take the refresh down with it.
        }
      }
      // Data-quality rules, on the same fresh data. Recorded now, DELIVERED with
      // the tick's batch, so the digest option covers them too. Never throws.
      if (outcome.ok) {
        const dq = await runQualityChecks(m.projectId, m.id, { deliver: false });
        if (dq.length) byProject.set(m.projectId, (byProject.get(m.projectId) || []).concat(dq));
      }
      outcomes.push(outcome);
      if (report) {
        try { report(outcome); } catch (_) { /* a reporter must never stop the loop */ }
      }
    }
  } catch (_) {
    // A scheduler that throws is a scheduler that stops. Swallow and try again
    // next minute.
  } finally {
    running = false;
    // In the `finally`, and AFTER `running` is cleared, so it fires on every
    // path a tick can leave by — including the `!enabled()` return above. That
    // is deliberate: the master switch turns off unattended DATASET REFRESH,
    // and a report schedule is a different promise to the user. Its own failure
    // is swallowed here for the same reason every other callback's is.
    for (const fn of afterTickFns) {
      try { fn(); } catch (_) { /* a ride-along must never stop the loop */ }
    }
  }
  // AFTER the loop, and only once: this is the batching point the digest option
  // needs. Outside the try/finally on purpose — `running` is already cleared, so
  // a throwing reporter cannot wedge the scheduler.
  if (reportTick && byProject.size) {
    const batches = Array.from(byProject, ([projectId, events]) => ({ projectId, events }));
    try { reportTick(batches); } catch (_) { /* a reporter must never stop the tick */ }
  }
  return outcomes;
}

export function start(): void {
  if (timer) return;
  // No immediate first tick: launch is already busy, and anything overdue is
  // still overdue 60 seconds later.
  timer = setInterval(() => { void tickNow(); }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stop(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
