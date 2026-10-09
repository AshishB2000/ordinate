// A Live dataset's schema sync and column profile, as the app reads them
// (docs/live-data/00-plan.md L2.5) — server, MAIN ONLY.
//
//   dataset:syncLiveSchema   "Sync schema": queue a sync (one at a time per
//                            dataset, src/engine/live/schemaSyncJob.ts) and
//                            answer what it found — counts, column names, the
//                            sample's outcome as a typed failure with a catalog
//                            sentence. Never warehouse text.
//   dataset:liveSchema       The Live dataset page's Schema panel: when it was
//                            synced, each column's profile with its share
//                            filled computed here, the sample values, which
//                            columns a model is never shown values of, and the
//                            missing columns with what still uses them.
//
// And what the rest of the server reads from the profile instead of refusing:
// the filter pickers (`dataset:distinct`), the column profile
// (`dataset:profile`), the Assistant's facts and its project inventory. A Live
// dataset that has no profile yet keeps refusing those (D6) — never a guess.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import type { DatasetMeta } from '../data/datasets';
import { isLive } from '../data/liveDataset';
import { profileDistinct, profileOf, type LiveProfile, type ProfileDistinct } from '../data/liveProfile';
import { distribution, pctOf, type ColumnProfile } from '../data/profileView';
import { refreshRunning } from '../data/refreshJob';
import { detectColumn } from '../data/sensitivity';
import { getReview } from '../app/privacyStore';
import { assistantColumnDocs, withheldColumns } from '../app/sharePolicy';
import { missingDependents, type MissingColumn } from '../analysis/liveDependents';
import { liveColumnNotes, liveDatasetFacts } from '../ai/liveFacts';
import type { CopilotFacts } from '../ai/copilot';
import type { FactMetric } from '../ai/copilotFacts';
import { startSchemaSync } from '../engine/live/schemaSyncJob';
import * as msg from '../engine/liveProfileMessages';
import { loadInput } from './lineage';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The columns of a Live dataset whose VALUES no model is shown: every column
 * marked personal or financial (carried across renames — sharePolicy), every
 * column with a pending proposal, and every column whose sampled values the
 * detector flags now unless the user dismissed it. FAILS CLOSED: when the marks
 * cannot be read, no column's values go to a model.
 */
export async function liveWithheld(projectId: string, datasetId: string, meta: Pick<DatasetMeta, 'columns' | 'live'>): Promise<Set<string>> {
  const profile = meta.live?.profile;
  try {
    const out = await withheldColumns(projectId, datasetId);
    const review = await getReview(projectId, datasetId);
    for (const p of review.pending) out.add(p.column);
    for (const c of profile?.columns ?? []) {
      if (out.has(c.name) || !c.values?.length || review.dismissed.includes(c.name)) continue;
      const type = meta.columns.find((x) => x.name === c.name)?.type ?? 'text';
      if (detectColumn({ name: c.name, type }, c.values)) out.add(c.name);
    }
    return out;
  } catch {
    return new Set([...meta.columns.map((c) => c.name), ...(profile?.columns ?? []).map((c) => c.name)]);
  }
}

/**
 * The Assistant's facts for a Live dataset in context, or null when the dataset
 * is not Live. `defined` reads the dataset's defined metrics — asked only for a
 * Live dataset, each figure the warehouse's (the KPI door, L2.4).
 */
export async function liveCopilotFacts(
  projectId: string,
  datasetId: string,
  defined: () => Promise<FactMetric[]> = async () => [],
): Promise<{ name: string; facts: CopilotFacts; metrics: number } | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta || !isLive(meta) || !meta.live) return null;
  const metrics = await defined();
  const facts = liveDatasetFacts({
    name: meta.name,
    columns: meta.columns,
    profile: meta.live.profile,
    schemaSyncedAt: meta.live.schemaSyncedAt,
    withheld: await liveWithheld(projectId, datasetId, meta),
    docs: await assistantColumnDocs(projectId, datasetId),
    metrics,
  });
  return { name: meta.name, facts, metrics: metrics.length };
}

/** A Live dataset's per-column line-ends for the project inventory; undefined for an extract. */
export async function liveInventoryNotes(projectId: string, meta: DatasetMeta): Promise<Record<string, string> | undefined> {
  if (!isLive(meta) || !meta.live?.profile) return undefined;
  const withheld = await liveWithheld(projectId, meta.id, meta);
  return liveColumnNotes({ name: meta.name, columns: meta.columns, profile: meta.live.profile, withheld });
}

/** `dataset:distinct` for a profiled Live dataset; null for anything else (the caller's own path decides). */
export async function liveDistinct(projectId: string, datasetId: string, column: string, req: { limit?: number; search?: string }): Promise<ProfileDistinct | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  return meta && isLive(meta) ? profileDistinct(meta, column, req) : null;
}

