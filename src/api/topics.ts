// Topics (semantic layer part 6, D14–D16, src/ipc/topics.ts): a team's named, ordered short list of the project's
// datasets (each with an optional field subset), metrics and terms. Never access control (D15): every reader still
// answers outside it. Any project reader reads them (`topic:get`, and the list rides `model:navigation`); editing is a
// writer's. Topics keep no version history: the edit-conflict tag and the Trash only.

import { z } from 'zod';
import { Base, byProjectId, rpc, Uuid } from './contract';

const ById = z.strictObject({ projectId: Uuid, id: Uuid });
const Topic = z.strictObject({
  name: z.string().min(1).max(80), // unique in the project, ignoring case: refused with a sentence
  description: z.string().max(500).optional(),
  datasets: z.array(z.strictObject({ id: Uuid, fields: z.array(z.string().min(1).max(256)).max(500).optional() })).max(12), // ordered; no `fields` = all
  metricIds: z.array(Uuid).max(100),
  termIds: z.array(Uuid).max(100),
});

export const topics = {
  // The topic as stored, its tag (the drawer's base), how many of its members have gone since (deleted, or a field a
  // refresh dropped) and the topic without them, which the drawer saves. Ids and names only (scripts/rowPolicyReaders.ts: META).
  'topic:get': rpc({ access: 'read', input: ById, project: byProjectId }),
  // Creates without `id`, replaces the whole topic with one. A member that does not exist is refused with a sentence;
  // a stale `base` is 409 record_changed. `updatedBy` is stamped on the server.
  'topic:save': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid.optional(), base: Base.optional(), topic: Topic }), project: byProjectId }),
  // To the project's Trash, restorable.
  'topic:delete': rpc({ access: 'write', input: ById, project: byProjectId }),
} as const;
