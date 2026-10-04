import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

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
});

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
} as const;
