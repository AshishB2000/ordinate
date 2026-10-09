// What a refresh URL DOES to its dataset (live data L0.5) — the one decision,
// kept apart from the route so the route never grows a second one.
//
//   extract (a copy)   re-fetch it from its source through the single-flight
//                      door (src/data/refreshJob.ts `startRefresh`, L0.4): a
//                      refresh of it already running here or on another pod
//                      is joined, not repeated — `already_running`.
//   live (L2.1)        there are no rows to fetch; the warehouse is asked on
//                      the next question. The URL resets the cache instead
//                      (an epoch bump on the record, which every pod sees):
//                      `cache_reset`.
//
// After a refresh lands, the same follow-ups as the ↻ button's run (alerts,
// quality checks, a published site's rebuild, the SQL datasets built on it).

import type { DatasetMeta } from '../../data/datasets';
import { startRefresh } from '../../data/refreshJob';

export type HookAction = 'refresh' | 'bump';
export type HookStatus = 'queued' | 'already_running' | 'cache_reset';
type HookMeta = Pick<DatasetMeta, 'origin'> & { mode?: unknown };

/** Refresh an extract; reset a Live dataset's cache. */
export function hookAction(_meta: HookMeta): HookAction {
  return 'refresh';
}

/** Can this dataset have a refresh URL — is there something a call could do to it? A screenshot cannot be re-read. */
export function hookable(meta: HookMeta): boolean {
  return !!meta.origin && meta.origin.kind !== 'capture';
}

/** Do it, in the caller's request context (the hook's org and creator). */
export async function runHookAction(projectId: string, datasetId: string, meta: HookMeta): Promise<HookStatus> {
  if (hookAction(meta) === 'bump') return 'cache_reset';
  const start = await startRefresh(projectId, datasetId);
  if (start.status === 'queued') {
    void start.done.then(async (res) => {
      if (res.ok) await (require('../../ipc/datasets') as typeof import('../../ipc/datasets')).afterRefresh(projectId, datasetId);
    }).catch(() => undefined); // the refresh records its own failure on the dataset
  }
  return start.status;
}
