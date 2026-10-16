import { z } from 'zod';
import { byProjectId, FileToken, rpc, Uuid } from './contract';

// Rebuild a dashboard from a screenshot (docs/rebuild-from-screenshot/,
// src/ipc/rebuild.ts). Neither channel creates a record — creating the
// dashboard is `analysis:buildPlan` with the plan `rebuild:match` returns — so
// both are `read`, as `analysis:draft` and `analysis:previewPlan` are.

const Text = z.string().max(200);
const Agg = z.enum(['sum', 'avg', 'count', 'min', 'max']);
/** A reading as `rebuild:read` returned it. Sanitized again on the way in (rebuildRead.sanitizeReading). */
const Reading = z.strictObject({
  title: Text,
  tool: z.string().max(20),
  tiles: z.array(z.looseObject({
    kind: z.string().max(20),
    chart: z.string().max(40).optional(),
    title: Text.optional(),
    box: z.looseObject({}).nullable().optional(),
    dimension: Text.optional(),
    measures: z.array(z.looseObject({ field: Text })).max(4).optional(),
    series: Text.optional(),
    filterKind: z.string().max(20).optional(),
  })).max(24),
});
/** The check screen's corrections. Every value is checked against the dataset's declared columns (rebuildPlan.rebuildTile). */
const Override = z.strictObject({
  id: z.number().int().min(1).max(24),
  dropped: z.boolean().optional(),
  chartType: z.string().max(40).optional(),
  title: z.string().max(80).optional(),
  fields: z.record(
    z.string().regex(/^(?:category|split|filter|value[0-3])$/),
    z.strictObject({ column: z.string().max(512).nullable(), aggregation: Agg.optional() }),
  ).optional(),
});

export const rebuild = {
  // AI: an uploaded screenshot of a dashboard → its STRUCTURE (tiles, kinds,
  // titles, field names, boxes). No figure; nothing stored.
  'rebuild:read': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, fileToken: FileToken }), project: byProjectId }),
  // NOT AI: a reading matched to one dataset's columns, with the user's
  // corrections — the tiles, their engine-computed previews, and the plan.
  'rebuild:match': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid, reading: Reading, overrides: z.array(Override).max(24).optional() }),
    project: byProjectId,
  }),
} as const;
