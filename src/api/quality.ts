import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

/**
 * A rule as the editor sends it. The shape is bounded here; `qualityRules.checkRule`
 * still owns what each kind's arguments may be and refuses the rest with a message.
 */
const Rule = z.strictObject({
  id: Uuid.optional(),
  kind: z.enum(['not_null', 'unique', 'range', 'regex', 'in_set', 'row_count', 'references']),
  column: z.string().max(512).optional(),
  args: z.record(z.string().max(32), z.unknown()).optional(),
  severity: z.enum(['fail', 'warn']),
});

export const quality = {
  // preload: invoke('quality:run', { projectId, datasetId }) — runs as a job
  // (progress over SSE) and stores the run on the dataset record, hence write.
  'quality:run': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
  // preload: invoke('quality:list', { projectId, datasetId }) — rules, the latest run, 30 runs of history.
  'quality:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
  // preload: invoke('quality:save', { projectId, datasetId, rule }) — add, or edit by id; runs the checks.
  'quality:save': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid, rule: Rule }), project: byProjectId }),
  // preload: invoke('quality:delete', { projectId, datasetId, ruleId })
  'quality:delete': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, datasetId: Uuid, ruleId: Uuid }), project: byProjectId }),
  // preload: invoke('quality:preview', { projectId, datasetId, rule }) — "would fail N rows now"; stores nothing.
  'quality:preview': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid, rule: Rule }), project: byProjectId }),
  // preload: invoke('quality:failingRows', { projectId, datasetId, ruleId, offset, limit, … }) —
  // one grid window of the rows a stored rule fails; `dataset:page`'s reply.
  'quality:failingRows': rpc({
    access: 'read',
    input: z.strictObject({
      projectId: Uuid,
      datasetId: Uuid,
      ruleId: Uuid,
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      limit: z.number().int().min(0).max(5_000),
      search: z.string().max(1_000).optional(),
      sortColumn: z.string().max(1_000).optional(),
      sortDir: z.enum(['asc', 'desc']).optional(),
    }),
    project: byProjectId,
  }),
} as const;
