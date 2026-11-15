// Verified questions (semantic layer part 3 D5, D7; src/ipc/verified.ts): a question the team signed off, stored as its
// answer SPEC, never a figure. An edit is `verified:save` with `id` and `base`, the edit-conflict tag (no update channel).
// A caller row access rules close the dataset to reads a question whose spec compares with a row value without its
// spec (scripts/rowPolicyReaders.ts: REDACT).

import { z } from 'zod';
import { Base, byProjectId, rpc, Uuid } from './contract';

/** A stored answer spec; src/ai/answerSpec.ts `sanitizeStoredSpec` whitelists the rest. */
const Spec = z.looseObject({ datasetId: Uuid });
// An SQL answer's statement (the SQL lane): the gate (src/engine/sqlDatasets.ts compile) refuses anything but one read
// over the project's datasets, and runs it once before it is kept; its datasets are the gate's, never the browser's.
const Sql = z.string().trim().min(1).max(20_000);
export const VerifiedInput = z.strictObject({
  question: z.string().trim().min(1).max(300),
  phrasings: z.array(z.string().max(300)).max(8).optional(),
  note: z.string().max(500).optional(), // '' clears it
  spec: Spec.optional(),
  sql: Sql.optional(),
}).refine((v) => (v.spec === undefined) !== (v.sql === undefined), { message: 'A verified question is a chart spec or one SQL statement.' });

export const verified = {
  // The project's questions, those of `datasetId` first, then newest; each says whether it still runs, and why not.
  'verified:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid.optional() }), project: byProjectId }),
  // Draws the spec once (row lock, Live door) before it is kept; with `id`, an edit in place, `base` its tag (409 when stale).
  // With `sql` (a new question only, no `id`): the statement runs once through the Query tab's gate, as `sql:run`.
  'verified:save': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, id: Uuid.optional(), base: Base.optional(), input: VerifiedInput }),
    project: byProjectId,
  }),
  // To the project's Trash, restorable.
  'verified:delete': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // Check the Assistant (D13 (3)): queues the run as a job and replies at once, `{ ok: true, runId }` or a refusal sentence.
  'verified:check': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // The last check from its record, on any pod: no spec, no figure; a result on a dataset closed to the caller has no reason.
  'verified:checkResult': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
} as const;
