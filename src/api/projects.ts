import { z } from 'zod';
import { byProjectId, FileToken, onlyReadable, rpc, Uuid } from './contract';

/** A project member to share with: a user or a team of the caller's org, by id. */
const Member = z.union([z.strictObject({ userId: Uuid }), z.strictObject({ teamId: Uuid })]);

/** The id of the project `projects:create` returned. */
const createdId = (out: unknown): string | undefined => {
  const id = out && typeof out === 'object' ? (out as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? id : undefined;
};

/** The project a `projects:*` channel names by `id` (the handlers' own field name). */
const byId = (input: { id: string }): string => input.id;

/** The id of the project `projects:import` made: `{ ok, project: { id } }`. */
const importedId = (out: unknown): string | undefined =>
  out && typeof out === 'object' ? createdId((out as { project?: unknown }).project) : undefined;

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
  // ── T2.2: the switcher, project management, bundles ─────────────────────
  // preload: invoke('projects:overview') — the switcher's rows (counts, last
  // opened, archived, sample); only the projects the caller may read.
  'projects:overview': rpc({ access: 'read', org: true, input: z.undefined(), visible: onlyReadable('id') }),
  // preload: invoke('projects:open', { id }) — stamps "last opened" (the
  // switcher's order and its "opened 2h ago"). `read`: every member who can
  // see a project may switch to it; the stamp is a timestamp, not content.
  'projects:open': rpc({ access: 'read', input: z.strictObject({ id: Uuid }), project: byId }),
  // preload: invoke('projects:rename', { id, name }) — editors rename, as they edit what is inside.
  'projects:rename': rpc({ access: 'write', input: z.strictObject({ id: Uuid, name: z.string().max(200) }), project: byId }),
  // preload: invoke('projects:archive', { id, archived }) — hides it from everyone's switcher: project admin.
  'projects:archive': rpc({ access: 'admin', input: z.strictObject({ id: Uuid, archived: z.boolean() }), project: byId }),
  // preload: invoke('projects:delete', { id }) — the project and everything in
  // it, for good (there is no Trash for a whole project); its grants go too.
  'projects:delete': rpc({ access: 'admin', input: z.strictObject({ id: Uuid }), project: byId }),
  // Server form of "Export project…": the .ordinate bundle comes back as a T0.4
  // download token, never a path. An export is an audited read (T3.3).
  'projects:export': rpc({ access: 'read', audit: true, input: z.strictObject({ id: Uuid }), project: byId }),
  // Server form of "Import project…": the bundle was uploaded through POST
  // /api/files first. It makes a NEW project, so it is org-level like
  // `projects:create`, and the importer is granted admin on it.
  'projects:import': rpc({ access: 'write', org: true, input: z.strictObject({ fileToken: FileToken }), creates: importedId }),
  // Server only: the caller's own effective role on each project they can
  // open, `{ [projectId]: role }`, so a screen offers only what the server
  // will allow (src/server/authz/share.ts). Their own grants only: any member.
  'projects:roles': rpc({ access: 'read', org: true, input: z.undefined() }),
  // Server only: the org's users and teams a project admin may share with.
  'project:shareTargets': rpc({ access: 'admin', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
} as const;
