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

import * as datasets from './datasets';
import type { AutoRefreshEvery, DatasetSummary } from './datasets';
import * as projects from './projects';
import { refreshDataset } from './datasetRefresh';
import { detectAnomalies } from './anomalies';
import { detectAnomaliesResident } from './anomaliesResident';
import { diffAnomalies } from './anomalyWatch';

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
  /** Anomalies found this run that were not there last run. App-computed; no model. */
  newAnomalies?: number;
}

type Reporter = (outcome: AutoRefreshOutcome) => void;
let report: Reporter | null = null;
/** main.ts hands over how to tell the user; this module never notifies directly. */
export function onRefreshed(fn: Reporter): void {
  report = fn;
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
      if (outcome.ok && m.autoRefresh && m.autoRefresh.watch) {
        outcome.newAnomalies = await runWatch(m.projectId, m.id, m.autoRefresh.lastAnomalyKeys);
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
  }
  return outcomes;
}

/**
 * The anomaly watch for one dataset that just refreshed successfully.
 *
 * Resident fast path first, JS reference as the fallback — the pairing this
 * codebase already uses everywhere, and for the same reason: a resident `null`
 * means "fall back", never "no anomalies".
 *
 * Returns how many findings are NEW. Zero (or a failure to read the table at
 * all) means nothing to say, which is the common case and must stay silent.
 */
async function runWatch(projectId: string, id: string, previous?: string[]): Promise<number> {
  try {
    let found = null as ReturnType<typeof detectAnomalies> | null;
    const src = await datasets.residentSource(projectId, id);
    if (src) found = detectAnomaliesResident(src);
    if (!found) {
      const ds = await datasets.getDataset(projectId, id);
      if (!ds) return 0;
      found = detectAnomalies(ds.columns, ds.rows);
    }
    const { newKeys, keep } = diffAnomalies(found, previous);
    // Store the CURRENT set even when nothing is new: a resolved anomaly has to
    // drop out, or it counts as new again the day it returns having never left.
    await datasets.setAutoRefresh(projectId, id, { lastAnomalyKeys: keep });
    return newKeys.length;
  } catch (_) {
    return 0; // a watch that throws must not take the refresh down with it
  }
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
