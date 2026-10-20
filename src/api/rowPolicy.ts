// Row access rules (docs/row-policy/00-design.md D3): read and set by a project
// ADMIN only — the rules say who sees what, which is no viewer's or editor's
// business. Every other channel enforces them; these two only manage them.

import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

/** One rule: exactly one member, 1–1,000 values (the server drops blanks and refuses parameter references). */
const Values = z.array(z.string().max(1000)).min(1).max(1000);
const Rule = z.union([z.strictObject({ userId: Uuid, values: Values }), z.strictObject({ teamId: Uuid, values: Values })]);

export const rowPolicy = {
  // The tab: the rules, whether they still hold, and the datasets built from this one. `denials`: reading is not an event.
  'dataset:rowPolicy': rpc({
    access: 'admin',
    audit: 'denials',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid }),
    project: byProjectId,
  }),
  // Save (or, with `policy: null`, remove) the rules. Audited by the route as every admin call is.
  'dataset:setRowPolicy': rpc({
    access: 'admin',
    input: z.strictObject({
      projectId: Uuid,
      datasetId: Uuid,
      policy: z.strictObject({ column: z.string().min(1).max(256), rules: z.array(Rule).max(500) }).nullable(),
    }),
    project: byProjectId,
  }),
} as const;
