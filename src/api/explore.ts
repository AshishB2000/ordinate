import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

export const explore = {
  // Explore's fields and suggested questions (src/ipc/explore.ts): a dataset's
  // DECLARED columns, ranked as starterPlan ranks them, and chart encodings —
  // never a figure, never a row. Every suggestion is drawn through
  // `visual:data`, like any other question Explore asks.
  'explore:suggest': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
} as const;
