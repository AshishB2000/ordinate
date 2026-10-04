// Analytics workbenches A (T2.10): statistics, key drivers ("Why did this
// change?"), what-if scenarios and Find segments. Handlers: src/ipc/stats.ts,
// drivers.ts, scenarios.ts, segments.ts — every figure is computed there.
//
// Specs are checked for SHAPE here and whitelisted field by field by each
// handler's own sanitizer (sanitizeStatsSpec, sanitizeDriversSpec,
// sanitizeDrivers, sanitizeSteps) before anything reads a file. Every dataset
// id is read inside the named project's own directory, so naming another
// project's dataset finds nothing.
//
// Access: running an analysis is `read` (it computes, it writes no record, even
// when it runs as a job); anything that saves — a calculated field, a column,
// a dataset, a visual, a dashboard card, a scenario — is `write`.

import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

const Column = z.string().min(1).max(512);
/** Dashboard-style filter steps; the handlers re-run them through sanitizeDashboardFilters. */
const Filters = z.array(z.looseObject({ type: z.string().max(64) })).max(200);
const Params = z.record(z.string().max(200), z.unknown());

/** src/analysis/stats/spec.ts StatsSpec — sanitizeStatsSpec owns every field. */
const StatsSpec = z.looseObject({
  kind: z.enum(['correlation', 'regression', 'groups', 'distribution']),
  datasetId: Uuid,
  columns: z.array(Column).max(12).optional(),
  predictors: z.array(Column).max(30).optional(),
  levels: z.array(z.string().max(300)).max(20).optional(),
});

/** A drivers question (src/analysis/driverScope.ts) — sanitizeDriversSpec owns the rest. */
const DriversRequest = z.looseObject({
  datasetId: Uuid,
  metric: z.looseObject({}),
  compare: z.looseObject({ mode: z.string().max(40) }),
  filters: Filters.optional(),
  path: z.array(z.looseObject({ column: Column, value: z.string().max(500) })).max(4).optional(),
  dimension: z.string().max(500).optional(),
  params: Params.optional(),
});

/** A scenario's editable parts (src/analysis/scenarioModel.ts) — sanitizeDrivers owns each driver. */
const ScenarioDraft = {
  baseMetricIds: z.array(Uuid).max(12),
  drivers: z.array(z.looseObject({ kind: z.enum(['pct', 'abs']), value: z.number() })).max(16),
};

/** RFM's three columns (src/analysis/rfm.ts RfmSpec). */
const RfmSpec = z.strictObject({ id: Column, date: Column, amount: Column });

const DatasetIn = { projectId: Uuid, datasetId: Uuid };

export const analytics = {
  // ── Statistics (statsPanel.ts) ──────────────────────────────────────────────
  // preload: invoke('stats:run', { projectId, spec }) — one analysis; a big
  // table runs as a compute job. `figures` rides along (stats/figures.ts).
  'stats:run': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, spec: StatsSpec }), project: byProjectId }),
  // preload: invoke('stats:pair', { projectId, spec, x, y }) — one heatmap cell's scatter and fit.
  'stats:pair': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, spec: StatsSpec, x: Column, y: Column }),
    project: byProjectId,
  }),
  // preload: invoke('stats:saveFormula', { projectId, spec }) — predicted_<target> as a calculated field.
  'stats:saveFormula': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, spec: StatsSpec }), project: byProjectId }),
  // Server only: "Add to dashboard" — a "stats" card on an existing dashboard
  // (`analysisId`) or a new one (`name`), merged on the server.
  'stats:addToDashboard': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      spec: StatsSpec,
      view: z.enum(['table', 'chart']),
      analysisId: Uuid.optional(),
      name: z.string().max(200).optional(),
    }),
    project: byProjectId,
  }),
  // Server only: the dashboard picker of "Add to dashboard" — ids and names only.
  'stats:dashboards': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),

  // ── Key drivers (driversPanel.ts) ───────────────────────────────────────────
  // preload: invoke('drivers:explain', { projectId, request }) — the change
  // between two periods, decomposed (a job on a big table).
  'drivers:explain': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, request: DriversRequest }), project: byProjectId }),
  // preload: invoke('drivers:addTile', { projectId, request, name }) — saves a waterfall visual.
  'drivers:addTile': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, request: DriversRequest, name: z.string().max(200) }),
    project: byProjectId,
  }),

  // ── Scenarios (scenarioList / Page / Drivers / Compare) ─────────────────────
  'scenario:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'scenario:get': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  'scenario:create': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, input: z.strictObject({ name: z.string().max(200), ...ScenarioDraft }) }),
    project: byProjectId,
  }),
  'scenario:update': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      id: Uuid,
      patch: z.strictObject({ name: z.string().max(200).optional(), ...ScenarioDraft }),
    }),
    project: byProjectId,
  }),
  'scenario:duplicate': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // A scenario is a definition (metric ids + drivers), no data: deleting one is an editor's call, as creating it is.
  'scenario:delete': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // The page's figures for the DRAFT on screen (unsaved slider positions).
  'scenario:compute': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, id: Uuid, draft: z.strictObject(ScenarioDraft), focusMetricId: Uuid.optional() }),
    project: byProjectId,
  }),
  'scenario:compare': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, ids: z.array(Uuid).min(1).max(4) }), project: byProjectId }),
  'scenario:targets': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, baseMetricIds: z.array(Uuid).max(12) }), project: byProjectId }),
  // Server only: the project's metrics for "Add metric" and a new scenario's
  // seed — id, name and kind (column / formula / count), nothing else.
  'scenario:metrics': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),

  // ── Find segments (segments / segmentsView / segmentsRfm) ──────────────────
  'segments:features': rpc({ access: 'read', input: z.strictObject(DatasetIn), project: byProjectId }),
  // A job (kind 'analysis'): progress and Cancel through the Jobs popover's own stream.
  'segments:fit': rpc({
    access: 'read',
    input: z.strictObject({ ...DatasetIn, features: z.array(Column).min(2).max(32) }),
    project: byProjectId,
  }),
  // The fitted model as a Prepare step; transforms.sanitizeSteps re-checks it.
  'segments:saveColumn': rpc({
    access: 'write',
    input: z.strictObject({ ...DatasetIn, step: z.looseObject({ type: z.literal('segment'), column: z.string().min(1).max(200) }) }),
    project: byProjectId,
  }),
  'segments:rfm': rpc({ access: 'read', input: z.strictObject({ ...DatasetIn, spec: RfmSpec }), project: byProjectId }),
  'segments:rfmSave': rpc({ access: 'write', input: z.strictObject({ ...DatasetIn, spec: RfmSpec }), project: byProjectId }),
} as const;
