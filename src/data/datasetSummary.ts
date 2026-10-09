// The saved-list SUMMARY of a dataset — MAIN PROCESS, pure.
//
// Split out of datasets.ts when adding lineage pushed it past the 800-line cap
// (.claude/rules/file-size.md). datasets.ts stores records; this decides what
// of a record the list, the scheduler and the lineage line may see without a
// full load.

import type { AutoRefresh, Dataset, DatasetOrigin } from './datasets';
import { qualityFailingCount } from '../analysis/qualityRules';
import { stepRefIds } from './stepTypes';
import { redactOriginText } from './datasetOrigin';
import { serverDataDir } from '../server/context';
import { behindSchedule } from './refreshCadence';

export interface DatasetSummary {
  id: string;
  name: string;
  sourceKind: Dataset['sourceKind'];
  rowCount: number;
  columnCount: number;
  updatedAt: string;
  // Week 13 — just the crop path (not the full capture object) so the saved-list
  // can render a capture thumbnail + badge without a full dataset load. On the
  // server it is only `hasImage`: a browser can do nothing with a server path
  // and must never learn one, whichever channel hands it a summary.
  capture?: { cropPath: string | null } | { hasImage: boolean };
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
  /**
   * The datasets this one's union / lookup steps READ (src/data/stepRefs.ts).
   * Ids only — what lineage draws and what datasetDependents re-runs it for.
   */
  stepDeps?: string[];
  lastRefreshedAt?: string;
  lastRefreshStatus?: 'ok' | 'error';
  lastRefreshError?: string | null;
  // Carried on the SUMMARY so the scheduler can find due datasets from the
  // metadata alone. Reading a schedule must never hydrate a table.
  autoRefresh?: AutoRefresh;
  // FAIL-severity quality rules failing in the latest run — the red dot. Absent
  // when the dataset has never been checked.
  qualityFailing?: number;
  // Incremental refresh is on — what lets a schedule run every 5 or 15 minutes
  // (src/data/refreshCadence.ts). The flag only, never the cursor or the mark.
  incrementalOn?: true;
  // The last scheduled run took longer than its own interval. Computed here,
  // on the server; the list only draws it.
  behindSchedule?: true;
  // A Live dataset (./liveDataset.ts): no stored rows, so `rowCount` is 0 and
  // means nothing — the list says "Live" instead. Absent on an extract.
  mode?: 'live';
  maxCacheAgeSec?: number;
}

/** The parent ids an origin names, in its own order. */
export function originParents(origin: DatasetOrigin | undefined): string[] {
  if (!origin) return [];
  if (origin.kind === 'sql' || origin.kind === 'notebook') return origin.deps.slice();
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
  if (ds.capture) summary.capture = serverDataDir() === null ? { cropPath: ds.capture.cropPath } : { hasImage: !!ds.capture.cropPath };
  // 'capture' is deliberately withheld: `originKind` is what the list and
  // the explorer read to offer "↻ Refresh", and a screenshot has nothing to
  // re-fetch. The origin itself stays on the full record (the capture page
  // reads it) — this is only about the refresh affordance.
  if (ds.origin && ds.origin.kind !== 'capture') summary.originKind = ds.origin.kind;
  if (ds.origin && ds.origin.kind === 'connection') summary.originConnId = ds.origin.connId;
  const parents = originParents(ds.origin);
  if (parents.length) summary.originDeps = [...new Set(parents)];
  const stepDeps = stepRefIds(ds.steps);
  if (stepDeps.length) summary.stepDeps = stepDeps;
  if (ds.lastRefreshedAt) summary.lastRefreshedAt = ds.lastRefreshedAt;
  if (ds.lastRefreshStatus) summary.lastRefreshStatus = ds.lastRefreshStatus;
  if (ds.lastRefreshStatus === 'error' && ds.lastRefreshError) {
    // On the server the reason goes to every viewer of the project: no URL
    // past its host, no server path (a refresh error can quote either).
    summary.lastRefreshError = serverDataDir() ? redactOriginText(ds.lastRefreshError, ds.origin) : ds.lastRefreshError;
  }
  if (ds.autoRefresh) summary.autoRefresh = ds.autoRefresh;
  if (ds.incremental?.enabled) summary.incrementalOn = true;
  if (behindSchedule(ds.autoRefresh)) summary.behindSchedule = true;
  const qualityFailing = qualityFailingCount(ds.quality);
  if (qualityFailing !== undefined) summary.qualityFailing = qualityFailing;
  if (ds.mode === 'live' && ds.live) {
    summary.mode = 'live';
    summary.maxCacheAgeSec = ds.live.maxCacheAgeSec;
  }
  return summary;
}
