import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

// Dashboard requests (docs/team-folders/00-design.md D20, "Dashboard requests"; src/server/requests/). A viewer who
// cannot keep an answer asks for a dashboard of it: `request:create` is `read`, as `editors:ask` and `comment:add` are
// — asking changes nothing in the project — and audited. It stores the answers' chart forms, never a figure, and tells
// the editors who could approve it. Reviewing, approving and declining are `write`, and need Edit on the folder of
// every dataset the charts read (D18): the figures are computed at review, through the doors, as the reviewer. The
// bell's rows ride on `mentions:list` (./notifications.ts), as viewers' asks do.

export const requests = {
  // The caller's own answer turns (their conversation's `threadId`), 1–12 of them, a name and an optional note; and
  // either an existing dashboard they open for the charts to go onto (`dashboardId`, whose name is then the request's),
  // or a folder they open suggested for the new one (`folderId`; the project id is Everyone).
  'request:create': rpc({
    access: 'read',
    audit: true,
    input: z.strictObject({
      projectId: Uuid,
      threadId: Uuid,
      turnIds: z.array(Uuid).min(1).max(12),
      title: z.string().trim().min(1).max(120),
      note: z.string().trim().max(2000).optional(),
      dashboardId: Uuid.optional(),
      folderId: Uuid.optional(),
    }).refine((x) => !(x.dashboardId && x.folderId), { message: 'An existing dashboard or a folder for a new one, not both.' }),
    project: byProjectId,
  }),
  // The requester takes their own open request back. Someone else's answers as a missing one.
  'request:withdraw': rpc({ access: 'read', audit: true, input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // The folders the caller opens, by name: what the request dialog offers to suggest.
  'request:folders': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // The review page: the request, each chart computed now as the caller, and exactly what approving creates.
  'request:preview': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // Approve and publish (`publish: true`), or Edit: the dashboard made as a draft, published by the editor later.
  // `folderId`: a new dashboard's folder, one of the preview's choices (the caller edits it, the requester opens it).
  'request:approve': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid, publish: z.boolean(), folderId: Uuid.optional() }), project: byProjectId }),
  'request:decline': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid, note: z.string().trim().min(1).max(2000) }), project: byProjectId }),
} as const;
