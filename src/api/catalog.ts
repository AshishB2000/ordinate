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
  example: z.string().max(200).optional(),
  sensitivity: z.enum(['none', 'personal', 'financial']).optional(),
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
} as const;
