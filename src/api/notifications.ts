// Notifications that reach the right person (docs/notifications/00-design.md):
// the caller's own "Mentioned you" list on Home, its seen marks, and their
// "Email me when someone mentions me". Each is the CALLER's (src/server/mentions/
// rpc.ts reads the address from the session, never the input), so any member may
// call them; the list keeps only projects the caller may read now, in its query.
// The @ picker is `comment:mentionable` (./dashboards.ts, with the comments).
//
// "Ask an editor" (src/server/mentions/asks.ts) rides the same path: a viewer's ask is `read`, as
// `comment:add` is — asking changes nothing in the project — and audited; it reaches the project's
// editors and admins only, once a day per question, at most 10 a day per person.

import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

export const notifications = {
  'mentions:list': rpc({ access: 'read', org: true, input: z.undefined() }),
  // One row (both ids), or every row of the caller's up to `through` — the newest one Home SHOWED them.
  'mentions:seen': rpc({
    access: 'read',
    org: true,
    input: z.union([z.strictObject({ projectId: Uuid, id: Uuid }), z.strictObject({ through: z.string().max(40) })]),
  }),
  'mentions:prefs': rpc({ access: 'read', org: true, input: z.undefined() }),
  // One switch per call: "Email me when someone mentions me", or "Email me when a viewer asks for data".
  'mentions:setPrefs': rpc({ access: 'read', org: true, input: z.union([z.strictObject({ emailMe: z.boolean() }), z.strictObject({ requestEmail: z.boolean() })]) }),
  // `reason`: missing (nothing has it), link (needs a link nobody defined), copy (a table that must be copied first).
  'editors:ask': rpc({
    access: 'read',
    audit: true,
    input: z.strictObject({ projectId: Uuid, question: z.string().trim().min(1).max(1000), reason: z.enum(['missing', 'link', 'copy']), note: z.string().trim().max(1000).optional() }),
    project: byProjectId,
  }),
} as const;
