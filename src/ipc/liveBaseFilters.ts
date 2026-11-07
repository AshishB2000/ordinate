// `live:setBaseFilters` — a Live dataset's always-applied filters (semantic layer part 1, D13) — server,
// MAIN ONLY.
//
// The editor's list is checked the way every question will read it: the stored form
// (data/liveBaseFilters `sanitizeBaseFilters`) must keep every step, and the steps must adapt
// against the dataset's declared columns (engine/live/liveBase `liveBaseOf`) — a step that would be
// skipped, or refused, is refused here in a sentence, so nothing saved can make the dataset refuse
// later on its own. Then ONE record write (the steps, an epoch bump, the old sample's figures gone),
// this pod's cache cleared, open dashboards told, and a schema sync queued so the value pickers are
// sampled again under the new filters.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import { isLive, setBaseFilters } from '../data/liveDataset';
import { sanitizeBaseFilters } from '../data/liveBaseFilters';
import { declaredColumns } from '../data/liveCalcs';
import type { FilterStep } from '../data/transforms';
import { announceRefreshed } from '../data/refreshEvents';
import * as msg from '../data/liveMessages';
import { liveBaseOf } from '../engine/live/liveBase';
import { startSchemaSync } from '../engine/live/schemaSyncJob';
import { liveDatasetMissing } from '../engine/liveQueryMessages';
import * as queryCache from '../engine/queryCache';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export type SetBaseFiltersReply =
  | { ok: true; baseFilters: FilterStep[]; epoch: number }
  | { ok: false; code?: 'not_live' | 'live_refused'; reason?: string; error: string };

export async function setLiveBaseFilters(p: Record<string, unknown>): Promise<SetBaseFiltersReply> {
  const projectId = str(p.projectId);
  const datasetId = str(p.datasetId);
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, error: liveDatasetMissing() };
  if (!isLive(meta)) return { ok: false, code: 'not_live', error: msg.liveBaseFiltersNotLiveMessage() };
  const asked = Array.isArray(p.filters) ? p.filters : [];
  const steps = sanitizeBaseFilters(asked);
  // A step the stored form would drop (an unknown operator, a radius, too many values) is refused, never saved short.
  if (steps.length !== asked.length) return { ok: false, code: 'live_refused', reason: 'baseFilter', error: msg.liveBaseFilterInvalidMessage() };
  // The declared columns only: a base filter runs before any calculated field exists (part 8 step 04).
  const base = liveBaseOf(steps, declaredColumns(meta));
  if (!base.ok) {
    // A skip (a column it lacks, an empty list) is the editor's sentence; any other refusal says its own why.
    const error = base.code === 'baseFilter' ? msg.liveBaseFilterInvalidMessage() : base.message;
    return { ok: false, code: 'live_refused', reason: base.code, error };
  }
  const live = await setBaseFilters(projectId, datasetId, steps);
  if (!live) return { ok: false, code: 'not_live', error: msg.liveBaseFiltersNotLiveMessage() };
  queryCache.invalidateDataset(datasetId, projectId);
  announceRefreshed({ projectId, datasetId, name: meta.name, rowsBefore: 0, rowsAfter: 0 });
  // Queued before the reply (not waited for): the panel's next read already says a sync is on its way.
  await startSchemaSync(projectId, datasetId).catch(() => null);
  return { ok: true, baseFilters: steps, epoch: live.epoch };
}

export function register(): void {
  ipcMain.handle('live:setBaseFilters', async (_e, payload: Record<string, unknown> = {}) => {
    try {
      return await setLiveBaseFilters(payload);
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not save the filters' };
    }
  });
}
