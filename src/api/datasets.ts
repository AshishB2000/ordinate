import { z } from 'zod';
import { byProjectId, FileToken, rpc, Uuid } from './contract';

/** One stored cell, as `dataset:page` returns and a filter value carries it. */
const Cell = z.union([z.string().max(10_000), z.number(), z.null()]);

/**
 * A row filter, as a visual carries it (src/data/transforms.ts `FilterStep`).
 * The shape is checked here; the handler still runs every step through the
 * visual-filter whitelist (`sanitizeFilters`), which owns the operator list and
 * the `period` / `radius` specs.
 */
const FilterStep = z.strictObject({
  type: z.literal('filter'),
  column: z.string().max(1_000),
  op: z.string().max(40),
  value: Cell.optional(),
  values: z.array(Cell).max(10_000).optional(),
  period: z.unknown().optional(),
  radius: z.unknown().optional(),
  context: z.boolean().optional(),
});

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
  // preload: invoke('dataset:page', { projectId, datasetId, offset, limit, search, sortColumn, sortDir, filters })
  // — one window of rows for the data grid (web/src/ui/DataGrid). `limit` is
  // the engine's own ceiling (src/engine/datasetPage.ts MAX_LIMIT).
  'dataset:page': rpc({
    access: 'read',
    input: z.strictObject({
      projectId: Uuid,
      datasetId: Uuid,
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      limit: z.number().int().min(0).max(5_000),
      search: z.string().max(1_000).optional(),
      sortColumn: z.string().max(1_000).optional(),
      sortDir: z.enum(['asc', 'desc']).optional(),
      filters: z.array(FilterStep).max(100).optional(),
    }),
    project: byProjectId,
  }),
  // Server only: what a grid needs to draw its header — name, row count and
  // the typed columns — and nothing about where the rows came from
  // (`dataset:meta` carries the origin: a file path, a URL, a SQL statement).
  'dataset:columns': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // preload: invoke('dataset:stats', { projectId, datasetId }) — column summaries + quality issues.
  'dataset:stats': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
  // preload: invoke('dataset:update', { projectId, datasetId, autoRefresh }) — the
  // refresh SCHEDULE only (T2.5's connection rail). The handler also takes
  // `columns` and `watch`; widen this input when a screen needs them.
  'dataset:update': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid, autoRefresh: z.enum(['hourly', 'daily', 'weekly']).nullable() }),
    project: byProjectId,
  }),
} as const;
