// Notifications that reach the right person (docs/notifications/00-design.md):
// the caller's own "Mentioned you" list on Home, its seen marks, and their
// "Email me when someone mentions me". Each is the CALLER's (src/server/mentions/
// rpc.ts reads the address from the session, never the input), so any member may
// call them; the list keeps only projects the caller may read now, in its query.
// The @ picker is `comment:mentionable` (./dashboards.ts, with the comments).

import { z } from 'zod';
import { rpc, Uuid } from './contract';

export const notifications = {
  'mentions:list': rpc({ access: 'read', org: true, input: z.undefined() }),
  // One row (both ids), or every row of the caller's up to `through` — the newest one Home SHOWED them.
  'mentions:seen': rpc({
    access: 'read',
    org: true,
    input: z.union([z.strictObject({ projectId: Uuid, id: Uuid }), z.strictObject({ through: z.string().max(40) })]),
  }),
  'mentions:prefs': rpc({ access: 'read', org: true, input: z.undefined() }),
  'mentions:setPrefs': rpc({ access: 'read', org: true, input: z.strictObject({ emailMe: z.boolean() }) }),
} as const;
