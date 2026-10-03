import { z } from 'zod';
import { byProjectId, rpc, Steps, Uuid } from './contract';

/** A column name as the dataset record holds it. */
const Column = z.string().min(1).max(512);

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
});

export const visuals = {
  // preload: invoke('visual:data', { projectId, datasetId, encoding, filters }) — the
  // `{labels, series}` a chart draws (T1.1). The dataset is read from the
  // project's own directory, so naming another project's dataset finds
  // nothing. Filters are transform `filter` steps, re-sanitized by the
  // handler. `params` / `share` / `analytics` / `asOf` / `currency` join with
  // the screens that send them.
  'visual:data': rpc({
    access: 'read',
    input: z.strictObject({
      projectId: Uuid,
      datasetId: Uuid,
      encoding: Encoding,
      filters: Steps.optional(),
      params: z.record(z.string().max(200), z.unknown()).optional(),
      analytics: z.array(z.looseObject({})).max(50).optional(),
    }),
    project: byProjectId,
  }),
} as const;
