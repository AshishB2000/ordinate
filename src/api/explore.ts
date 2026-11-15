import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

export const explore = {
  // Explore's fields and suggested questions (src/ipc/explore.ts): a dataset's
  // DECLARED columns, ranked as starterPlan ranks them, and chart encodings —
  // never a figure, never a row. `topicId` keeps only the suggestions inside that topic's fields of this dataset;
  // the field lists are unchanged, and a topic that is gone or does not list the dataset changes nothing. Every suggestion is drawn through
  // `visual:data`, like any other question Explore asks.
  // `table` (phase D, editors only): `datasetId` is then a source table doc's id and `table` its connection's, as
  // AnswerSpec.table — the fields are its facts' columns, declared as a Live dataset's. A viewer's is "no such dataset".
  'explore:suggest': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid, topicId: Uuid.optional(), table: Uuid.optional() }), project: byProjectId }),
  // Keep as a dataset: that table's Live dataset, made through the connection's own Live create (src/ipc/sourceKeep.ts).
  'explore:keepTable': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid, table: Uuid, folderId: Uuid.optional() }), project: byProjectId }),
} as const;
