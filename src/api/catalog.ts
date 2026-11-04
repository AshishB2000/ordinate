import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

/** `${kind}:${id}` — the kinds src/app/catalog.ts CATALOG_KINDS documents. */
const Ref = z.string().regex(/^(dataset|visual|analysis|metric|report|story):[0-9a-fA-F-]{36}$/);

/** What a person typed. The store clips each field (src/app/catalog.ts) and stamps who and when itself. */
const DocPatch = z.strictObject({
  description: z.string().max(2_000).optional(),
  owner: z.string().max(80).optional(),
  tags: z.array(z.string().max(64)).max(12).optional(),
});
const ColumnPatch = z.strictObject({
  description: z.string().max(2_000).optional(),
  displayName: z.string().max(120).optional(),
  // "Also called": replaces the list. A name another column answers to is refused with a sentence (app/columnNames.ts).
  aliases: z.array(z.string().max(60)).max(8).optional(),
  example: z.string().max(200).optional(),
  sensitivity: z.enum(['none', 'personal', 'financial']).optional(),
  // What a stored value is CALLED ("EU" → "Europe"): replaces the list, [] removes it. Text columns only; a merge, a repeat, a blank or a
  // missing label is refused with a sentence (analysis/valueLabels.ts), never quietly dropped. The caps are the leaf's MAX_* constants.
  values: z.array(z.strictObject({ value: z.string().min(1).max(256), label: z.string().max(120) })).max(500).optional(),
});

// A table's role, key, grain and guide (src/app/tableDocs.ts). Each field is clipped by the store, which stamps who and when itself
// and never takes a key check from a person: only the fields below can be sent.
const TablePatch = z.strictObject({
  role: z.enum(['', 'fact', 'dimension']).optional(),
  key: z.string().max(256).optional(),
  grain: z.string().max(200).optional(),
  guide: z.string().max(8_000).optional(),
});

export const catalog = {
  // preload: invoke('catalog:list', { projectId }) — every record with its docs, usage and staleness.
  'catalog:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // preload: invoke('catalog:tags', { projectId }) — the project's tags and which records carry them.
  'catalog:tags': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // preload: invoke('catalog:get', { projectId, ref }) / ('catalog:set', { projectId, ref, patch })
  'catalog:get': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, ref: Ref }), project: byProjectId }),
  'catalog:set': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, ref: Ref, patch: DocPatch }), project: byProjectId }),
  // preload: invoke('catalog:columns', { projectId, datasetId }) / ('catalog:setColumn', { …, column, patch })
  'catalog:columns': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
  'catalog:setColumn': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid, column: z.string().min(1).max(256), patch: ColumnPatch }),
    project: byProjectId,
  }),
  // "Remember" on an Assistant answer card: ONE more "Also called" name, appended inside the catalog's
  // write — the same rules as the Columns tab's field, and a full list refused with a sentence.
  'catalog:addAlias': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid, column: z.string().min(1).max(256), alias: z.string().trim().min(1).max(60) }),
    project: byProjectId,
  }),
  // preload: invoke('catalog:getTable', { projectId, datasetId }) / ('catalog:setTable', { …, patch }) / ('catalog:checkKey', { … })
  // The table's key check counts every row, so a caller row access rules restrict gets the doc without it (REDACT).
  'catalog:getTable': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
  // A new key on an extract is checked before the reply; on a Live dataset it never is (D2).
  'catalog:setTable': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid, patch: TablePatch }), project: byProjectId }),
  // "Check now": one count of the declared key. On a Live dataset the one statement that asks the warehouse.
  'catalog:checkKey': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
} as const;
