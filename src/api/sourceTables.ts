import { z } from 'zod';
import { Base, byProjectId, rpc, Uuid } from './contract';

// Source table docs (docs/semantic-layer/02-source-tables.md, D14). Every channel is `write`: a viewer
// is refused 403 before a handler runs, so a source table's name never reaches one. The caps are the
// store's (src/app/sourceTables.ts), which clips again on write.
const Table = z.string().trim().min(1).max(1_000);
/** What a person typed. Facts and dismissals are never a payload: they are written by the server. */
const Patch = z.strictObject({
  owner: z.string().max(80).optional(),
  refresh: z.string().max(200).optional(),
  requiredFilters: z.string().max(500).optional(),
  guide: z.string().max(8_000).optional(),
});
const Doc = { projectId: Uuid, connId: Uuid, docId: Uuid };

export const sourceTables = {
  // The tab's list and its "To fill in next" strip: records only, never the warehouse.
  'sourceTable:list': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // One doc, with the tag to edit it from and the datasets built from its table.
  'sourceTable:get': rpc({ access: 'write', input: z.strictObject(Doc), project: byProjectId }),
  // No docId: create (a table is required; idempotent by its exact name). A docId: edit, with the open copy's tag as `base`.
  'sourceTable:save': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, connId: Uuid, docId: Uuid.optional(), table: Table.optional(), patch: Patch, base: Base.optional() })
      .refine((i) => (i.docId === undefined) !== (i.table === undefined), { message: 'Send a docId to edit or a table to create.' }),
    project: byProjectId,
  }),
  'sourceTable:delete': rpc({ access: 'write', input: z.strictObject(Doc), project: byProjectId }),
  // Read the table's facts from the warehouse, on an editor's click only (60 an hour per connection, any pod).
  'sourceTable:read': rpc({ access: 'write', input: z.strictObject(Doc), project: byProjectId }),
} as const;
