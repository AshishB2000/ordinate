import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

export const lineage = {
  // preload: invoke('lineage:get', { projectId, type, id }) — the laid-out graph
  // around one record. Source nodes are keyed without their path or URL
  // (src/ipc/lineage.ts `redactSources`).
  'lineage:get': rpc({
    access: 'read',
    input: z.strictObject({
      projectId: Uuid,
      type: z.enum(['dataset', 'visual', 'dashboard', 'metric', 'report', 'alert']),
      id: Uuid,
    }),
    project: byProjectId,
  }),
  // lineage:column → the graph around one column of a dataset (or a calculated field), with "Used in" counts and the
  // number of records it is built from; null when nothing reads it. Names only; sources pass `redactSources`.
  'lineage:column': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid, column: z.string().min(1).max(1_000) }),
    project: byProjectId,
  }),
  // lineage:fields → { ok, fields: { [column]: { usedIn } }, steps: [{ index, produces, usedIn }] }: a dataset's "Used by".
  'lineage:fields': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid }),
    project: byProjectId,
  }),
} as const;
