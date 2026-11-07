// "Sync schema" for a semantic dataset (semantic layer part 7, b2; docs/semantic-layer/07-portability.md D11, D13) —
// MAIN PROCESS ONLY. ../schemaSync sends a record with a readable `semantic` block here, first thing.
//
//   1. DESCRIBE. The layer's model, read with its connector's `describeModel` (connectors/semanticRun: the SSRF
//      guard and `safeError`; a catalog read, not counted, as a warehouse's catalog is not). A failure changes
//      nothing and says so; the layer's words go to the server log only (R-L6).
//   2. NO SAMPLE. A layer returns totals, never rows, so nothing is profiled and no sensitivity is detected: the
//      reply says `sensitivity: 'manual'` (D11).
//   3. ONE WRITE. The dimensions (typed as the layer reports; one we cannot type is left out and named in the
//      reply), the block's metrics and grains and `schemaSyncedAt` (every cache key) together (liveRecord
//      `writeSemanticSync`).
//   4. THE MIRRORS, after that write (./mirrors).

import * as datasets from '../../../data/datasets';
import type { ColumnType, ParsedColumn } from '../../../data/parse';
import type { SemanticSettings } from '../../../data/semanticDataset';
import { MAX_SEMANTIC_METRICS, isLayerName } from '../../../data/semanticDataset';
import { writeSemanticSync } from '../../../data/liveRecord';
import { declaredColumns } from '../../../data/liveCalcs';
import { announceRefreshed } from '../../../data/refreshEvents';
import { isDateGrain } from '../../../analysis/categoryKey';
import { missingDependents } from '../../../analysis/liveDependents';
import * as connections from '../../../connectors/connections';
import { describeSemanticModel } from '../../../connectors/semanticRun';
import type { ConnectorSemantic } from '../../../connectors/types';
import { safeError } from '../../../connectors/types';
import { loadInput } from '../../../ipc/lineage';
import { logger } from '../../../app/logger';
import * as queryCache from '../../queryCache';
import * as msg from '../../liveProfileMessages';
import * as qmsg from '../../liveQueryMessages';
import * as smsg from '../../semanticMessages';
import { timeoutMs } from '../liveWarehouse';
import type { LiveTarget } from '../liveTarget';
import { liveTarget } from '../liveTarget';
import type { SyncReply } from '../schemaSync';
import { diffColumns } from '../schemaSync';
import { syncMirrors } from './mirrors';

type Described = Extract<Awaited<ReturnType<ConnectorSemantic['describeModel']>>, { ok: true }>;

const TYPES: ReadonlySet<string> = new Set<ColumnType>(['text', 'number', 'date']);

/** The layer's answer as a dataset reads it: typed dimensions, the grains it lists, its metrics — and what we cannot type. */
export function readModel(d: Described, backend: string, model: string, now: string): { columns: ParsedColumn[]; semantic: SemanticSettings; unmapped: string[] } {
  const columns: ParsedColumn[] = [];
  const grains: SemanticSettings['grains'] = [];
  const unmapped: string[] = [];
  const seen = new Set<string>();
  for (const x of Array.isArray(d.dimensions) ? d.dimensions : []) {
    if (!x || !isLayerName(x.name) || seen.has(x.name)) continue;
    seen.add(x.name);
    // A type no column takes, or one past the dimensions a block holds grains for: left out, named.
    if (x.type === null || !TYPES.has(x.type) || columns.length >= MAX_SEMANTIC_METRICS) {
      unmapped.push(x.name);
      continue;
    }
    columns.push({ name: x.name, type: x.type });
    const listed = x.type === 'date' && Array.isArray(x.grains) ? [...new Set(x.grains.filter(isDateGrain))] : [];
    if (listed.length) grains.push({ column: x.name, grains: listed });
  }
  const metrics: SemanticSettings['metrics'] = [];
  const named = new Set<string>();
  for (const m of Array.isArray(d.metrics) ? d.metrics : []) {
    if (!m || !isLayerName(m.name) || named.has(m.name) || metrics.length >= MAX_SEMANTIC_METRICS) continue;
    named.add(m.name);
    const description = typeof m.description === 'string' && m.description.trim() ? m.description.slice(0, 2000) : undefined;
    metrics.push({ name: m.name, additive: m.additive === true, ...(description ? { description } : {}) });
  }
  return { columns, semantic: { backend, model, metrics, grains, syncedAt: now }, unmapped };
}

/** Sync one semantic dataset. Never throws. */
export async function syncSemantic(projectId: string, datasetId: string, signal: AbortSignal): Promise<SyncReply> {
  const found = await liveTarget(projectId, datasetId, { base: 'skip' });
  if (!found.ok) {
    return found.kind === 'unavailable'
      ? { ok: false, code: 'live_unavailable', error: found.error }
      : { ok: false, code: 'live_refused', reason: found.refusal.code, error: found.refusal.message };
  }
  const t: LiveTarget = found.target;
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!t.semantic || !meta?.live?.semantic) return { ok: false, code: 'live_unavailable', error: qmsg.liveNotLive() };

  // 1. Describe. The model's name and the layer's words stay in the log.
  let d: Awaited<ReturnType<typeof describeSemanticModel>>;
  try {
    d = await describeSemanticModel(t.def, t.values, await t.secrets(), t.semantic.model, { signal, timeoutMs: timeoutMs() });
  } catch (err: unknown) {
    d = { ok: false, error: safeError(err) };
  }
  if (signal.aborted) return { ok: false, code: 'live_cancelled', error: qmsg.liveCancelled() };
  if (!d.ok) {
    logger.warn(`[live] liveSync:semantic dataset ${datasetId}: describe failed: ${d.error}`);
    return { ok: false, code: 'live_failed', error: msg.liveSyncReadFailed() };
  }
  const now = new Date().toISOString();
  const read = readModel(d, t.semantic.backend, t.semantic.model, now);

  // 3. One write; the cache key moves with it.
  const stored = declaredColumns(meta);
  const diff = diffColumns(stored, read.columns);
  const gone = [...new Set([...(meta.live.missingColumns ?? []), ...diff.removed])].filter((n) => !read.columns.some((c) => c.name === n));
  const missing = gone.length ? missingDependents(await loadInput(projectId), datasetId, gone).map((m) => m.column) : [];
  const changed = diff.added.length + diff.removed.length + diff.retyped.length > 0;
  if (!(await writeSemanticSync(projectId, datasetId, { columns: read.columns, semantic: read.semantic, missingColumns: missing, syncedAt: now, changed }))) {
    return { ok: false, code: 'live_unavailable', error: qmsg.liveNotLive() };
  }
  queryCache.invalidateDataset(datasetId, projectId);
  if (changed) announceRefreshed({ projectId, datasetId, name: meta.name, rowsBefore: 0, rowsAfter: 0 });

  // 4. The mirrors.
  const conn = await connections.getConnection(projectId, t.connectionId);
  const mirrored = await syncMirrors(projectId, datasetId, read.semantic, conn?.name ?? '', meta.name);
  return {
    ok: true, schemaSyncedAt: now, columns: read.columns.length, ...diff, missing,
    sample: { ok: false, code: 'live_refused', reason: 'semantic', error: smsg.layerNotSampled(t.semantic.env.layer) },
    sensitivity: 'manual',
    ...(read.unmapped.length ? { unmapped: read.unmapped } : {}),
    ...(mirrored.unmirrored.length ? { unmirrored: mirrored.unmirrored } : {}),
  };
}
