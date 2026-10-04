// Reports, stories and scorecards (T2.13). src/ipc/reports.ts, stories.ts,
// scorecards.ts and the server batches in reportsServer.ts. Every record body
// (pages, cover, blocks, rows) is loose here and re-sanitized field by field by
// its store (`reportSpec.sanitize*`, `storyModel.sanitizeBlocks`,
// `scorecardModel.sanitizeRows`); the zod shapes bound size and type only.
//
// Deliberately NOT contracted (404): `reports:pickFolder`, `reports:saveAs`,
// `reports:reveal`, `reports:writeScheduled`, `reports:due` — each touches a
// local path; the browser builds the file and downloads it itself, and a
// scheduled run on the server is a later task. A report's schedule therefore
// carries no `folder` from a browser.

import { z } from 'zod';
import { byProjectId, rpc, Steps, Uuid } from './contract';

const ById = z.strictObject({ projectId: Uuid, id: Uuid });
const Name = z.string().max(200);
const Pages = z.array(z.looseObject({ kind: z.string().max(16) })).max(200);
const Cover = z.looseObject({ title: z.string().max(300).optional(), subtitle: z.string().max(300).optional(), logo: z.boolean().optional() });
const Paper = z.strictObject({ size: z.enum(['letter', 'a4']), orientation: z.enum(['portrait', 'landscape']) });
const Format = z.enum(['pdf', 'pptx', 'docx']);
/** The report fields a browser may set (no lastRunAt / lastFile / schedule folder). */
const ReportFields = {
  name: Name.optional(),
  format: Format.optional(),
  pages: Pages.optional(),
  cover: Cover.optional(),
  paper: Paper.optional(),
  includeFilters: z.boolean().optional(),
  narrative: z.boolean().optional(),
  discussion: z.boolean().optional(),
  viewId: z.string().max(40).optional(),
};
/** A story block: storyModel.sanitizeBlock whitelists it by kind (an image is a data: URL, bounded by the body cap). */
const Blocks = z.array(z.looseObject({ kind: z.string().max(16) })).max(400);
/** What story:figures needs of a block to compute it. */
const FigureBlock = z.strictObject({
  id: z.string().min(1).max(64),
  kind: z.enum(['visual', 'metric', 'metrics_row']),
  visualId: Uuid.optional(),
  metricId: Uuid.optional(),
  metricIds: z.array(Uuid).max(4).optional(),
  filters: Steps.optional(),
});
const Period = z.enum(['week', 'month', 'quarter', 'year']);
const Rows = z.array(z.looseObject({ metricId: Uuid })).max(60);
const Offset = z.number().int().min(0).max(600).optional();

export const reports = {
  // ── Reports (src/ipc/reports.ts) ────────────────────────────────────────
  'reports:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'reports:get': rpc({ access: 'read', input: ById, project: byProjectId }),
  // The page list is built by the server from the dashboard's sheets.
  'reports:create': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, analysisId: Uuid }), project: byProjectId }),
  'reports:update': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid, patch: z.strictObject(ReportFields) }), project: byProjectId }),
  // To the project's Trash, restorable.
  'reports:delete': rpc({ access: 'write', input: ById, project: byProjectId }),
  'reports:duplicate': rpc({ access: 'write', input: ById, project: byProjectId }),
  // ── Server only (src/ipc/reportsServer.ts) ─────────────────────────────
  'reports:open': rpc({ access: 'read', input: ById, project: byProjectId }),
  // The builder's preview: one page (`page`) or all, of the stored report with
  // its unsaved settings (`draft`) over it — re-sanitized by reportSpec.
  'report:preview': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, id: Uuid, draft: z.strictObject(ReportFields).optional(), page: z.number().int().min(0).max(199).optional() }),
    project: byProjectId,
  }),
  // The same pages for a file about to leave the app — an export, so audited.
  'report:build': rpc({ access: 'read', audit: true, input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // "Last generated" — a write to the record; a viewer's generate simply is not stamped.
  'reports:generated': rpc({ access: 'write', input: ById, project: byProjectId }),

  // ── Stories (src/ipc/stories.ts) ────────────────────────────────────────
  'story:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'story:get': rpc({ access: 'read', input: ById, project: byProjectId }),
  'story:create': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, name: Name.optional(), blocks: Blocks.optional() }), project: byProjectId }),
  'story:update': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid, name: Name.optional(), blocks: Blocks.optional() }), project: byProjectId }),
  'story:delete': rpc({ access: 'write', input: ById, project: byProjectId }),
  // The Assistant's outline (structure only, saved nowhere) — asking is `read`; building it is `write`.
  'story:draft': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid.optional(), intent: z.string().max(2_000).optional() }),
    project: byProjectId,
  }),
  'story:build': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, plan: z.looseObject({}) }), project: byProjectId }),
  'story:figures': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, blocks: z.array(FigureBlock).max(400) }), project: byProjectId }),
  'story:export': rpc({ access: 'read', audit: true, input: ById, project: byProjectId }),

  // ── Scorecards (src/ipc/scorecards.ts) ──────────────────────────────────
  'scorecard:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'scorecard:get': rpc({ access: 'read', input: ById, project: byProjectId }),
  'scorecard:create': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, name: Name.optional(), period: Period.optional(), rows: Rows.optional(), description: z.string().max(2_000).optional() }),
    project: byProjectId,
  }),
  'scorecard:update': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      id: Uuid,
      patch: z.strictObject({ name: Name.optional(), period: Period.optional(), rows: Rows.optional(), description: z.string().max(2_000).optional() }),
    }),
    project: byProjectId,
  }),
  'scorecard:duplicate': rpc({ access: 'write', input: ById, project: byProjectId }),
  'scorecard:delete': rpc({ access: 'write', input: ById, project: byProjectId }),
  'scorecard:compute': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, id: Uuid, offset: Offset }), project: byProjectId }),
  'scorecard:detail': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, id: Uuid, metricId: Uuid, offset: Offset }), project: byProjectId }),
  // Scorecards export through reports: a report whose page is the scorecard.
  'scorecard:createReport': rpc({ access: 'write', input: ById, project: byProjectId }),
} as const;