/**
 * `dataset:profile` for a profiled Live dataset: the panel's shape, every
 * figure the SAMPLE's (`rowCount` is the sample's rows, and `sample` says so);
 * no median and no histogram — those would need the rows. Null for an extract,
 * or a Live dataset not profiled yet (the caller's path refuses it).
 */
export function liveColumnProfile(meta: DatasetMeta, column: string): { ok: true; profile: ColumnProfile & { sample: { rows: number; sampledAt: string | null } } } | null {
  const prof: LiveProfile | undefined = isLive(meta) ? meta.live?.profile : undefined;
  const col = meta.columns.find((c) => c.name === column);
  if (!prof || !col) return null;
  const p = profileOf(meta, column);
  const rows = prof.sampleRows ?? 0;
  const filled = typeof p?.filled === 'number' ? p.filled : null;
  return {
    ok: true,
    profile: {
      name: column,
      type: col.type,
      rowCount: rows,
      filled,
      filledPct: filled === null ? null : pctOf(filled, rows),
      empty: filled === null ? null : Math.max(0, rows - filled),
      distinct: typeof p?.distinct === 'number' ? p.distinct : null,
      min: null,
      median: null,
      max: null,
      mostCommon: p?.values?.[0] ?? null,
      distribution: p?.values?.length && p.counts ? distribution('text', p.values, p.counts) : null,
      sample: { rows, sampledAt: prof.sampledAt ?? null },
    },
  };
}

/** One column on the Schema panel. Every figure computed here; the browser only formats. */
export interface SchemaColumn {
  name: string;
  type: string;
  filled: number | null;
  filledPct: number | null;
  distinct: number | null;
  values: string[];
  /** Distinct values past the ones listed (a sample's count). */
  more: number;
  /** A model is never shown this column's values. */
  withheld: boolean;
}

export interface LiveSchemaView {
  ok: true;
  schemaSyncedAt: string;
  /** A sync of this dataset is queued or running, here or on another pod. */
  syncing: boolean;
  sampledAt: string | null;
  sampleRows: number | null;
  method: 'sample' | 'limit' | null;
  /** Why the last sync read no sample (a catalog sentence), or null. */
  note: string | null;
  columns: SchemaColumn[];
  missing: MissingColumn[];
}

const SKIP_NOTE = { tooCostly: msg.liveSampleTooCostly, failed: msg.liveSampleFailed, refused: msg.liveSampleRefused } as const;

async function schemaView(projectId: string, datasetId: string): Promise<LiveSchemaView | { ok: false; error: string; code?: string }> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, error: 'Dataset not found' };
  if (!isLive(meta) || !meta.live) return { ok: false, code: 'not_live', error: msg.liveSyncNotLive() };
  const prof = meta.live.profile;
  const rows = prof?.sampleRows;
  const withheld = await liveWithheld(projectId, datasetId, meta);
  const missingNames = meta.live.missingColumns ?? [];
  return {
    ok: true,
    schemaSyncedAt: meta.live.schemaSyncedAt,
    syncing: !!(await refreshRunning(projectId, datasetId)),
    sampledAt: prof?.sampledAt ?? null,
    sampleRows: rows ?? null,
    method: prof?.method ?? null,
    note: prof?.skipped ? SKIP_NOTE[prof.skipped]() : null,
    columns: meta.columns.map((c) => {
      const p = profileOf(meta, c.name);
      const filled = typeof p?.filled === 'number' ? p.filled : null;
      const values = p?.values ?? [];
      const distinct = typeof p?.distinct === 'number' ? p.distinct : null;
      return {
        name: c.name,
        type: c.type,
        filled,
        filledPct: filled !== null && rows ? pctOf(filled, rows) : null,
        distinct,
        values,
        more: values.length && distinct !== null ? Math.max(0, distinct - values.length) : 0,
        withheld: withheld.has(c.name),
      };
    }),
    missing: missingNames.length ? missingDependents(await loadInput(projectId), datasetId, missingNames) : [],
  };
}

export function register(): void {
  ipcMain.handle('dataset:syncLiveSchema', async (_e, payload: Record<string, unknown> = {}) => {
    try {
      const projectId = str(payload.projectId);
      const datasetId = str(payload.datasetId);
      const meta = await datasets.getDatasetMeta(projectId, datasetId);
      if (!meta) return { ok: false, error: 'Dataset not found' };
      if (!isLive(meta)) return { ok: false, code: 'not_live', error: msg.liveSyncNotLive() };
      const start = await startSchemaSync(projectId, datasetId);
      if (!start) return { ok: false, code: 'not_live', error: msg.liveSyncNotLive() };
      if (start.status === 'already_running') return { ok: true, status: 'already_running', message: msg.liveSyncRunning() };
      const r = await start.done;
      return r.ok ? { ...r, status: 'synced' } : r;
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not sync the schema' };
    }
  });

  ipcMain.handle('dataset:liveSchema', async (_e, payload: Record<string, unknown> = {}) => {
    try {
      return await schemaView(str(payload.projectId), str(payload.datasetId));
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not read the schema' };
    }
  });
}
