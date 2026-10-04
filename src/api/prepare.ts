// Prepare and pipelines (T2.6): the reversible step pipeline on a dataset, the
// formula editor's checks, the power / text / spatial steps' previews, and the
// project's Pipelines page.
//
// Steps are shape-bounded here only (a type and a size); every handler runs the
// step through its own whitelist (transforms.sanitizeSteps, checkPowerStep,
// checkTextStep, checkSpatialJoin) before anything reads it. On the server the
// step-mutating replies carry no rows and no origin (src/ipc/stepReply.ts).

import { z } from 'zod';
import { byProjectId, rpc, Steps, Uuid } from './contract';

/** One pipeline step from a client — the shape bound only; the handlers whitelist it. */
const Step = z.looseObject({ type: z.string().max(64) });
/** A step's position in the pipeline; -1 (or past the end) = a new step at the end. */
const Index = z.number().int().min(-1).max(10_000);
const At = { projectId: Uuid, datasetId: Uuid };
/** A pipeline node id (src/app/pipelineStore.isNodeId re-checks it). */
const NodeId = z.string().min(1).max(200);

export const prepare = {
  // Server only: what the Prepare page opens with — the prepared columns, the
  // steps and the rows into / out of each — without the rows or the origin.
  'prepare:get': rpc({ access: 'read', input: z.strictObject(At), project: byProjectId }),
  // preload: invoke('dataset:addStep' | …) — every one recomputes from the source.
  'dataset:addStep': rpc({ access: 'write', input: z.strictObject({ ...At, step: Step }), project: byProjectId }),
  'dataset:updateStep': rpc({
    access: 'write',
    input: z.strictObject({ ...At, index: z.number().int().min(0).max(10_000), step: Step }),
    project: byProjectId,
  }),
  'dataset:removeStep': rpc({ access: 'write', input: z.strictObject({ ...At, index: z.number().int().min(0).max(10_000) }), project: byProjectId }),
  'dataset:reorderSteps': rpc({
    access: 'write',
    input: z.strictObject({ ...At, order: z.array(z.number().int().min(0).max(10_000)).max(200) }),
    project: byProjectId,
  }),
  'dataset:setSteps': rpc({ access: 'write', input: z.strictObject({ ...At, steps: Steps }), project: byProjectId }),
  // The Assistant proposes STRUCTURE only and applies nothing (asking is `read`, as the dock's).
  'dataset:suggestSteps': rpc({ access: 'read', input: z.strictObject(At), project: byProjectId }),
  'dataset:suggestCalcField': rpc({ access: 'read', input: z.strictObject(At), project: byProjectId }),
  // The formula editor: the server's own compile() on every (debounced) keystroke; writes nothing.
  // The handler names the 4,000-character limit itself; this bound is the transport's.
  'formula:check': rpc({ access: 'read', input: z.strictObject({ ...At, expression: z.string().max(20_000) }), project: byProjectId }),
  'formula:functions': rpc({ access: 'read', org: true, input: z.undefined() }),
  // What an unsaved step would do to its real input — counted by the server.
  'prepare:stepPreview': rpc({ access: 'read', input: z.strictObject({ ...At, index: Index, step: Step }), project: byProjectId }),
  'text:profile': rpc({
    access: 'read',
    input: z.strictObject({ ...At, column: z.string().max(1_000), lang: z.enum(['en', 'es', 'fr', 'de']).optional() }),
    project: byProjectId,
  }),
  'text:preview': rpc({ access: 'read', input: z.strictObject({ ...At, index: Index, step: Step }), project: byProjectId }),
  // A job on a big table; replies like dataset:addStep, or { cancelled }.
  'text:commitStep': rpc({ access: 'write', input: z.strictObject({ ...At, index: Index, step: Step }), project: byProjectId }),
  'geo:boundarySources': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'geo:spatialPreview': rpc({ access: 'read', input: z.strictObject({ ...At, index: Index, step: Step }), project: byProjectId }),
  'geo:saveSpatialStep': rpc({ access: 'write', input: z.strictObject({ ...At, index: Index, step: Step }), project: byProjectId }),

  // ── Pipelines ──
  'pipelines:get': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'pipelines:run': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, nodeId: NodeId.optional() }), project: byProjectId }),
  // { cron, tz } sets it, { cron: null } clears it, { paused } pauses / resumes.
  'pipelines:setSchedule': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      cron: z.string().max(200).nullable().optional(),
      tz: z.string().max(100).optional(),
      paused: z.boolean().optional(),
    }),
    project: byProjectId,
  }),
  // The cron editor's live "next three runs" — no record is read.
  'pipelines:preview': rpc({ access: 'read', org: true, input: z.strictObject({ cron: z.string().max(200), tz: z.string().max(100) }) }),
  'pipelines:setPolicy': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      policy: z.strictObject({ retries: z.number().int().min(0).max(3), backoffMs: z.number().int().min(1_000).max(600_000) }),
    }),
    project: byProjectId,
  }),
  'pipelines:setPaused': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, nodeId: NodeId, paused: z.boolean() }), project: byProjectId }),
  'pipelines:setNodeSchedule': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      nodeId: NodeId,
      every: z.enum(['off', 'hourly', 'daily', 'weekly']).optional(),
      cadence: z.enum(['off', 'daily', 'weekly', 'monthly']).optional(),
      at: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    }),
    project: byProjectId,
  }),
} as const;
