// SQL over the project's datasets (src/api/analyticsB.ts → src/ipc/sqlQuery.ts
// → src/engine/sqlDatasets.ts). The server does all of it: the read-only gate,
// the org worker's engine lock, binding `[[params]]`, the 500-row preview, the
// types. The browser sends the user's own text and the parameter values.

import { skipToken, useQuery } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import type { SchemaDataset, SqlParam } from './sqlText';

type Fail = { ok: false; error: string; canceled?: boolean };
type Cell = string | number | null;

export interface RunResult {
  ok: true;
  columns: Array<{ name: string; type: 'text' | 'number' | 'date' }>;
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}
export interface ExplainResult {
  ok: true;
  columns: Array<{ name: string; sqlType: string; kind: string }>;
}
export interface PrepareResult {
  ok: true;
  columns: Array<{ name: string; type: 'text' | 'number' | 'date' }>;
  rows: Cell[][];
  rowCount: number;
  stagedId: string;
  origin: { kind: 'sql'; sql: string; deps: string[]; params?: Array<{ name: string } & Record<string, unknown>> };
}

export function useSchema(projectId: string) {
  return useQuery({
    queryKey: ['sql:schema', projectId],
    queryFn: async () => {
      const r = (await rpc('sql:schema', { projectId })) as { ok: true; datasets: SchemaDataset[] } | Fail;
      if (!r.ok) throw new Error(r.error || 'Could not read the datasets.');
      return r.datasets;
    },
  });
}

/** A SQL dataset's own statement ("View query"); null when the dataset was not made by a query. */
export function useDatasetQuery(projectId: string, datasetId: string | null) {
  return useQuery({
    queryKey: ['sql:datasetQuery', projectId, datasetId],
    queryFn: datasetId
      ? async () => {
          const r = (await rpc('sql:datasetQuery', { projectId, datasetId })) as { ok: true; sql: string; params: SqlParam[] } | Fail;
          return r.ok ? r : null;
        }
      : skipToken,
    staleTime: Infinity,
  });
}

const send = async <T,>(p: Promise<unknown>, fallback: string): Promise<T | Fail> => {
  try {
    return ((await p) as T | Fail | null) ?? { ok: false, error: fallback };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message ? e.message : fallback };
  }
};

export const runSql = (projectId: string, sql: string, params: SqlParam[]) => send<RunResult>(rpc('sql:run', { projectId, sql, params }), 'The query could not be sent.');
export const explainSql = (projectId: string, sql: string, params: SqlParam[]) => send<ExplainResult>(rpc('sql:explain', { projectId, sql, params }), 'The query could not be checked.');
export const prepareSave = (projectId: string, sql: string, params: SqlParam[]) => send<PrepareResult>(rpc('sql:prepareSave', { projectId, sql, params }), 'The full result could not be read.');
