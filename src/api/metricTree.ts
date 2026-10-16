// The metric tree (docs/metric-tree/00-design.md): a metric broken into its
// parts — sum, product, ratio, or segments by a column — and its period-over-
// period change attributed to them. src/ipc/metricTree.ts; every figure, share
// and sentence is the server's. The tree is stored on the metric's record.

import { z } from 'zod';
import { byProjectId, rpc, Steps, Uuid } from './contract';

/** One node: analysis/metricTree.sanitizeTree owns the limits (depth, parts, cycles). */
export interface TreeNodeInput {
  id?: string;
  metricId?: string;
  negative?: boolean;
  relation?: 'sum' | 'product' | 'ratio';
  children?: TreeNodeInput[];
  split?: string;
}
const TreeNode: z.ZodType<TreeNodeInput> = z.lazy(() =>
  z.strictObject({
    id: Uuid.optional(),
    metricId: Uuid.optional(),
    negative: z.boolean().optional(),
    relation: z.enum(['sum', 'product', 'ratio']).optional(),
    children: z.array(TreeNode).max(8).optional(),
    split: z.string().max(512).optional(),
  }),
);
const Compare = z.strictObject({
  mode: z.enum(['previous_period', 'previous_year', 'custom']),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});
const Period = z.strictObject({
  key: z.enum(['latest_month', 'latest_quarter', 'last_month', 'last_quarter', 'last_30_days', 'ytd', 'custom']),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});
const ParamPayload = z.array(z.looseObject({ name: z.string().max(40), kind: z.string().max(16) })).max(50);

export const metricTree = {
  // The whole tree under a scope, in one call. `tree` previews an unsaved one
  // (the editor) — computed, never written. A dashboard sends its filters and
  // no `period`; the tree page sends a `period`.
  'metricTree:compute': rpc({
    access: 'read',
    input: z.strictObject({
      projectId: Uuid,
      id: Uuid,
      filters: Steps.optional(),
      period: Period.optional(),
      compare: Compare.optional(),
      params: ParamPayload.optional(),
      tree: TreeNode.nullable().optional(),
    }),
    project: byProjectId,
  }),
  // Save (or clear, with null) the metric's tree on its record — a version, like every metric edit.
  'metricTree:save': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, id: Uuid, tree: TreeNode.nullable() }),
    project: byProjectId,
  }),
  // "Add to dashboard": a Metric tree card at the foot of an existing dashboard (`analysisId`) or a new one (`name`).
  'metricTree:addToDashboard': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, id: Uuid, analysisId: Uuid.optional(), name: z.string().max(200).optional() }),
    project: byProjectId,
  }),
  // The editor's starting points: breakdowns read from the project's formulas,
  // the metrics a part may be, and the text columns a split may use.
  'metricTree:suggest': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
} as const;
