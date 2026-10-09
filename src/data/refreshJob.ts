// A dataset refresh, run as a background job — MAIN PROCESS.
//
// The ONE wrapper both refresh doors use: the Data row / dashboard ↻ (IPC
// `dataset:refresh`) and the unattended scheduler (src/app/refreshScheduler).
// A job gives the refresh a row in the Jobs popover, Cancel, a notification
// when it lands behind an unfocused window, and the per-dataset lock — a
// scheduled refresh and a click on ↻ for the same dataset queue instead of
// racing each other's Parquet write. The write itself reports its progress to
// the job (datasets.persist reads jobs.current()).
//
// ACROSS PODS (L0.4). With Postgres, the job's run holds the dataset's advisory
// lock (src/server/jobs/refreshLock.ts) for the length of the refresh. A run
// that finds it held — another pod is refreshing the same dataset — starts
// nothing and resolves `{ ok: false, alreadyRunning: true }`: the job ends
// `done` with that line, not as a failure, because the data IS being refreshed.
//
// `startRefresh` is the door for callers that must not queue a second refresh
// behind a first (the refresh URL L0.5, fresh-on-ask L3.1, the scheduler): it
// asks first — a job on this pod, a direct refresh in flight here, the lock on
// any pod — and only then queues. The lock inside the job still decides, so a
// race between two pods asking at the same instant runs the refresh once.
//
// A success is ANNOUNCED here (./refreshEvents, L0.1), once, whichever door it
// came through, so every open tab of a reader redraws what reads the dataset.

import * as jobs from '../app/jobs';
import * as datasets from './datasets';
import { refreshDataset, refreshInFlight } from './datasetRefresh';
import type { RefreshMode, RefreshResult } from './datasetRefresh';
import { refreshAlreadyRunning } from './refreshMessages';
import { ctx, serverDataDir } from '../server/context';
import { refreshLockHeld, withRefreshLock } from '../server/jobs/refreshLock';
import { announceRefreshed } from './refreshEvents';

/** What `startRefresh` did: queued a job, or found one running and started nothing. */
export type RefreshStart =
  | { status: 'queued'; jobId: string; done: Promise<RefreshResult> }
  /** `jobId` names the running job when it is on THIS pod; another pod's has no id here. */
  | { status: 'already_running'; jobId?: string };

/** The job's row label: "Refresh Orders", "Scheduled refresh · Orders". */
export async function refreshLabel(projectId: string, id: string, scheduled = false): Promise<string> {
  const meta = await datasets.getDatasetMeta(projectId, id);
  return (scheduled ? 'Scheduled refresh · ' : 'Refresh ') + (meta ? meta.name : 'dataset');
}

/**
 * Queue a refresh job, synchronously — so a caller that checked "nothing is
 * running" a statement earlier cannot be overtaken by another on this pod.
 * `done` never rejects: a cancel or an error is `{ok:false}`.
 */
export function queueRefresh(projectId: string, id: string, label: string, mode: RefreshMode = 'any'): { id: string; done: Promise<RefreshResult> } {
  let before: { name: string; rowCount: number } | null = null; // read under the lock, for the announcement
  const job = jobs.submit<RefreshResult>({
    kind: 'refresh',
    label,
    projectId,
    datasetId: id,
    run: async (jctx) => {
      const locked = await withRefreshLock(id, async () => {
        const meta = await datasets.getDatasetMeta(projectId, id);
        before = meta ? { name: meta.name, rowCount: meta.rowCount } : null;
        jctx.progress(0.05, 'Fetching the source');
        return refreshDataset(projectId, id, undefined, mode);
      });
      if (!locked.ran) return { ok: false, error: refreshAlreadyRunning(), alreadyRunning: true };
      const r = locked.value;
      if (!r.ok && r.skipped) return r; // incremental only, and a full run was due: nothing ran — not a failure
      if (!r.ok) throw new Error(r.error);
      return r;
    },
    resultOf: (r) => r.ok
      ? {
        message: `${Number(r.dataset && r.dataset.rowCount || 0).toLocaleString('en-US')} rows` +
          (r.warnings.length ? ` · ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}` : ''),
      }
      : { message: r.error }, // coalesced or skipped: the job did its part by starting nothing
  });
  const done = job.done.then(
    (res) => {
      // After the job, not inside it: the table and its markers are both written by now.
      if (res.ok) announceRefreshed({ projectId, datasetId: id, name: before?.name ?? 'dataset', rowsBefore: before?.rowCount ?? 0, rowsAfter: res.dataset.rowCount });
      return res;
    },
    (err: any): RefreshResult => ( // any: whatever run() threw
      { ok: false, error: err instanceof jobs.JobCancelled ? 'Cancelled.' : (err?.message || 'Refresh failed') }));
  return { id: job.id, done };
}

/** Refresh through the jobs system, queued behind any refresh of it on this pod. Never throws. */
export async function refreshAsJob(projectId: string, id: string, opts: { scheduled?: boolean } = {}): Promise<RefreshResult> {
  return queueRefresh(projectId, id, await refreshLabel(projectId, id, opts.scheduled)).done;
}

/** The caller's org as a job's owner carries it, or undefined outside the server. */
function currentOrg(): string | undefined {
  return serverDataDir() === null ? undefined : ctx().org.id;
}

/** A refresh of this dataset in THIS process: `{ jobId }` for a queued or running job, `{}` for a direct call. */
function localRefresh(projectId: string, id: string): { jobId?: string } | null {
  const org = currentOrg();
  const job = jobs.snapshot().active.find((j) =>
    j.kind === 'refresh' && j.projectId === projectId && j.datasetId === id && (org === undefined || j.owner?.split('\n')[0] === org));
  if (job) return { jobId: job.id };
  return refreshInFlight(projectId, id) ? {} : null;
}

/** Is a refresh of this dataset running anywhere — this pod (see localRefresh), or the lock held by any pod? */
export async function refreshRunning(projectId: string, id: string): Promise<{ jobId?: string } | null> {
  return localRefresh(projectId, id) ?? ((await refreshLockHeld(id)) ? {} : null);
}

/**
 * Start a refresh unless one of this dataset is running anywhere, and say
 * which (L0.4). The door for the refresh URL (L0.5) and fresh-on-ask (L3.1).
 * `incrementalOnly` (fresh on ask): the job may run an incremental refresh and
 * nothing else — one that would be full ends `skipped` (datasetRefresh RefreshMode).
 */
export async function startRefresh(projectId: string, id: string, opts: { scheduled?: boolean; incrementalOnly?: boolean } = {}): Promise<RefreshStart> {
  const label = await refreshLabel(projectId, id, opts.scheduled);
  const running = await refreshRunning(projectId, id);
  // Re-asked with no await between the answer and the submit: two callers on
  // this pod cannot both pass. Across pods the lock in the job decides.
  const here = running ?? localRefresh(projectId, id);
  if (here) return { status: 'already_running', ...here };
  const job = queueRefresh(projectId, id, label, opts.incrementalOnly ? 'incremental' : 'any');
  return { status: 'queued', jobId: job.id, done: job.done };
}
