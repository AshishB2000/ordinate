// Signed embedding (docs/embed/00-design.md): a published dashboard inside
// another site's iframe, by a token the host's backend signs.
//
// The ORG's settings — the switch, the sites allowed to frame it, the signing
// secret — are an org admin's (`org: true` + `admin`, refused 403 before the
// handler). The secret is write-only: `embed:rotate` makes one and returns it
// that ONCE; nothing reads it back. Any member may ask `embed:status` (is it
// on, the org id a token names). The per-dashboard calls — which columns a
// lock can hold, a preview — are the project's: reading the columns is `read`,
// a preview (a working link, for ten minutes, inside Ordinate only) is `write`,
// who may publish.

import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

const Origin = z.string().trim().min(1).max(255);
const LockValue = z.union([z.string().max(200), z.number()]);

export const embed = {
  'embed:settings': rpc({ access: 'admin', org: true, audit: 'denials', input: z.undefined() }),
  'embed:save': rpc({ access: 'admin', org: true, input: z.strictObject({ enabled: z.boolean(), origins: z.array(Origin).max(20) }) }),
  'embed:rotate': rpc({ access: 'admin', org: true, input: z.undefined() }),
  'embed:status': rpc({ access: 'read', org: true, input: z.undefined() }),
  'embed:columns': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, siteId: Uuid, dashboardId: Uuid }), project: byProjectId }),
  'embed:preview': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      siteId: Uuid,
      dashboardId: Uuid,
      params: z.record(z.string().min(1).max(200), z.array(LockValue).min(1).max(100)).optional(),
      theme: z.enum(['light', 'dark']).optional(),
      hide: z.array(z.enum(['title', 'filters'])).max(2).optional(),
    }),
    project: byProjectId,
  }),
} as const;
