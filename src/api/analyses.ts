// Analyses and authoring (T2.8): the dashboards list, the create wizard, the AI
// draft → review → build, and the authoring canvas. A dashboard IS an
// `analysis` record (docs/analysis/00-model.md) — one editable artifact, cards
// reference visuals by id, every figure recomputed by the server on render.
//
// Every record body (sheets, filters, parameters, style, a plan) is loose here
// and re-sanitized field by field by the store / validator the handler calls
// (`sanitizePages`, `sanitizeDashboardFilters`, `sanitizeParameters`,
// `sanitizeStyle`, `analysisPlan.validatePlan`) — contracted or not, the
// handler never trusts its payload. The zod shapes bound size and type only.

import { z } from 'zod';
import { byProjectId, rpc, Steps, Uuid } from './contract';

const Name = z.string().max(200);
/** A sheet array: `sanitizePages` whitelists every card by type. */
const Sheets = z.array(z.looseObject({})).max(100);
/** Dashboard parameters (analysis/params.ts `sanitizeParameters`). */
const Parameters = z.array(z.looseObject({})).max(50);
/** The live parameter values a render resolves against (`paramValues`): `[{ name, kind, value, min?, max? }]`. */
const ParamPayload = z.array(z.looseObject({ name: z.string().max(40), kind: z.string().max(16) })).max(50);
/** An AI or template plan envelope — `validatePlan` re-checks every field. */
const Plan = z.looseObject({});
const Aggregation = z.enum(['sum', 'avg', 'count', 'min', 'max']);
/** A KPI compare (dateIntel `sanitizeCompare`). */
const Compare = z.strictObject({
  mode: z.enum(['previous_period', 'previous_year', 'custom']),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});
/** A card's encoding: re-sanitized by `sanitizeEncoding` in `visual:data`. */
const Encoding = z.looseObject({
  category: z.string().max(512),
  values: z.array(z.looseObject({ column: z.string().min(1).max(512), aggregation: z.string().max(16) })).max(64),
});

/** One tile of a sheet, answered by the server's own channel for its kind. */
const Tile = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('visual'),
    datasetId: Uuid,
    encoding: Encoding,
    filters: Steps.optional(),
    analytics: z.array(z.looseObject({})).max(50).optional(),
  }),
  z.strictObject({
    kind: z.literal('metric'),
    datasetId: Uuid,
    column: z.string().max(512),
    aggregation: Aggregation,
    metricId: Uuid.optional(),
    compare: Compare.optional(),
    filters: Steps.optional(),
  }),
]);

export const analyses = {
  // preload: createAnalysis / renameAnalysis / updateAnalysis / deleteAnalysis
  // — src/ipc/analyses.ts. Delete moves the record to the project's Trash
  // (restorable), and every write is a version. The browser reads through
  // `analysis:gallery` / `analysis:open` below, so list/get stay uncontracted.
  'analysis:create': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      name: Name,
      sheets: Sheets.optional(),
      filters: Steps.optional(),
      parameters: Parameters.optional(),
    }),
    project: byProjectId,
  }),
  'analysis:rename': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid, name: Name }), project: byProjectId }),
  // A supplied array REPLACES the stored one wholesale (the autosave sends the
  // whole document); an omitted field keeps its stored value.
  'analysis:update': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      id: Uuid,
      name: Name.optional(),
      sheets: Sheets.optional(),
      filters: Steps.optional(),
      style: z.looseObject({}).optional(),
      parameters: Parameters.optional(),
    }),
    project: byProjectId,
  }),
  'analysis:delete': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // The AI draft: FACTS in (no rows, no secrets), a validated, previewed plan
  // out; nothing is saved. Asking is `read`, as the dock's copilot:ask is;
  // building what it proposed (`analysis:buildPlan`) is `write`.
  'analysis:draft': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid.optional(), intent: z.string().max(2_000).optional() }),
    project: byProjectId,
  }),
  // NOT AI: re-validate and re-preview a plan (a template's mapping step).
  'analysis:previewPlan': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, plan: Plan }), project: byProjectId }),
  // NOT AI: re-validate the approved plan and create its records — calculated
  // fields, visuals, and the analysis itself.
  'analysis:buildPlan': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, plan: Plan }), project: byProjectId }),
  // The KPIs + chart / Two-up starters: builds VISUAL records from the
  // dataset's own columns and returns the cards; the editor places them.
  'analysis:starterCards': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, kind: z.enum(['kpis', 'twoup']), datasetId: Uuid.optional() }),
    project: byProjectId,
  }),
  // preload: listTemplates / templatePlan — src/ipc/templates.ts. The catalogue
  // mapped against one dataset's columns, and the plan a mapping produces.
  'template:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
  'template:plan': rpc({
    access: 'read',
    input: z.strictObject({
      projectId: Uuid,
      datasetId: Uuid,
      templateId: z.string().min(1).max(100),
      mapping: z.record(z.string().max(100), z.string().max(512)),
      name: Name.optional(),
    }),
    project: byProjectId,
  }),
  // preload: computeMetric — the ONE app-computed number of a column KPI
  // (the template mapping step's preview strip calls it as the built tile will).
  'dashboard:metric': rpc({
    access: 'read',
    input: z.strictObject({
      projectId: Uuid,
      datasetId: Uuid,
      column: z.string().max(512),
      aggregation: Aggregation,
      filters: Steps.optional(),
      params: ParamPayload.optional(),
    }),
    project: byProjectId,
  }),
  // ── Server only (src/ipc/analysesServer.ts) ─────────────────────────────
  // The list page in one call: every dashboard's summary plus the definitions
  // of the first sheet's first two visuals (its preview), so the browser does
  // not read each analysis and the visual store per card.
  'analysis:gallery': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // The editor in one call: the analysis and the definition of every visual
  // in the project (the cards resolve theirs; the Add-visual picker lists them).
  'analysis:open': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // A page of tiles in one call, each answered by the SAME handler that answers
  // it alone — `visual:data`, `metric:value` / `dashboard:metric`,
  // `metric:compare` — with the sheet's parameters (an array, which the
  // `visual:data` contract's record shape cannot carry).
  'analysis:tiles': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, params: ParamPayload.optional(), items: z.array(Tile).min(1).max(100) }),
    project: byProjectId,
  }),
} as const;
