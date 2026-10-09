import { z } from 'zod';
import { byProjectId, FileToken, rpc, Steps, Uuid } from './contract';

/** One stored cell, as `dataset:page` returns and a filter value carries it. */
export const Cell = z.union([z.string().max(10_000), z.number(), z.null()]);

/** A column as a parse or a dataset record types it. */
export const TypedColumn = z.strictObject({ name: z.string().max(512), type: z.enum(['text', 'number', 'date']) });

/**
 * One table of the composer chain (src/ipc/datasetCompose.ts): a saved
 * dataset, or the import being made — staged on the server by its parse
 * (`stagedId`, bound to the caller: src/data/importStage.ts) or, for a
 * screenshot capture whose cells the user corrects, carried inline.
 */
const TableRef = z.union([
  z.strictObject({ datasetId: Uuid }),
  z.strictObject({
    inline: z.strictObject({
      name: z.string().max(200),
      stagedId: Uuid.optional(),
      columns: z.array(TypedColumn).max(1_000).optional(),
      rows: z.array(z.array(Cell).max(1_000)).max(20_000).optional(),
    }),
  }),
]);

/** A table joined (or appended) onto the chain — always a saved dataset. */
const Join = z.strictObject({
  datasetId: Uuid,
  mode: z.enum(['inner', 'left', 'append']),
  on: z.strictObject({ left: z.string().max(512), right: z.string().max(512) }).optional(),
});

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

  // ── The Data section (T2.3) ──────────────────────────────────────────────
  // preload: invoke('dataset:delete', { projectId, id }) — a move to the Trash.
  'dataset:delete': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // preload: invoke('dataset:refresh', { projectId, id }) — re-fetch from the origin, as a job.
  // The reply names the dataset by its header only (src/ipc/datasets.ts `headerOf`), never its origin.
  'dataset:refresh': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // preload: invoke('dataset:update', { projectId, datasetId, columns | autoRefresh | watch }) —
  // rename / retype columns (indexed against the shown, prepared columns; resolved by name — src/data/columnEdit.ts), the refresh
  // schedule and the anomaly watch. Same header-only reply.
  'dataset:update': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      datasetId: Uuid,
      columns: z.array(z.strictObject({ name: z.string().min(1).max(512), type: z.enum(['text', 'number', 'date']) })).max(5_000).optional(),
      autoRefresh: z.enum(['hourly', 'daily', 'weekly', 'off', '5min', '15min']).nullable().optional(),
      watch: z.boolean().optional(),
    }),
    project: byProjectId,
  }),
  // Server only (src/ipc/datasetViews.ts): where the rows came from, REDACTED —
  // a kind, a display label and whether it can be re-fetched. Never a path, a
  // URL's path or query, a statement or a key (`dataset:meta` has all of those).
  'dataset:source': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // Server only: one column's profile panel — every figure on it (filled %,
  // distinct, min / median / max, the histogram or top values and their bar
  // lengths) computed here, so the browser only formats.
  'dataset:profile': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid, column: z.string().min(1).max(512) }),
    project: byProjectId,
  }),
  // preload: invoke('dataSearch:query', { projectId, term }) — values inside this
  // project's datasets. A project is REQUIRED here: the desktop's '' (every
  // project) would read projects the caller may not.
  'dataSearch:query': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, term: z.string().min(2).max(200) }),
    project: byProjectId,
  }),
  // preload: invoke('dataset:parsePaste', { text }) — parses pasted CSV / TSV /
  // JSON and stages the rows for the composer. Org-level like the file parse
  // (the save that follows names the project). The RPC body cap (1 MiB) bounds
  // a paste; a bigger table is uploaded as a file.
  'dataset:parsePaste': rpc({ access: 'write', org: true, input: z.strictObject({ text: z.string().max(900_000) }) }),
  // The composer (src/ipc/datasetCompose.ts): one window of the folded chain,
  // computed from the first 50k rows of each table. `offset` + `limit` are
  // the DataGrid's blocks (the desktop pages by `page`).
  'dataset:composePreview': rpc({
    access: 'read',
    input: z.strictObject({
      projectId: Uuid,
      base: TableRef,
      joins: z.array(Join).max(20),
      offset: z.number().int().min(0).max(1_000_000),
      limit: z.number().int().min(0).max(500),
    }),
    project: byProjectId,
  }),
  // Save the chain as a new dataset (a job). The field mapping arrives as
  // prepare steps (renames, drops — whitelisted again by commitSteps) and
  // retypes. A server import has no re-readable origin: only a capture's link
  // back to its screenshot, checked against THIS project by the handler.
  'dataset:composeSave': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      name: z.string().max(200),
      base: TableRef,
      joins: z.array(Join).max(20),
      steps: Steps,
      sourceKind: z.enum(['csv', 'json', 'xlsx', 'parquet', 'paste', 'capture', 'sql']).optional(),
      origin: z
        .union([
          z.strictObject({ kind: z.literal('capture'), captureId: z.string().regex(/^[0-9a-zA-Z_-]{1,64}$/) }),
          // T2.11: SQL over the project's datasets, as sql:prepareSave returned it. Refresh re-runs it
          // through the same read-only gate and engine lock; sanitizeOrigin owns every field.
          z.strictObject({
            kind: z.literal('sql'),
            sql: z.string().max(20_000),
            deps: z.array(Uuid).max(200),
            params: z.array(z.looseObject({ name: z.string().max(40) })).max(32).optional(),
          }),
        ])
        .optional(),
      retype: z.array(TypedColumn).max(1_000).optional(),
    }),
    project: byProjectId,
  }),
  // preload: invoke('dataset:distinct', { projectId, datasetId, column, limit, search })
  // — a column's distinct values, searched in SQL, with the true total (an
  // input table's lookup list; a quality rule's allowed-values prefill, T2.3).
  'dataset:distinct': rpc({
    access: 'read',
    input: z.strictObject({
      projectId: Uuid,
      datasetId: Uuid,
      column: z.string().max(512),
      limit: z.number().int().min(1).max(200).optional(),
      search: z.string().max(200).optional(),
    }),
    project: byProjectId,
  }),
} as const;
