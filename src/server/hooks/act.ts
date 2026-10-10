// What a refresh URL DOES to its dataset (live data L0.5) — the one decision,
// kept apart from the route so the route never grows a second one.
//
//   extract (a copy)   re-fetch it from its source through the single-flight
//                      door (src/data/refreshJob.ts `startRefresh`, L0.4): a
//                      refresh of it already running here or on another pod
//                      is joined, not repeated — `already_running`.
//   live (L2.1)        there are no rows to fetch; the warehouse is asked on
//                      the next question. The URL resets the cache instead —
//                      the ↻ button's own Live door (src/ipc/liveDatasets.ts
//                      `refreshLive`: an epoch bump on the record, which every
//                      pod sees, and the refresh announced so open dashboards
//                      re-ask): `cache_reset`, done by the time the call is
//                      answered. A DISTINCT status, not `queued`: nothing is
//                      queued, and a pipeline can tell the two apart.
//
// After a refresh lands, the same follow-ups as the ↻ button's run (alerts,
// quality checks, a published site's rebuild, the SQL datasets built on it).
//
// A CONNECTION's URL does that to every dataset that came from the connection
// (`targetDatasets`), one after another through the same door.

import * as datasets from '../../data/datasets';
import type { DatasetMeta } from '../../data/datasets';
import { isLive } from '../../data/liveDataset';
import { startRefresh } from '../../data/refreshJob';
import type { HookResult, HookTarget } from './store';

export type HookAction = 'refresh' | 'bump';
export type HookStatus = 'queued' | 'already_running' | 'cache_reset';
/** What a call did to one dataset, and how that ends: `end` resolves when its part of the call is over, and never rejects. */
export interface HookStart { readonly status: HookStatus | 'gone'; readonly end: Promise<HookResult> }
const ended = (status: HookStatus | 'gone', result: HookResult): HookStart => ({ status, end: Promise.resolve(result) });
type HookMeta = Pick<DatasetMeta, 'origin'> & { mode?: unknown };

/** Refresh an extract; reset a Live dataset's cache. */
export function hookAction(meta: HookMeta): HookAction {
  return isLive(meta) ? 'bump' : 'refresh';
}

/** Can this dataset have a refresh URL — is there something a call could do to it? A screenshot cannot be re-read. */
export function hookable(meta: HookMeta): boolean {
  return isLive(meta) || (!!meta.origin && meta.origin.kind !== 'capture');
}

/**
 * The datasets a URL refreshes: its own, or — a connection's URL — every
 * dataset in the project that came from the connection, the Live ones too.
 */
export async function targetDatasets(projectId: string, target: HookTarget): Promise<string[]> {
  if ('datasetId' in target) return [target.datasetId];
  return (await datasets.listDatasets(projectId)).filter((d) => d.originConnId === target.connId).map((d) => d.id);
}

/**
 * Do it, in the caller's request context (the hook's org and creator). `gone`:
 * a Live dataset's record vanished between the read and the bump.
 */
export async function runHookAction(projectId: string, datasetId: string, meta: HookMeta): Promise<HookStart> {
  if (hookAction(meta) === 'bump') {
    const live = await (require('../../ipc/liveDatasets') as typeof import('../../ipc/liveDatasets')).refreshLive(projectId, datasetId);
    // null: no longer Live (switched back to a copy since the read) — refresh it as one.
    if (live) return live.ok ? ended('cache_reset', 'ok') : ended('gone', 'failed');
  }
  const start = await startRefresh(projectId, datasetId);
  if (start.status !== 'queued') return ended('already_running', 'already_running');
  const end = start.done.then((res): HookResult => {
    // The follow-ups are not the refresh: the rows have landed, and the call's outcome does not wait for them.
    if (res.ok) void (require('../../ipc/datasets') as typeof import('../../ipc/datasets')).afterRefresh(projectId, datasetId).catch(() => undefined);
    // Lost the lock to another pod between the ask and the job: joined after all. Any other failure is recorded on the dataset by the refresh itself.
    return res.ok ? 'ok' : res.alreadyRunning ? 'already_running' : 'failed';
  });
  return { status: 'queued', end };
}
