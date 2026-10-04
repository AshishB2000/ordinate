import { z } from 'zod';
import { byProjectId, FileToken, rpc, Uuid } from './contract';

/** A column name as the dataset record holds it. */
const Column = z.string().min(1).max(512);

/** VizGeo (src/analysis/visuals.ts) — every level and column a map reads (T1.3). Strict: an unknown level is a 400. */
const Geo = z.strictObject({
  level: z.enum(['country', 'us_state', 'us_county', 'us_city', 'us_zip', 'world_city', 'point', 'custom', 'hexbin', 'flow']),
  lat: Column.optional(),
  lon: Column.optional(),
  lat2: Column.optional(),
  lon2: Column.optional(),
  from: Column.optional(),
  to: Column.optional(),
  color: Column.optional(),
  boundaryId: Uuid.optional(),
  property: z.string().max(200).optional(),
  basemap: z.enum(['osm', 'none']).optional(),
});

/** The radius control's `within_km` spec on a filter step (T1.3): a point on the globe and a distance on it. */
const Radius = z.strictObject({
  lngColumn: Column,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  km: z.number().positive().max(20_016),
  place: z.string().max(200).optional(),
});

/** Filter steps: loose (the handler's own whitelist owns the operators), but a radius, when present, is checked. */
const Filters = z.array(z.looseObject({ type: z.string().max(64), radius: Radius.optional() })).max(200);

/**
 * A chart's encoding: the dimension and the measures every chart has, checked
 * here; the family-specific shelves (series, grain, bins, geo, pivot, cohort,
 * eventFunnel, facet, overlay, drivers, …) ride through and are whitelisted
 * field by field by `sanitizeEncoding` (src/analysis/visuals.ts) before
 * anything reads them — the handler sanitizes every encoding, contracted or not.
 */
const Encoding = z.looseObject({
  category: z.string().max(512),
  values: z
    .array(
      z.looseObject({
        column: Column,
        aggregation: z.enum(['sum', 'avg', 'count', 'min', 'max', 'none']),
      }),
    )
    .max(64),
  geo: Geo.optional(),
});

const VizDataInput = z.strictObject({
  projectId: Uuid,
  datasetId: Uuid,
  encoding: Encoding,
  filters: Filters.optional(),
  params: z.record(z.string().max(200), z.unknown()).optional(),
  analytics: z.array(z.looseObject({})).max(50).optional(),
  // T2.7: the answer is about to LEAVE the app (Copy data) — the project's
  // Share policy shapes it first (app/sharePolicy.ts).
  share: z.literal('export').optional(),
  // T2.11: "As of" — every dataset read as it was at this time (src/data/asOf.ts; view state, never saved).
  asOf: z.string().max(40).optional(),
});

/** What a visual IS, as `visual:save` stores it; `visual:update` takes any part of it. */
const Definition = {
  name: z.string().max(200),
  chartType: z.string().min(1).max(64),
  encoding: Encoding,
  overrides: z.looseObject({}).optional(),
  filters: Filters.optional(),
  analytics: z.array(z.looseObject({})).max(50).optional(),
};
const Patch = {
  name: Definition.name.optional(),
  chartType: Definition.chartType.optional(),
  encoding: Encoding.optional(),
  overrides: Definition.overrides,
  filters: Definition.filters,
  analytics: Definition.analytics,
};

/** One stored cell — a clicked mark's category / series value. */
const Cell = z.union([z.string().max(10_000), z.number(), z.null()]);

