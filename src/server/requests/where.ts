// Where a requested dashboard may go (docs/team-folders/00-design.md "Dashboard requests"): the folders a requester
// may suggest — those they open — and a reviewer's choices for a new dashboard: folders the reviewer edits AND the
// requester opens, so "your dashboard is ready" never names one its requester cannot open. Folder names only.

import { atLeast, folderAccessOn, levelIn } from '../authz/folders';
import { ctx, runInContext, type Role } from '../context';
import { inOrg, orgDb } from '../db/inOrg';
import * as say from '../requestMessages';

export interface FolderChoice {
  id: string;
  /** Its path from the top ("Ops / Returns"); Everyone's is the catalog's. */
  name: string;
}

/** Every folder of the project by path, Everyone (the project id) first. */
async function allFolders(projectId: string): Promise<FolderChoice[]> {
  const p = projectId.toLowerCase();
  const rows = orgDb()
    ? (await inOrg((c, org) => c.query<{ id: string; parent_id: string | null; name: string }>('SELECT id::text, parent_id::text, name FROM folders WHERE org_id = $1 AND project_id = $2', [org, p]))).rows
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pathOf = (id: string, depth: number): string => {
    const r = byId.get(id);
    if (!r) return '';
    const up = r.parent_id && r.parent_id !== p && depth < 8 ? pathOf(r.parent_id, depth + 1) : '';
    return up ? `${up} / ${r.name}` : r.name;
  };
  const named = rows.map((r) => ({ id: r.id, name: pathOf(r.id, 0) })).sort((a, b) => a.name.localeCompare(b.name));
  return [{ id: p, name: say.everyoneFolder() }, ...named];
}

/** The folders the caller opens: what a requester may suggest. */
export async function foldersOpen(projectId: string): Promise<FolderChoice[]> {
  const access = await folderAccessOn(projectId);
  return (await allFolders(projectId)).filter((f) => levelIn(access, f.id) !== 'none');
}

/** `fn` as `email` is now — their org role, a context of their own — or null when their account is gone or disabled. */
export async function asMember<T>(email: string, fn: () => Promise<T>): Promise<T | null> {
  const pool = orgDb();
  if (!pool) return null;
  const { org, requestId } = ctx();
  const r = await pool.query<{ role: Role }>('SELECT role FROM users WHERE org_id = $1 AND email = $2 AND disabled_at IS NULL', [org.id, email]);
  return r.rows[0] ? runInContext({ user: { email, role: r.rows[0].role }, org: { id: org.id } }, `${requestId}:requester`, fn) : null;
}

/** A new dashboard's folders for the reviewer: those they edit that `requester` opens, Everyone first. */
export async function folderChoices(projectId: string, requester: string): Promise<FolderChoice[]> {
  const theirs = await asMember(requester, () => folderAccessOn(projectId));
  if (!theirs) return [];
  const mine = await folderAccessOn(projectId);
  return (await allFolders(projectId)).filter((f) => atLeast(levelIn(mine, f.id), 'edit') && levelIn(theirs, f.id) !== 'none');
}

/** A folder's name by its path, or Everyone's. */
export async function folderName(projectId: string, folderId: string): Promise<string> {
  return (await allFolders(projectId)).find((f) => f.id === folderId.toLowerCase())?.name ?? say.everyoneFolder();
}
