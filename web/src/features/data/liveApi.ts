// A Live dataset's own calls (docs/live-data/00-plan.md L2.5, L2.6): the Schema
// panel (`dataset:liveSchema`), "Sync schema" (`dataset:syncLiveSchema`), the
// cache age (`dataset:setMode` live → live) and "Refresh now" (`dataset:refresh`,
// which on a Live dataset bumps the cache epoch). Every figure in a reply — a
// filled share, a distinct count, the sample's size — is the server's; the
// screens only format it. No reply carries SQL, a host or warehouse text.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { toast } from '../../ui/Toast';
import { replyError } from '../live/refusal';
import type { FilterStep } from '../visuals/api';
import type { FormulaCheck } from '../prepare/api';

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

/** One Live calculated field (src/ipc/liveCalcs.ts CalcField): `problem` is why it no longer runs; `hidden`, its formula withheld. */
export interface CalcField {
  name: string;
  expression: string;
  type: 'number' | 'text';
  problem?: string;
  hidden?: true;
}

/** src/ipc/liveCalcs.ts CalculatedView: `allowed` is false where calcs are refused (Databricks), with `why`. */
export interface LiveCalculated {
  allowed: boolean;
  why?: string;
  fields: CalcField[];
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
  /** The always-applied filters (D13). A caller row access rules restrict gets each one's column and operator only. */
  baseFilters: FilterStep[];
  /** Absent from a server older than semantic layer part 8 step 04. */
  calculated?: LiveCalculated;
}

type Fail = { ok: false; error?: string; code?: string };

export const useLiveSchema = (projectId: string, datasetId: string, on = true) =>
  useQuery({
    queryKey: ['dataset:liveSchema', projectId, datasetId],
    enabled: on,
    // A sync another door queued (a filter change, a create) lands with no event when the columns stay the same.
    refetchInterval: (q) => (q.state.data?.syncing ? 1500 : false),
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

function useLiveWrite<R, V = void>(call: (v: V) => Promise<R>, after: readonly string[] = AFTER) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: call,
    onSuccess: () => {
      for (const key of after) void client.invalidateQueries({ queryKey: [key] });
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

export type SetBaseFiltersReply = { ok: true; baseFilters: FilterStep[]; epoch: number } | Fail;

/** "Always applied": save a Live dataset's base filters. A refusal is the server's sentence, as a toast; the caller keeps the edit. */
export const useSetBaseFilters = (projectId: string, datasetId: string) =>
  useLiveWrite(async (filters: FilterStep[]) => {
    const r = (await rpc('live:setBaseFilters', { projectId, datasetId, filters })) as SetBaseFiltersReply;
    if (!r.ok) toast(r.error || 'The filters could not be saved.', { kind: 'error' });
    return r;
  }, ['dataset:liveSchema', 'dataset:distinct']); // the columns stay; figures elsewhere hear the server's refresh event

/** "Refresh now" on a Live dataset: the cache epoch moves, so the next figure asks the warehouse. */
export const useResetCache = (projectId: string, datasetId: string) =>
  useLiveWrite(async () => (await rpc('dataset:refresh', { projectId, id: datasetId })) as { ok: true; live?: { epoch: number } } | Fail);

/** `live:setCalculated`'s refusal: the sentence, which field (`index`) and where in its formula (`at`). */
export type SetCalculatedReply =
  | { ok: true; calculated: { name: string; expression: string; type: 'number' | 'text' }[] }
  | { ok: false; error?: string; code?: string; index?: number; at?: { start: number; end: number } };

/** Replace a Live dataset's calculated fields (the whole list, in order); the server checks and types each. */
export const useSetCalculated = (projectId: string, datasetId: string) => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (calculated: { name: string; expression: string }[]) =>
      (await rpc('live:setCalculated', { projectId, datasetId, calculated })) as SetCalculatedReply,
    onSuccess: (r) => {
      if (r.ok) for (const key of AFTER) void client.invalidateQueries({ queryKey: [key] });
    },
  });
};

/** The formula editor's check of a Live calc: no rows, no warehouse call. `before`: the field's place in the list. */
export const checkLiveCalc = async (projectId: string, datasetId: string, expression: string, before?: number) =>
  (await rpc('live:checkCalc', { projectId, datasetId, expression, ...(before === undefined ? {} : { before }) })) as FormulaCheck;
