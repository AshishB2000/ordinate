// refreshHook:list | create | revoke (live data L0.5) — a project writer's
// refresh URLs for one dataset. Contracts: src/api/refreshHooks.ts.
//
// The token is in create's reply and nowhere else: the list carries the
// prefix, who made it, when, when it was last called and whether it is
// revoked. Any writer of the project may revoke any of its URLs (a person who
// left must not leave a live one behind). Creating needs a browser session, as
// a personal token does (../auth/tokens.ts): a leaked API token must not be
// able to mint a credential that outlives its own revocation.

import type { Pool } from 'pg';
import { ctx } from '../context';
import { registry } from '../rpc';
import { createHook, listHooks, MAX_LIVE_PER_DATASET, revokeHook, type HookRow } from './store';
import { hookable } from './act';
import { hookDatasetGone, hookLimit, hookNotRefreshable, hooksNeedDatabase, hooksNeedSession } from '../../data/refreshHookMessages';

export interface HookList {
  /** False without Postgres: there is nowhere to keep a hook. */
  readonly available: boolean;
  /** REFRESH_HOOK_MIN_INTERVAL_SEC, for the panel's "at most once a minute". */
  readonly minIntervalSec: number;
  readonly hooks: readonly HookRow[];
}

/** Registers the three channels; `pool()` and `minIntervalSec()` are read per call, like the other server modules. */
export function register(pool: () => Pool | null, minIntervalSec: () => number): void {
  registry.handle('refreshHook:list', async (_e, { projectId, datasetId }: { projectId: string; datasetId: string }): Promise<HookList> => {
    const db = pool();
    if (!db) return { available: false, minIntervalSec: minIntervalSec(), hooks: [] };
    return { available: true, minIntervalSec: minIntervalSec(), hooks: await listHooks(db, ctx().org.id, projectId, datasetId) };
  });

  registry.handle('refreshHook:create', async (_e, { projectId, datasetId }: { projectId: string; datasetId: string }) => {
    const db = pool();
    if (!db) return { ok: false as const, error: hooksNeedDatabase() };
    const who = ctx();
    if (who.via === 'token') return { ok: false as const, error: hooksNeedSession() };
    const datasets = require('../../data/datasets') as typeof import('../../data/datasets');
    const meta = await datasets.getDatasetMeta(projectId, datasetId);
    if (!meta) return { ok: false as const, error: hookDatasetGone() };
    if (!hookable(meta)) return { ok: false as const, error: hookNotRefreshable(meta.name) };
    const made = await createHook(db, who.org.id, projectId, datasetId, who.user.email);
    if (!made) return { ok: false as const, error: hookLimit(MAX_LIVE_PER_DATASET) };
    return { ok: true as const, hook: made.hook, token: made.token };
  });

  registry.handle('refreshHook:revoke', async (_e, { projectId, id }: { projectId: string; id: string }) => {
    const db = pool();
    return { ok: !!db && (await revokeHook(db, ctx().org.id, projectId, id)) };
  });
}
