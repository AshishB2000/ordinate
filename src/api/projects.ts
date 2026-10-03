import { z } from 'zod';
import { byProjectId, onlyReadable, rpc, Uuid } from './contract';

/** A project member to share with: a user or a team of the caller's org, by id. */
const Member = z.union([z.strictObject({ userId: Uuid }), z.strictObject({ teamId: Uuid })]);

/** The id of the project `projects:create` returned. */
const createdId = (out: unknown): string | undefined => {
  const id = out && typeof out === 'object' ? (out as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? id : undefined;
};

export const projects = {
  // preload: invoke('projects:list') — no payload. Only the projects the caller may read.
  'projects:list': rpc({ access: 'read', org: true, input: z.undefined(), visible: onlyReadable('id') }),
  // preload: invoke('projects:create', { name }). Org editors and admins; the
  // creator is granted admin on the new project (src/server/authz/).
  'projects:create': rpc({ access: 'write', org: true, input: z.strictObject({ name: z.string().max(200) }), creates: createdId }),
  // Sharing (server only, src/server/authz/share.ts): who holds which role on
  // a project, and granting / changing / removing one. `role: null` removes.
  'project:access': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'project:share': rpc({
    access: 'admin',
    input: z.strictObject({ projectId: Uuid, member: Member, role: z.enum(['viewer', 'editor', 'admin']).nullable() }),
    project: byProjectId,
  }),
} as const;
