// Column access rules (semantic layer part 4, D12–D14; docs/semantic-layer/04-governance.md): read and set by a
// project ADMIN only, like row rules (./rowPolicy.ts). A rule is an allow-list: the members named see the column's
// values and every figure computed from it; every other restricted caller does not. Carriers (columns computed
// from a hidden one) are added by the server, never typed: a rule has no `from` here.

import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

const Member = z.union([z.strictObject({ userId: Uuid }), z.strictObject({ teamId: Uuid })]);

export const columnAccess = {
  // The Access tab: the rules (carriers with `from`), whether they still hold, the marked columns not hidden yet,
  // and the datasets built from this one. `denials`: reading is not an event.
  'dataset:columnAccess': rpc({
    access: 'admin',
    audit: 'denials',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid }),
    project: byProjectId,
  }),
  // Save (or, with `columns: null` or `[]`, remove) the rules. Audited by the route as every admin call is.
  'dataset:setColumnAccess': rpc({
    access: 'admin',
    input: z.strictObject({
      projectId: Uuid,
      datasetId: Uuid,
      columns: z.array(z.strictObject({ column: z.string().min(1).max(256), visibleTo: z.array(Member).max(500) })).max(256).nullable(),
    }),
    project: byProjectId,
  }),
} as const;
