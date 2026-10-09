import { skipToken, useQuery } from '@tanstack/react-query';
import { rpc } from './client';

/**
 * What `dataset:list` returns per dataset — the fields the web reads, mirrored
 * from src/data/datasetSummary.ts `DatasetSummary` (narrowed by hand for the
 * same reason as `Project` in ./projects.ts).
 */
export interface DatasetSummary {
  id: string;
  name: string;
  sourceKind: string;
  rowCount: number;
  columnCount: number;
  updatedAt: string;
  /** Freshness and lineage, as the Data list reads them (T2.3). */
  originKind?: string;
  originDeps?: string[];
  stepDeps?: string[];
  lastRefreshedAt?: string;
  lastRefreshStatus?: 'ok' | 'error';
  lastRefreshError?: string | null;
  autoRefresh?: { every: AutoRefreshEvery; watch?: boolean };
  /** FAIL rules failing in the latest quality run. */
  qualityFailing?: number;
  /** Incremental refresh is on: the only way a schedule may run every 5 or 15 minutes. */
  incrementalOn?: true;
  /** The last scheduled refresh took longer than its own interval (the server decides). */
  behindSchedule?: true;
  /** A Live dataset: no stored rows (`rowCount` is 0 and means nothing) — L2.1. */
  mode?: 'live';
  maxCacheAgeSec?: number;
}

/** A refresh schedule (src/data/datasets.ts `AutoRefreshEvery`); 5 and 15 minutes need incremental refresh. */
export type AutoRefreshEvery = '5min' | '15min' | 'hourly' | 'daily' | 'weekly';

/** The project's saved datasets; idle until a project is chosen. */
export function useDatasets(projectId: string | undefined) {
  return useQuery({
    queryKey: ['dataset:list', projectId],
    queryFn: projectId === undefined ? skipToken : async () => (await rpc('dataset:list', { projectId })) as DatasetSummary[],
  });
}

/** What `dataset:columns` returns: a grid's header, never where the rows came from. */
export interface DatasetColumns {
  id: string;
  name: string;
  rowCount: number;
  columns: { name: string; type: 'text' | 'number' | 'date' }[];
  /** A Live dataset keeps no rows here (L2.1). */
  mode?: 'live';
}

/** A dataset's name, row count and typed columns; `null` data = no such dataset. */
export function useDatasetColumns(projectId: string | undefined, id: string | undefined) {
  return useQuery({
    queryKey: ['dataset:columns', projectId, id],
    queryFn:
      projectId === undefined || id === undefined
        ? skipToken
        : async () => (await rpc('dataset:columns', { projectId, id })) as DatasetColumns | null,
  });
}

type Cell = string | number | null;
type PageReply = { ok: true; rows: Cell[][]; total: number; offset: number } | { ok: false; error: string };

/** The search / sort a grid's rows are read with — run by the server, never here. */
export interface PageQuery {
  search?: string;
  sortColumn?: string;
  sortDir?: 'asc' | 'desc';
  /** Row filters (`column = value` from a data search hit). */
  filters?: { type: 'filter'; column: string; op: string; value?: string | number | null }[];
}

/**
 * A DataGrid `source` over `dataset:page`. Memoize it per (dataset, query): a
 * new function is a new query and drops the rows the grid has.
 */
export function datasetPageSource(projectId: string, datasetId: string, query: PageQuery = {}) {
  return async (offset: number, limit: number): Promise<{ rows: Cell[][]; total: number }> => {
    const res = (await rpc('dataset:page', { projectId, datasetId, offset, limit, ...query })) as PageReply;
    if (!res.ok) throw new Error(res.error || 'The rows could not be read.');
    return { rows: res.rows, total: res.total };
  };
}
