import { z } from 'zod';
import { byProjectId, FileToken, rpc, Steps, Uuid } from './contract';

export const datasets = {
  // preload: invoke('dataset:list', { projectId })
  'dataset:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // Server form of the file import: the file was uploaded through POST
  // /api/files first; a path or a native dialog never applies on the server.
  // `write`: it consumes the upload and stages a table for a save. Org-level:
  // the upload names no project yet (the save that follows does).
  'dataset:pickAndParse': rpc({
    access: 'write',
    org: true,
    input: z.strictObject({ fileToken: FileToken, sheetName: z.string().min(1).max(255).optional() }),
  }),
  // T4.3 (the load test's dataset flow; the Data screen's port reuses them).
  // preload: invoke('dataset:meta', { projectId, id }) — the record without its rows.
  'dataset:meta': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // preload: invoke('dataset:page', {...}) — one window of rows, searched / sorted /
  // filtered in DuckDB. Filters go through the handler's own whitelist
  // (`transforms.sanitizeSteps`); this only bounds their shape and count.
  'dataset:page': rpc({
    access: 'read',
    input: z.strictObject({
      projectId: Uuid,
      datasetId: Uuid,
      offset: z.number().int().min(0).max(1_000_000_000),
      limit: z.number().int().min(1).max(10_000),
      search: z.string().max(1000).optional(),
      sortColumn: z.string().max(1000).nullable().optional(),
      sortDir: z.enum(['asc', 'desc']).optional(),
      filters: Steps.optional(),
    }),
    project: byProjectId,
  }),
  // preload: invoke('dataset:stats', { projectId, datasetId }) — column summaries + quality issues.
  'dataset:stats': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
} as const;
