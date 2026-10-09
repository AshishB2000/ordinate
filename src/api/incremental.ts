import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

/** A column name of the stored table; the handler checks it against the record. */
const Column = z.string().min(1).max(512);

export const incremental = {
  // A dataset's incremental refresh settings and run log (src/data/incrementalSettings.ts):
  // the columns that can be the cursor, how the source is read, why it cannot be turned on.
  'incremental:get': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
  // Turn it on (cursor, update by key or append, lookback) or off. Every field is re-checked
  // against the stored record; Live datasets, non-connection sources and sources that cannot
  // take the cursor predicate are refused with the catalog's reason. Replies with the new view.
  'incremental:set': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      datasetId: Uuid,
      enabled: z.boolean(),
      cursorColumn: Column,
      mode: z.enum(['upsert', 'append']),
      keyColumn: Column.optional(),
      // Seconds for a date cursor, a count for a number cursor (src/data/incremental.ts MAX_LOOKBACK).
      lookback: z.number().finite().min(0).max(1e12),
    }),
    project: byProjectId,
  }),
} as const;
