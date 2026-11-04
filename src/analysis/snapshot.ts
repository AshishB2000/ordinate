// A snapshot metric (semantic layer part 1): a stock count is the last (or first) day's value, not a sum over
// every day. This file is the TYPE, its whitelist and the save check; metrics.ts imports from here, never the other
// way round (types only come back).

import * as datasets from '../data/datasets';
import * as msg from './metricCheckMessages';

/** Which row of each group a snapshot metric reads: the latest or the earliest by `column` (a date column). */
export interface MetricSnapshot {
  column: string;
  take: 'last' | 'first';
}

const MAX_COLUMN = 512;

/** The snapshot when `raw` is well formed, else undefined (the caller then leaves the key out). */
export function sanitizeSnapshot(raw: unknown): MetricSnapshot | undefined {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || typeof o.column !== 'string' || !o.column || o.column.length > MAX_COLUMN) return undefined;
  if (o.take !== 'last' && o.take !== 'first') return undefined;
  return { column: o.column, take: o.take };
}

/**
 * The snapshot an UPDATED simple definition carries. An editor that knows no snapshots sends `{column, aggregation}`
 * with the key left out, and that must not erase the one the record has; only an explicit `null` clears it. A valid
 * incoming one replaces the stored one. `stored` is the stored definition's `snapshot` value.
 */
export function mergeSnapshot(incoming: unknown, stored: unknown): MetricSnapshot | undefined {
  return incoming === null ? undefined : (sanitizeSnapshot(incoming) ?? sanitizeSnapshot(stored));
}

/** The sentence refusing a definition whose snapshot names no date column of `datasetId`, or null (none, a date, or no dataset). */
export async function snapshotProblem(projectId: string, datasetId: string, def: unknown): Promise<string | null> {
  const snap = sanitizeSnapshot(def && typeof def === 'object' ? (def as { snapshot?: unknown }).snapshot : undefined);
  if (!snap) return null;
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  return !meta || meta.columns.some((c) => c.name === snap.column && c.type === 'date') ? null : msg.snapshotNotDate(snap.column);
}
