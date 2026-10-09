import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

/**
 * A Live dataset's cache age, seconds: 0 (always ask the warehouse) to 30
 * days (docs/live-data/00-plan.md D5). The same bounds as
 * src/data/liveDataset.ts MAX_CACHE_AGE_SEC — scripts/test-liveDataset.ts
 * holds the two together, since this file imports nothing but zod.
 */
export const MaxCacheAgeSec = z.number().int().min(0).max(30 * 24 * 60 * 60);

export const live = {
  // The dataset's mode (src/ipc/liveDatasets.ts): extract → live drops the
  // stored copy and needs `confirmDrop` (the web's confirm dialog says so);
  // live → extract runs a normal import of the same selection; live → live
  // with `maxCacheAgeSec` sets the cache age. The reply names the dataset by
  // its header only — never the selection's SQL or the connection's address.
  'dataset:setMode': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      datasetId: Uuid,
      mode: z.enum(['extract', 'live']),
      maxCacheAgeSec: MaxCacheAgeSec.optional(),
      confirmDrop: z.boolean().optional(),
    }),
    project: byProjectId,
  }),
} as const;