/** What a drill reads: the figure's definition and filters, and optionally ONE clicked mark. */
const Drill = {
  projectId: Uuid,
  datasetId: Uuid,
  encoding: Encoding,
  filters: Filters.optional(),
  params: z.record(z.string().max(200), z.unknown()).optional(),
  mark: z.strictObject({ category: Cell.optional(), series: Cell.optional() }).nullable().optional(),
};
const DrillPage = z.strictObject({
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(5_000).optional(),
  search: z.string().max(1_000).optional(),
  sortColumn: z.string().max(1_000).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

/** The eight colour slots (src/analysis/colorMap.ts COLOR_TOKENS). */
const COLOR_TOKENS = ['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6', 'chart-7', 'chart-8'] as const;
const ColorColumn = { projectId: Uuid, column: Column };
const ColorValues = z.array(Cell).max(1_000);

export const visuals = {
  // preload: invoke('visual:data', { projectId, datasetId, encoding, filters }) — the
  // `{labels, series}` a chart draws (T1.1). The dataset is read from the
  // project's own directory, so naming another project's dataset finds
  // nothing. Filters are transform `filter` steps, re-sanitized by the
  // handler. `params` / `share` / `analytics` / `asOf` / `currency` join with
  // the screens that send them.
  'visual:data': rpc({ access: 'read', input: VizDataInput, project: byProjectId }),
  // Server only (T2.1): up to 50 `visual:data` requests of one project in one
  // call, answered in order — what a page of charts sends instead of one RPC
  // per tile (web/src/api/visuals.ts batches them; plan §9's budget).
  'visual:dataBatch': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, items: z.array(VizDataInput.omit({ projectId: true })).min(1).max(50) }),
    project: byProjectId,
  }),

  // ── The Visuals screen (T2.7) ────────────────────────────────────────────
  // A saved visual's definition: every handler runs it through its own
  // whitelist (sanitizeEncoding / sanitizeOverrides / sanitizeFilters /
  // sanitizeOverlays) before it is written or read.
  'visual:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'visual:get': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  'visual:save': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid, ...Definition }), project: byProjectId }),
  // A patch: only what is sent changes. `favorite` alone is the gallery's star.
  'visual:update': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, id: Uuid, ...Patch, favorite: z.boolean().optional() }),
    project: byProjectId,
  }),
  // To the project's Trash (30 days). The desktop's `permanent` (taking back an
  // Assistant's draft) is not offered here.
  'visual:delete': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  'visual:duplicate': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // The builder's preview: `visual:data`, except that a big table with no
  // resident fast path is answered on a stratified sample (src/ipc/vizSample.ts).
  'visual:preview': rpc({ access: 'read', input: VizDataInput, project: byProjectId }),
  // Server only: the gallery's thumbnails — each saved visual's `visual:data`,
  // computed from its STORED definition, in one call (src/ipc/visualsServer.ts).
  'visual:thumbs': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, ids: z.array(Uuid).min(1).max(50) }), project: byProjectId }),
  // The AI chart suggestion: STRUCTURE only (an encoding, a type, a caption),
  // sanitized by the handler; the browser draws each through `visual:data`.
  // `intent` is the user's own words and reaches the model as the user message.
  'visual:suggest': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid, intent: z.string().max(2_000).optional() }),
    project: byProjectId,
  }),
  // Map regions: the project's imported boundary sets, and an import — on the
  // server the GeoJSON is uploaded first (POST /api/files) and named by token.
  'boundary:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'boundary:import': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, fileToken: FileToken }), project: byProjectId }),
  // Columns of the datasets this one reaches without fan-out — the builder's
  // "from <dataset>" groups. Handler: src/ipc/relationships.ts.
  'relationship:related': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),

  // ── T2.7 part 2: drill, period picker, the project colour map ────────────
  // The rows behind a figure (or one clicked mark): main composes the filters
  // (resolveDrill) and pages, searches and sorts in SQL; a refusal says why.
  'visual:rows': rpc({ access: 'read', input: z.strictObject({ ...Drill, page: DrillPage.optional() }), project: byProjectId }),
  // Server only: the same row set as a CSV download (T0.4 token), Share-policy shaped.
  'visual:rowsDownload': rpc({
    access: 'read',
    audit: true,
    input: z.strictObject({ ...Drill, page: DrillPage.omit({ offset: true, limit: true }).optional(), name: z.string().max(200).optional() }),
    project: byProjectId,
  }),
  // Server only: the relative-period presets with their names, and a spec's
  // dates today — both under the workspace calendar (src/analysis/dateIntel.ts).
  'period:picker': rpc({ access: 'read', org: true, input: z.strictObject({ spec: z.looseObject({ preset: z.string().max(40) }).optional() }) }),
  // The project's category colours (src/ipc/format.ts): read; deal the values
  // a chart drew; set one value; reset a column; re-deal a palette.
  'format:colors:get': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'format:colors:assign': rpc({ access: 'write', input: z.strictObject({ ...ColorColumn, values: ColorValues }), project: byProjectId }),
  'format:colors:set': rpc({
    access: 'write',
    input: z.strictObject({ ...ColorColumn, value: z.string().max(1_000), token: z.enum(COLOR_TOKENS).nullable() }),
    project: byProjectId,
  }),
  'format:colors:reset': rpc({ access: 'write', input: z.strictObject(ColorColumn), project: byProjectId }),
  'format:colors:palette': rpc({ access: 'write', input: z.strictObject({ ...ColorColumn, values: ColorValues }), project: byProjectId }),
} as const;
