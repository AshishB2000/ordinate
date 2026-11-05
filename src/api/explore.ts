import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

export const explore = {
  // Explore's fields and suggested questions (src/ipc/explore.ts): a dataset's
  // DECLARED columns, ranked as starterPlan ranks them, and chart encodings —
  // never a figure, never a row. `topicId` keeps only the suggestions inside that topic's fields of this dataset;
  // the field lists are unchanged, and a topic that is gone or does not list the dataset changes nothing. Every suggestion is drawn through
  // `visual:data`, like any other question Explore asks.
  'explore:suggest': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid, topicId: Uuid.optional() }), project: byProjectId }),
} as const;
