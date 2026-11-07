import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';
import { Cell } from './datasets';

/**
 * A Live dataset's cache age, seconds: 0 (always ask the warehouse) to 30
 * days (docs/live-data/00-plan.md D5). The same bounds as
 * src/data/liveDataset.ts MAX_CACHE_AGE_SEC — scripts/test-liveDataset.ts
 * holds the two together, since this file imports nothing but zod.
 */
export const MaxCacheAgeSec = z.number().int().min(0).max(30 * 24 * 60 * 60);

/** One always-applied filter as the editor sends it: a plain filter step, no term, lock, context or radius. */
export const BaseFilterStep = z.strictObject({
  type: z.literal('filter'),
  column: z.string().min(1).max(1_000),
  op: z.string().max(40),
  value: Cell.optional(),
  values: z.array(Cell).max(1_000).optional(),
  period: z.unknown().optional(),
});

export const live = {
  // The dataset's mode (src/ipc/liveDatasets.ts): extract → live drops the
  // stored copy and needs `confirmDrop` (the web's confirm dialog says so);
  // live → extract runs a normal import of the same selection; live → live
  // with `maxCacheAgeSec` sets the cache age. The reply names the dataset by
  // its header only — never the selection's SQL or the connection's address.
  'dataset:setMode': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      datasetId: Uuid,
      mode: z.enum(['extract', 'live']),
      maxCacheAgeSec: MaxCacheAgeSec.optional(),
      confirmDrop: z.boolean().optional(),
    }),
    project: byProjectId,
  }),
  // A saved connection's Live opt-in (src/ipc/liveOptIn.ts, L3.2): the checkbox an OLTP
  // source declares — PostgreSQL's "This is a read replica or a warehouse". `write`, as
  // testAndSave, which sets it on a new connection. Unticking is refused while a Live
  // dataset asks the connection; the reply then says how many.
  'connection:setLiveOptIn': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, connId: Uuid, on: z.boolean() }),
    project: byProjectId,
  }),
  // "Sync schema" on a Live dataset (src/ipc/liveProfile.ts, L2.5): re-read its
  // columns from the warehouse and profile them from one sampled, cost-guarded
  // query; waits for the job and answers counts, column names and the sample's
  // typed outcome — never SQL or warehouse text. `write`: it spends a warehouse
  // query, like a refresh.
  'dataset:syncLiveSchema': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid }),
    project: byProjectId,
  }),
  // The Live dataset page's Schema panel: when it was synced, each column's
  // profile (figures computed server side), its sample values, and the columns
  // gone from the warehouse with what still uses them.
  'dataset:liveSchema': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid }),
    project: byProjectId,
  }),
  // "Make a copy" (src/ipc/liveDatasets.ts, L2.6): what is off for a Live dataset
  // (prepare, the table view, stats, pivots, snapshots…) works on a copy. The
  // selection is imported as a NEW extract beside the Live one — the connector's
  // own bounded run, through the SSRF guard, like any import — and the Live
  // dataset is left as it was. The reply names the copy (id, name, rows), never
  // the selection's SQL or the connection's address. `write`: it saves a dataset.
  'dataset:copyLive': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid }),
    project: byProjectId,
  }),
  // A Live dataset's always-applied filters (src/ipc/liveBaseFilters.ts, semantic layer D13): plain
  // filter steps put into every statement Ordinate sends for it. At most 20, a list of at most 1,000
  // values; the handler refuses, in a sentence, a step this dataset's columns cannot take. `write`:
  // it changes every figure on the dataset, as a Prepare step does on a copy.
  'live:setBaseFilters': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid, filters: z.array(BaseFilterStep).max(20) }),
    project: byProjectId,
  }),
} as const;
