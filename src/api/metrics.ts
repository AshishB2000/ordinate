// The project's metrics layer (T2.8): named numbers — "Revenue" rather than
// "sum of the revenue column" — defined once and shown by KPI cards, the
// Metrics tab and the metric picker. src/ipc/metrics.ts; every figure and every
// string that renders one (`display`, `definitionText`) is the server's.

import { z } from 'zod';
import { byProjectId, rpc, Steps, Uuid } from './contract';

/** What a metric IS (analysis/metrics.ts sanitizes every field again). */
const Definition = z.union([
  z.strictObject({ formula: z.string().max(2_000) }),
  z.strictObject({ column: z.string().max(512), aggregation: z.enum(['sum', 'avg', 'count', 'min', 'max']) }),
]);
const Format = z.strictObject({
  kind: z.enum(['number', 'currency', 'percent', 'duration']),
  decimals: z.number().int().min(0).max(10).optional(),
  prefix: z.string().max(8).optional(),
  suffix: z.string().max(8).optional(),
  compact: z.boolean().optional(),
});
const Fields = {
  name: z.string().min(1).max(200),
  datasetId: Uuid,
  definition: Definition,
  filters: Steps.optional(),
  format: Format.optional(),
  description: z.string().max(2_000).optional(),
  direction: z.enum(['', 'up_good', 'down_good']).optional(),
};
const ParamPayload = z.array(z.looseObject({ name: z.string().max(40), kind: z.string().max(16) })).max(50);
const ById = z.strictObject({ projectId: Uuid, id: Uuid });

export const metrics = {
  'metric:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // Seeds metrics from the columns when the project has none — a write, so it
  // is the Metrics tab's explicit "Suggest metrics" (a viewer's visit never writes).
  'metric:ensureDefaults': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid.optional() }),
    project: byProjectId,
  }),
  'metric:get': rpc({ access: 'read', input: ById, project: byProjectId }),
  // A duplicate NAME is refused with a reason (a formula names metrics by name).
  'metric:save': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, input: z.strictObject(Fields) }), project: byProjectId }),
  // The dataset is immutable once saved: a re-target is a new metric.
  'metric:update': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      id: Uuid,
      // No datasetId: the store would ignore it, so the contract refuses it.
      patch: z.strictObject({ name: Fields.name.optional(), definition: Definition.optional(), filters: Fields.filters, format: Fields.format, description: Fields.description, direction: Fields.direction }),
    }),
    project: byProjectId,
  }),
  'metric:duplicate': rpc({ access: 'write', input: ById, project: byProjectId }),
  // To the project's Trash, restorable.
  'metric:delete': rpc({ access: 'write', input: ById, project: byProjectId }),
  // The editor's live figure for a definition that is not saved yet.
  'metric:preview': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid, definition: Definition, filters: Steps.optional(), format: Format.optional() }),
    project: byProjectId,
  }),
  // ── Server only (src/ipc/analysesServer.ts) ─────────────────────────────
  // The Metrics tab in one call: the decorated list, and per metric its value
  // (`metric:value`), its sparkline series (`metric:series`) and where it is
  // used (`metric:usage`) — the same handlers, so the cells cannot disagree
  // with the channels a single row would call.
  'metric:table': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // The picker's rows: each metric's figure under the sheet's filters, one call.
  'metric:values': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, ids: z.array(Uuid).min(1).max(100), filters: Steps.optional(), params: ParamPayload.optional() }),
    project: byProjectId,
  }),
} as const;
