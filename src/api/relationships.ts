import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

const End = z.strictObject({ datasetId: Uuid, column: z.string().min(1).max(512) });

export const relationships = {
  // preload (hubAuthoring): invoke('relationship:list', { projectId }) — each with its match rate, computed in main.
  'relationship:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // invoke('relationship:save', { projectId, relationship }) — counts matches over the full tables before saving.
  'relationship:save': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      relationship: z.strictObject({ id: Uuid.optional(), from: End, to: End, cardinality: z.enum(['many_to_one', 'one_to_one']) }),
    }),
    project: byProjectId,
  }),
  'relationship:delete': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // invoke('relationship:suggest', { projectId, fromId, toId }) — key pairs ranked by name, type and a sampled match rate.
  'relationship:suggest': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, fromId: Uuid, toId: Uuid }),
    project: byProjectId,
  }),
} as const;
