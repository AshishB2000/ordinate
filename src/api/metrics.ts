// The project's metrics layer (T2.8): named numbers — "Revenue" rather than
// "sum of the revenue column" — defined once and shown by KPI cards, the
// Metrics tab and the metric picker. src/ipc/metrics.ts; every figure and every
// string that renders one (`display`, `definitionText`) is the server's.

import { z } from 'zod';
import { Base, byProjectId, rpc, Steps, Uuid } from './contract';
import { AGGREGATIONS } from '../data/aggregations';

/** What a metric IS (analysis/metrics.ts sanitizes every field again). */
// A snapshot (semantic D8): only the rows on the latest (or earliest) day of `column`. null clears it; absent keeps the stored one.
// `per` (part 5, D11): each entity's own latest day; null clears it, absent keeps the stored one.
const Snapshot = z.strictObject({ column: z.string().min(1).max(512), take: z.enum(['last', 'first']), per: z.string().min(1).max(512).nullable().optional() });
// A period metric (semantic part 5, D8): a base metric over a window and/or compared with an earlier period; at least one of the two.
const Window = z.union([z.strictObject({ to_date: z.enum(['week', 'month', 'quarter', 'year']) }), z.strictObject({ last: z.number().int().min(1).max(366), unit: z.enum(['day', 'week', 'month']) })]);
const Compare = z.strictObject({ vs: z.enum(['previous_period', 'previous_year']), show: z.enum(['change', 'pct_change', 'prior']) });
// A funnel metric (semantic part 5, D5): the funnel grid's matching, as its conversion rate, converted or entered count.
const Col = z.string().min(1).max(512);
const Funnel = z.strictObject({ entity: Col, event: Col, time: Col, steps: z.array(z.string().min(1).max(400)).min(2).max(8), window: z.strictObject({ n: z.number().gt(0).max(100_000), unit: z.enum(['hours', 'days']) }) }); // the window: the grid's own rule (sanitizeEventFunnel), so 1.5 hours saves
export const Definition = z.union([
  z.strictObject({ formula: z.string().max(2_000) }),
  z.strictObject({ column: z.string().max(512), aggregation: z.enum(AGGREGATIONS), snapshot: Snapshot.nullable().optional() }),
  z.strictObject({ base: Uuid, window: Window.optional(), compare: Compare.optional() }).refine((d) => !!d.window || !!d.compare),
  z.strictObject({ funnel: Funnel, show: z.enum(['rate', 'converted', 'entered']) }),
]);
// A target (part 5, D12): a figure, or a metric over a plan dataset, for the period one figure covers. null clears it on update.
export const Target = z.strictObject({
  source: z.union([z.strictObject({ value: z.number() }), z.strictObject({ metricId: Uuid })]),
  per: z.enum(['week', 'month', 'quarter', 'year']).optional(),
  thresholds: z.strictObject({ good: z.number(), warn: z.number() }).optional(),
});
export const Format = z.strictObject({
  kind: z.enum(['number', 'currency', 'percent', 'duration']),
  decimals: z.number().int().min(0).max(6).optional(), // the store's MAX_DECIMALS (src/analysis/metrics.ts): more is refused, never clamped
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
  timeColumn: z.string().max(512).optional(), // the date column it counts by; '' clears (semantic D9)
  target: Target.optional(),
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
      base: Base.optional(), // the editor's tag (contract.ts Base)
      // No datasetId: the store would ignore it, so the contract refuses it.
      patch: z.strictObject({ name: Fields.name.optional(), definition: Definition.optional(), filters: Fields.filters, format: Fields.format, description: Fields.description, direction: Fields.direction, timeColumn: Fields.timeColumn, target: Target.nullable().optional() }),
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
  // The measure editor, once per pause in typing (src/ipc/metricCheck.ts): the
  // compiler's verdict and its position, why a formula that parses would have no
  // value, whether the name is free, and the figure. `id` is the metric being
  // edited; `chart` asks that every operand be this dataset's. Writes nothing.
  'metric:check': rpc({
    access: 'read',
    input: z.strictObject({
      projectId: Uuid,
      datasetId: Uuid,
      expression: z.string().max(20_000),
      name: z.string().max(200).optional(),
      id: Uuid.optional(),
      format: Format.optional(),
      chart: z.boolean().optional(),
    }),
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
