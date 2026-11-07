// Glossary terms (semantic D10–D12, src/ipc/terms.ts): a named row filter on one dataset — "EMEA",
// "Enterprise", "Recent order" — that a filter list references as `{ type: 'term', term: <id> }`.
// A viewer reads a term's names and description; a viewer row access rules restrict gets no filter
// value (scripts/rowPolicyReaders.ts: REDACT).

import { z } from 'zod';
import { Base, byProjectId, rpc, Steps, Uuid } from './contract';

const Fields = {
  name: z.string().min(1).max(200),
  aliases: z.array(z.string().max(60)).max(8).optional(), // "Also called" (app/columnNames sanitizeAliases)
  description: z.string().max(500).optional(), // '' clears it
  datasetId: Uuid,
  filters: Steps.max(50), // 1–50 plain filter steps; a term inside a term is refused with a sentence
};
const ById = z.strictObject({ projectId: Uuid, id: Uuid });

export const terms = {
  'term:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'term:get': rpc({ access: 'read', input: ById, project: byProjectId }),
  // A name or alias a metric or another term holds is refused with a reason and the box it belongs beside.
  'term:save': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, input: z.strictObject(Fields) }), project: byProjectId }),
  // The dataset is immutable: a term's columns are that table's.
  'term:update': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      id: Uuid,
      base: Base.optional(), // the editor's tag (contract.ts Base)
      patch: z.strictObject({ name: Fields.name.optional(), aliases: Fields.aliases, description: Fields.description, filters: Fields.filters.optional() }),
    }),
    project: byProjectId,
  }),
  // To the project's Trash, restorable. A figure that still uses it is refused with its name until then.
  'term:delete': rpc({ access: 'write', input: ById, project: byProjectId }),
} as const;
