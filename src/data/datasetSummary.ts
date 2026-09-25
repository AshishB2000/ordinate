// The saved-list SUMMARY of a dataset — MAIN PROCESS, pure.
//
// Split out of datasets.ts when adding lineage pushed it past the 800-line cap
// (.claude/rules/file-size.md). datasets.ts stores records; this decides what
// of a record the list, the scheduler and the lineage line may see without a
// full load.

import type { AutoRefresh, Dataset, DatasetOrigin } from './datasets';

export interface DatasetSummary {
  id: string;
  name: string;
  sourceKind: Dataset['sourceKind'];
  rowCount: number;
  columnCount: number;
  updatedAt: string;
  // Week 13 — just the crop path (not the full capture object) so the saved-list
  // can render a capture thumbnail + badge without a full dataset load.
  capture?: { cropPath: string | null };
  // Freshness for the saved list, WITHOUT a full dataset load: enough of the
  // origin to decide "is this refreshable" and to name the source, never the
  // path, the URL or the SQL. `lastRefreshError` is the REASON a red dot shows,
  // so a row can say it on hover — secret-free, like the record's.
  originKind?: DatasetOrigin['kind'];
  originConnId?: string;
  /**
   * The datasets this one was BUILT FROM — a query's `deps`, a combine's two
   * parents, a composer chain's base and joins. Ids only. It is what the
   * lineage line draws and what `datasetDependents` walks (sql edges only).
   */
  originDeps?: string[];
  lastRefreshedAt?: string;
  lastRefreshStatus?: 'ok' | 'error';
  lastRefreshError?: string | null;
  // Carried on the SUMMARY so the scheduler can find due datasets from the
  // metadata alone. Reading a schedule must never hydrate a table.
  autoRefresh?: AutoRefresh;
}

/** The parent ids an origin names, in its own order. */
export function originParents(origin: DatasetOrigin | undefined): string[] {
  if (!origin) return [];
  if (origin.kind === 'sql') return origin.deps.slice();
  if (origin.kind === 'combined') return [origin.leftId, origin.rightId];
  if (origin.kind === 'composed') return [origin.baseId, ...origin.joins.map((j) => j.datasetId)];
  return [];
}

export function summarize(ds: Dataset): DatasetSummary {
  const summary: DatasetSummary = {
    id: ds.id,
    name: ds.name,
    sourceKind: ds.sourceKind,
    rowCount: ds.rowCount,
    columnCount: ds.columns.length,
    updatedAt: ds.updatedAt,
  };
  if (ds.capture) summary.capture = { cropPath: ds.capture.cropPath };
  // 'capture' is deliberately withheld: `originKind` is what the list and
  // the explorer read to offer "↻ Refresh", and a screenshot has nothing to
  // re-fetch. The origin itself stays on the full record (the capture page
  // reads it) — this is only about the refresh affordance.
  if (ds.origin && ds.origin.kind !== 'capture') summary.originKind = ds.origin.kind;
  if (ds.origin && ds.origin.kind === 'connection') summary.originConnId = ds.origin.connId;
  const parents = originParents(ds.origin);
  if (parents.length) summary.originDeps = [...new Set(parents)];
  if (ds.lastRefreshedAt) summary.lastRefreshedAt = ds.lastRefreshedAt;
  if (ds.lastRefreshStatus) summary.lastRefreshStatus = ds.lastRefreshStatus;
  if (ds.lastRefreshStatus === 'error' && ds.lastRefreshError) summary.lastRefreshError = ds.lastRefreshError;
  if (ds.autoRefresh) summary.autoRefresh = ds.autoRefresh;
  return summary;
}
