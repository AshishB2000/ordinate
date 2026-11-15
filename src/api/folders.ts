import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

// Shared folders (docs/team-folders/00-design.md). `folder:of` is E2's reader; the rest are E7's, which let people make
// folders — merged only after a release with every reader (D22). Handlers: src/ipc/folders.ts.

/** A folder name: 1–120 characters, unique among its siblings regardless of case (0032's index). */
const Name = z.string().trim().min(1).max(120);
/** What a folder holds (D3). */
const Item = z.strictObject({ kind: z.enum(['dataset', 'dashboard']), id: Uuid });
/**
 * A move to folder `to` (the project id: Everyone) of `items`, and of everything placed in folder `from` and under it,
 * the Trash included (a delete's "Move its items to…"); `from` the project id: every placed item (project admins, to
 * Everyone: *Move everything to Everyone*, which makes a rollback widen nothing).
 */
const Move = { projectId: Uuid, items: z.array(Item).max(500), to: Uuid, from: Uuid.optional() };

export const folders = {
  // preload: invoke('folder:of', { projectId, kind, id })
  // A bookmarked dataset, dashboard, story or report that loaded nothing: is it in a folder the caller cannot open? `{ok:false,
  // code:'folder', reason:'closed'}` when it exists there, `{ok:true}` otherwise (open, or no such item). It says that
  // something exists, never what (D12, a ceiling).
  'folder:of': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, kind: z.enum(['dataset', 'dashboard', 'story', 'report']), id: Uuid }), project: byProjectId }),
  // The folders the caller opens (an admin: all, marked when none of their teams was given one), each with their level,
  // a top-level folder's teams and reach switch, and where each item in an open folder sits. Empty without Postgres.
  'folder:tree': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // `parentId` null: a top-level folder (project admins); the project id: under Everyone; else under that folder (Edit on it).
  'folder:create': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, parentId: Uuid.nullable(), name: Name }), project: byProjectId }),
  // A top-level folder by a project admin, a subfolder with Edit on it.
  'folder:rename': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, folderId: Uuid, name: Name }), project: byProjectId }),
  // Only an empty folder (its subfolders and the Trash included): `not_empty` otherwise. Never moves items on its own.
  'folder:delete': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, folderId: Uuid }), project: byProjectId }),
  // A top-level folder's "Dashboards in other folders may show this folder's data" (D9).
  'folder:setShareFigures': rpc({ access: 'admin', input: z.strictObject({ projectId: Uuid, folderId: Uuid, on: z.boolean() }), project: byProjectId }),
  // Share → Folders: each top-level folder with its grants, head counts and switch; the org's teams to give it to.
  'folder:access': rpc({ access: 'admin', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // A team's level on a top-level folder (D4, D5); `level: null` takes the grant away.
  'folder:grant': rpc({
    access: 'admin',
    input: z.strictObject({ projectId: Uuid, folderId: Uuid, teamId: Uuid, level: z.enum(['view', 'edit']).nullable() }),
    project: byProjectId,
  }),
  // What a move changes, before it happens: who loses and gains access, published links, recipients who stop receiving,
  // dashboards elsewhere showing a moved dataset — and a hash of that answer, which `folder:move` must be given.
  'folder:moveImpact': rpc({ access: 'write', input: z.strictObject(Move), project: byProjectId }),
  // The move itself: Edit on where each item is and on where it goes; `move_changed` when the hash is stale.
  'folder:move': rpc({ access: 'write', input: z.strictObject({ ...Move, hash: z.string().regex(/^[0-9a-f]{64}$/) }), project: byProjectId }),
} as const;
