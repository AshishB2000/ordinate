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
} as const;
