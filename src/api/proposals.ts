import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

// Metric proposals (docs/metric-proposals/00-design.md; src/server/proposals/). Anyone who reads the project may press
// "Propose a definition" on their own refused answer: `proposal:propose` is `read`, as `request:create` is — it saves
// nothing in the model — and audited. It makes one model call that drafts structure, never a figure, checks it as the
// caller and queues it for the editors. Listing, approving and declining are `write` and need Edit on the dataset the
// draft is about; approval is the normal metric or term save. The reviewer's preview is the existing `metric:check` and
// `metric:preview`, computed under their own access.

export const proposals = {
  'proposal:propose': rpc({
    access: 'read',
    audit: true,
    input: z.strictObject({ projectId: Uuid, threadId: Uuid, turnId: Uuid }),
    project: byProjectId,
  }),
  // The reviewer's cards: `decided: false` the open ones, true the approved and declined.
  'proposal:list': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, decided: z.boolean() }), project: byProjectId }),
  // Approve as drafted, or with an edit: a name, words, other names, a metric formula's text.
  'proposal:approve': rpc({
    access: 'write',
    audit: true,
    input: z.strictObject({
      projectId: Uuid,
      id: Uuid,
      edit: z.strictObject({
        name: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(500).optional(),
        aliases: z.array(z.string().max(60)).max(8).optional(),
        formula: z.string().trim().min(1).max(2_000).optional(),
      }).optional(),
    }),
    project: byProjectId,
  }),
  'proposal:decline': rpc({ access: 'write', audit: true, input: z.strictObject({ projectId: Uuid, id: Uuid, note: z.string().trim().min(1).max(2000) }), project: byProjectId }),
} as const;
