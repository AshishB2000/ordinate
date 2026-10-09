// When a Live dataset's schema is synced, and never twice at once
// (docs/live-data/00-plan.md L2.5) — MAIN PROCESS ONLY.
//
// Three doors start a sync (./schemaSync.ts), all through `startSchemaSync`:
//
//   on create      "Add from connection → Live" and "Switch to Live" queue one
//                  right after the record is written (the create does not
//                  wait for the sample);
//   on demand      `dataset:syncLiveSchema` (src/ipc/liveProfile.ts), which
//                  waits for it and answers what it found;
//   daily          the scheduler's tick (src/app/refreshScheduler.ts) hands the
//                  Live datasets it skips for refresh to `queueDueSchemaSyncs`:
//                  one whose `schemaSyncedAt` is 24 h old gets a sync job.
//
// ONE AT A TIME PER DATASET, three ways, the refresh path's own: a start on
// this pod is held in `starting` until its job lands; a job of this dataset
// queued or running here (`refreshRunning` — the sync is a `refresh` job) or
// the cross-pod lock held by another pod (L0.4 `withRefreshLock`, which the
// job takes) means "already running", and nothing is queued. A scheduled
// start is stamped first, win or lose (`syncAttemptAt`), so a warehouse that
// keeps failing is retried hourly, not on every 60-second tick.

import * as jobs from '../../app/jobs';
import * as datasets from '../../data/datasets';
import { isLive, stampSyncAttempt } from '../../data/liveDataset';
import { refreshRunning } from '../../data/refreshJob';
import { orgKey } from '../../server/context';
import { withRefreshLock } from '../../server/jobs/refreshLock';
import * as msg from '../liveProfileMessages';
import type { SyncReply } from './schemaSync';
import { syncLiveSchema } from './schemaSync';

/** A Live dataset's schema is synced again after a day. */
export const SYNC_EVERY_MS = 24 * 60 * 60 * 1000;
/** A scheduled sync that did not land is tried again after an hour. */
export const RETRY_AFTER_MS = 60 * 60 * 1000;

/** One Live dataset as the tick sees it — from the list's summary, no record read. */
export interface LiveSyncMeta {
  projectId: string;
  id: string;
  name: string;
  schemaSyncedAt?: string;
  schemaSyncAttemptAt?: string;
}

const msOf = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};

/**
 * Which Live datasets are due a daily sync at `now`, stalest first — PURE, the
 * whole rule. Due: synced 24 h ago or more (never, or an unreadable stamp,
 * counts as long ago — the schedule heals itself) and not attempted in the
 * last hour. Ties keep input order.
 */
export function dueSchemaSyncs<T extends LiveSyncMeta>(metas: readonly T[], now: number): T[] {
  return (Array.isArray(metas) ? metas : [])
    .filter((m) => m && now - msOf(m.schemaSyncedAt) >= SYNC_EVERY_MS && now - msOf(m.schemaSyncAttemptAt) >= RETRY_AFTER_MS)
    .map((m, at) => ({ m, at, synced: msOf(m.schemaSyncedAt) }))
    .sort((a, b) => (a.synced === b.synced ? a.at - b.at : a.synced < b.synced ? -1 : 1))
    .map((x) => x.m);
}

export type SyncStart = { status: 'queued'; jobId: string; done: Promise<SyncReply> } | { status: 'already_running' };

/** Starts on this pod, from the call until its job lands. */
const starting = new Set<string>();

/** Starts in flight on this pod (a test checks none is left behind). */
export function syncsStarting(): number {
  return starting.size;
}

/** A failure the job's run raised, carried to `done` with its reply. */
class SyncFailed extends Error {
  readonly reply: SyncReply;
  constructor(reply: Extract<SyncReply, { ok: false }>) {
    super(reply.error);
    this.reply = reply;
  }
}

function jobLine(r: SyncReply): string {
  if (!r.ok) return r.error;
  const n = (x: number): string => x.toLocaleString('en-US');
  return r.missing.length ? msg.liveSyncDoneMissing(n(r.columns), n(r.missing.length)) : msg.liveSyncDone(n(r.columns));
}

/**
 * Queue a schema sync of one Live dataset, unless one is running anywhere.
 * Null when the dataset is not Live (or gone). `done` never rejects.
 */
export async function startSchemaSync(projectId: string, id: string, opts: { scheduled?: boolean; now?: number } = {}): Promise<SyncStart | null> {
  const key = orgKey(`schemaSync\u0000${projectId}\u0000${id}`);
  if (starting.has(key)) return { status: 'already_running' };
  starting.add(key); // before the first await: two starts on this pod cannot both pass
  let handed = false;
  try {
    if (await refreshRunning(projectId, id)) return { status: 'already_running' };
    const meta = await datasets.getDatasetMeta(projectId, id);
    if (!meta || !isLive(meta)) return null;
    if (opts.scheduled) await stampSyncAttempt(projectId, id, new Date(opts.now ?? Date.now()).toISOString());
    const job = jobs.submit<SyncReply>({
      kind: 'refresh',
      label: `Sync schema · ${meta.name}`,
      projectId,
      datasetId: id,
      silent: opts.scheduled === true, // a daily sync is housekeeping: no notification when it lands
      run: async (jctx) => {
        jctx.progress(0.05, 'Reading the columns');
        const locked = await withRefreshLock(id, () => syncLiveSchema(projectId, id, jctx.signal));
        if (!locked.ran) return { ok: false, code: 'already_running', error: msg.liveSyncRunning() };
        if (!locked.value.ok) throw new SyncFailed(locked.value);
        return locked.value;
      },
      resultOf: (r) => ({ message: jobLine(r) }),
    });
    handed = true;
    const done = job.done.then(
      (r) => r,
      (err: unknown): SyncReply => (err instanceof SyncFailed ? err.reply
        : { ok: false, code: err instanceof jobs.JobCancelled ? 'live_cancelled' : 'live_failed', error: err instanceof Error ? err.message : String(err) }),
    );
    void done.finally(() => starting.delete(key));
    return { status: 'queued', jobId: job.id, done };
  } finally {
    if (!handed) starting.delete(key);
  }
}

/**
 * The tick's hook: queue the due daily syncs, without waiting for them. Never
 * throws — one dataset that cannot start must not stop the rest. Returns how
 * many were queued.
 */
export async function queueDueSchemaSyncs(metas: readonly LiveSyncMeta[], now: number): Promise<number> {
  let queued = 0;
  for (const m of dueSchemaSyncs(metas, now)) {
    try {
      const s = await startSchemaSync(m.projectId, m.id, { scheduled: true, now });
      if (s?.status === 'queued') queued += 1;
    } catch (err: unknown) {
      console.warn(`[live] the daily schema sync of dataset ${m.id} could not start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return queued;
}
