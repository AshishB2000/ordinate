import { z } from 'zod';
import { byProjectId, rpc, Steps, Uuid } from './contract';

export const visuals = {
  // T4.3 (the load test's chart queries; the Visuals screen's port extends it).
  // preload: invoke('visual:data', { projectId, datasetId, encoding, filters, params, analytics }).
  // The handler sanitizes the encoding (`visuals.sanitizeEncoding`), filters and
  // overlays before reading them; this bounds the shape. `share`, `asOf` and
  // `currency` arrive with the screens that use them.
  'visual:data': rpc({
    access: 'read',
    input: z.strictObject({
      projectId: Uuid,
      datasetId: Uuid,
      encoding: z.looseObject({}),
      filters: Steps.optional(),
      params: z.record(z.string().max(200), z.unknown()).optional(),
      analytics: z.array(z.looseObject({})).max(50).optional(),
    }),
    project: byProjectId,
  }),
} as const;
