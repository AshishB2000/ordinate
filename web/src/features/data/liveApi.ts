// A Live dataset's own calls (docs/live-data/00-plan.md L2.5, L2.6): the Schema
// panel (`dataset:liveSchema`), "Sync schema" (`dataset:syncLiveSchema`), the
// cache age (`dataset:setMode` live → live) and "Refresh now" (`dataset:refresh`,
// which on a Live dataset bumps the cache epoch). Every figure in a reply — a
// filled share, a distinct count, the sample's size — is the server's; the
// screens only format it. No reply carries SQL, a host or warehouse text.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { replyError } from '../live/refusal';

/** src/ipc/liveProfile.ts SchemaColumn. */
export interface SchemaColumn {
  name: string;
  type: 'text' | 'number' | 'date';
  filled: number | null;
  /** Filled share of the sample, rounded by the server. */
  filledPct: number | null;
  distinct: number | null;
  values: string[];
  /** Distinct values in the sample past the ones listed. */
  more: number;
  /** A model is never shown this column's values. */
  withheld: boolean;
}

export type MissingUseKind = 'visual' | 'metric' | 'kpi' | 'control' | 'alert';
export interface MissingColumn {
  column: string;
  usedBy: { kind: MissingUseKind; id: string; name: string; dashboardId?: string }[];
}

/** src/ipc/liveProfile.ts LiveSchemaView. */
export interface LiveSchema {
  ok: true;
  schemaSyncedAt: string;
  syncing: boolean;
  sampledAt: string | null;
  sampleRows: number | null;
  method: 'sample' | 'limit' | null;
  /** Why the last sync read no sample (a catalog sentence), or null. */
  note: string | null;
  columns: SchemaColumn[];
  missing: MissingColumn[];
}

type Fail = { ok: false; error?: string; code?: string };

export const useLiveSchema = (projectId: string, datasetId: string, on = true) =>
  useQuery({
    queryKey: ['dataset:liveSchema', projectId, datasetId],
    enabled: on,
    queryFn: async () => {
      const r = (await rpc('dataset:liveSchema', { projectId, datasetId })) as LiveSchema | Fail;
      if (!r.ok) throw replyError(r, 'The schema could not be read.');
      return r;
    },
  });

/** src/engine/live/schemaSync.ts SyncReport, plus the job's status. */
export type SyncReply =
  | { ok: true; status: 'synced'; columns: number; added: string[]; removed: string[]; retyped: string[]; missing: string[]; sample: { ok: true; rows: number } | { ok: false; error: string } }
  | { ok: true; status: 'already_running'; message: string }
  | Fail;

/** What a sync or a cache change moves on screen. */
const AFTER = ['dataset:liveSchema', 'dataset:columns', 'dataset:list', 'dataset:source', 'lineage:get', 'dataset:distinct'] as const;

function useLiveWrite<R>(call: () => Promise<R>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => {
      for (const key of AFTER) void client.invalidateQueries({ queryKey: [key] });
    },
  });
}

/** "Sync schema": re-read the columns and the sample from the warehouse (one cost-guarded query). */
export const useSyncSchema = (projectId: string, datasetId: string) =>
  useLiveWrite(async () => (await rpc('dataset:syncLiveSchema', { projectId, datasetId })) as SyncReply);

/** How old a cached answer may be, in seconds (0 = always ask). */
export const useSetCacheAge = (projectId: string, datasetId: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (maxCacheAgeSec: number) =>
      (await rpc('dataset:setMode', { projectId, datasetId, mode: 'live', maxCacheAgeSec })) as { ok: true; maxCacheAgeSec: number } | Fail,
    onSuccess: () => {
      for (const key of ['dataset:list', 'dataset:source']) void client.invalidateQueries({ queryKey: [key] });
    },
  });
};

/** "Refresh now" on a Live dataset: the cache epoch moves, so the next figure asks the warehouse. */
export const useResetCache = (projectId: string, datasetId: string) =>
  useLiveWrite(async () => (await rpc('dataset:refresh', { projectId, id: datasetId })) as { ok: true; live?: { epoch: number } } | Fail);
