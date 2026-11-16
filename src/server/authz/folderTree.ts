// The folder tree and its changes (docs/team-folders/00-design.md, "Folders, items and moves", D4–D6): what the rail
// shows, and making, renaming, deleting and sharing folders. Moves are ./folderMove.ts.
//
//   - a top-level folder (parent NULL) is made, renamed, deleted and shared by a project admin; a subfolder (under
//     Everyone — the project id — or under a folder) by anyone with Edit on its parent, and changed with Edit on it;
//   - at most MAX_DEPTH levels below Everyone or a top-level folder, MAX_FOLDERS per project, names 1–120 characters
//     unique among siblings regardless of case (0032's index answers the race);
//   - a delete takes an empty folder and its empty subfolders in one statement; an item anywhere in it, the Trash
//     included, refuses `not_empty` (and 0032's RESTRICT backs that up). It never moves items: that could widen access.
//
// A folder the caller cannot open answers `closed`, as an unknown id does (names nothing). Without Postgres there are no
// folders: the tree is empty and every change answers that folders need a database.

import { isValidId } from '../../app/ids';
import { ctx } from '../context';
import { inOrg, orgDb } from '../db/inOrg';
import * as msg from '../folderMessages';
import { rankOn } from './caller';
import { folderAccessOn, FolderError, levelIn, MAX_DEPTH, rootOf, type FolderAccess, type FolderLevel, type FolderRow } from './folders';
import { membersOn, levelAt as personLevel } from './folderPeople';
import type { PoolClient } from 'pg';

export const MAX_FOLDERS = 1000;

let creating = false;
/**
 * ORDINATE_FOLDERS (../env.ts), from buildApp: whether folders may be made, shared and moved. Off by default, until every
 * pod runs a release with the folder readers (D22); the tree, rename, delete and Share → Folders' list work either way.
 */
export function useFolders(on: boolean): void {
  creating = on;
}
export const foldersOn = (): boolean => creating;

type Open = Exclude<FolderLevel, 'none'>;
export interface FolderNode {
  readonly id: string;
  /** null: a top-level folder; the project id: under Everyone; else its parent folder. */
  readonly parentId: string | null;
  readonly name: string;
  readonly level: Open;
  /** Items placed in it, the Trash included: what a delete waits on. */
  readonly items: number;
  /** Top-level folders: whether dashboards elsewhere may show its data (D9), and the teams given it. */
  readonly shareFigures?: boolean;
  readonly grants?: ReadonlyArray<{ teamId: string; team: string; level: 'view' | 'edit' }>;
  /** An admin sees it only as an admin: no team of theirs was given its top-level folder. */
  readonly adminOnly?: boolean;
}

export interface FolderTree {
  /** False without Postgres: no teams, so no folders. */
  readonly available: boolean;
  /** ORDINATE_FOLDERS is on: folders may be made, shared and moved here (else the screens hide those actions). */
  readonly enabled: boolean;
  /** The caller's level on Everyone in the project (the project id). */
  readonly everyone: Open;
  /** A project admin: makes top-level folders, gives them to teams. */
  readonly admin: boolean;
  readonly folders: readonly FolderNode[];
  /** Where each item in a folder the caller opens sits; an item not named is in Everyone. */
  readonly placed: { readonly dataset: Record<string, string>; readonly dashboard: Record<string, string> };
}

export type Reply<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

interface Row { id: string; parent_id: string | null; name: string; share_figures: boolean; items: number }

const levelOf = (access: FolderAccess, id: string): FolderLevel => levelIn(access, id);

async function rowsOf(c: PoolClient, org: string, p: string): Promise<Row[]> {
  return (await c.query<Row>(
    `SELECT f.id::text AS id, f.parent_id::text AS parent_id, f.name, f.share_figures,
            (SELECT count(*)::int FROM folder_items i WHERE i.org_id = f.org_id AND i.project_id = f.project_id AND i.folder_id = f.id) AS items
       FROM folders f WHERE f.org_id = $1 AND f.project_id = $2 ORDER BY lower(f.name), f.id`,
    [org, p],
  )).rows;
}

/** The rows as the resolver's map (lowercase ids), for `rootOf`. */
const mapOf = (rows: readonly Row[]): Map<string, FolderRow> =>
  new Map(rows.map((r) => [r.id.toLowerCase(), { id: r.id.toLowerCase(), parentId: r.parent_id === null ? null : r.parent_id.toLowerCase(), shareFigures: r.share_figures, grant: null }]));

/** Steps from `id` up to its root (Everyone and a top-level folder: 0), or null when it is no folder here. */
function depthOf(p: string, id: string, byId: ReadonlyMap<string, FolderRow>): number | null {
  if (id === p) return 0;
  let f = byId.get(id);
  let depth = 0;
  while (f && f.parentId !== null && f.parentId !== p) {
    if (++depth > MAX_DEPTH) return null;
    f = byId.get(f.parentId);
  }
  return f ? (f.parentId === null ? depth : depth + 1) : null;
}

/** The tree the caller sees: every folder they open (an admin: all), each item's folder. */
export async function folderTree(projectId: string): Promise<FolderTree> {
  const p = projectId.toLowerCase();
  const rank = await rankOn(p);
  const everyone: Open = rank >= 3 ? 'manage' : rank === 2 ? 'edit' : 'view';
  if (!orgDb()) return { available: false, enabled: creating, everyone, admin: rank >= 3, folders: [], placed: { dataset: {}, dashboard: {} } };
  const access = await folderAccessOn(p);
  const email = ctx().user.email;
  const { rows, grants, items } = await inOrg(async (c, org) => ({
    rows: await rowsOf(c, org, p),
    grants: (await c.query<{ folder_id: string; team_id: string; name: string; level: 'view' | 'edit'; mine: boolean }>(
      `SELECT g.folder_id::text AS folder_id, g.team_id::text AS team_id, t.name, g.level,
              EXISTS (SELECT 1 FROM team_members tm JOIN users u ON u.id = tm.user_id
                       WHERE tm.team_id = g.team_id AND u.org_id = $1 AND u.email = $3) AS mine
         FROM folder_grants g JOIN teams t ON t.id = g.team_id AND t.org_id = g.org_id
        WHERE g.org_id = $1 AND g.project_id = $2 ORDER BY lower(t.name)`,
      [org, p, email],
    )).rows,
    items: (await c.query<{ kind: string; item_id: string; folder_id: string }>(
      'SELECT kind, item_id, folder_id::text AS folder_id FROM folder_items WHERE org_id = $1 AND project_id = $2',
      [org, p],
    )).rows,
  }));
  const byId = mapOf(rows);
  const folders: FolderNode[] = [];
  for (const r of rows) {
    const id = r.id.toLowerCase();
    const level = levelOf(access, id);
    if (level === 'none') continue;
    const root = rootOf(p, id, byId);
    const top = r.parent_id === null;
    const given = grants.filter((g) => g.folder_id.toLowerCase() === id);
    const rootGrants = root && root !== 'everyone' ? grants.filter((g) => g.folder_id.toLowerCase() === root.id) : [];
    folders.push({
      id, parentId: r.parent_id === null ? null : r.parent_id.toLowerCase(), name: r.name, level, items: r.items,
      ...(top ? { shareFigures: r.share_figures, grants: given.map((g) => ({ teamId: g.team_id.toLowerCase(), team: g.name, level: g.level })) } : {}),
      ...(access.all && root !== 'everyone' && !rootGrants.some((g) => g.mine) ? { adminOnly: true } : {}),
    });
  }
  const placed = { dataset: {} as Record<string, string>, dashboard: {} as Record<string, string> };
  for (const it of items) {
    if ((it.kind === 'dataset' || it.kind === 'dashboard') && levelOf(access, it.folder_id) !== 'none') placed[it.kind][it.item_id] = it.folder_id.toLowerCase();
  }
  return { available: true, enabled: creating, everyone, admin: rank >= 3, folders, placed };
}

/** Refuses below Edit on `id` (the project id: Everyone): `closed` when the caller cannot open it, `edit` at view. */
function mustEditFolder(access: FolderAccess, id: string): void {
  const level = levelOf(access, id);
  if (level === 'none') throw new FolderError('closed');
  if (level === 'view') throw new FolderError('edit');
}

/** One project's folder changes at a time (the cap and the depth are counted under it). */
const lock = (c: PoolClient, org: string, p: string) => c.query("SELECT pg_advisory_xact_lock(hashtext('ordinate.folders'), hashtext($1))", [`${org}/${p}`]);

const unique = (err: unknown): boolean => (err as { code?: string } | null)?.code === '23505';

/** `parentId` null: a top-level folder (project admins); the project id: under Everyone; else under that folder. */
export async function createFolder(projectId: string, parentId: string | null, name: string): Promise<Reply<{ folder: { id: string } }>> {
  if (!orgDb()) return fail(msg.folderNeedsDatabaseMessage());
  const p = projectId.toLowerCase();
  const parent = parentId === null ? null : parentId.toLowerCase();
  const access = await folderAccessOn(p);
  if (parent === null) {
    if ((await rankOn(p)) < 3) return fail(msg.folderTopLevelAdminMessage());
  } else mustEditFolder(access, parent);
  return inOrg(async (c, org) => {
    await lock(c, org, p);
    const rows = await rowsOf(c, org, p);
    if (rows.length >= MAX_FOLDERS) return fail(msg.folderTooManyMessage());
    if (parent !== null) {
      const depth = depthOf(p, parent, mapOf(rows));
      if (depth === null) throw new FolderError('closed');
      if (depth + 1 > MAX_DEPTH) return fail(msg.folderTooDeepMessage());
    }
    await c.query('SAVEPOINT made');
    try {
      const r = await c.query<{ id: string }>(
        'INSERT INTO folders (org_id, project_id, id, parent_id, name, created_by) VALUES ($1, $2, gen_random_uuid(), $3, $4, $5) RETURNING id::text AS id',
        [org, p, parent, name, ctx().user.email],
      );
      return { ok: true as const, folder: { id: r.rows[0].id.toLowerCase() } };
    } catch (err) {
      if (!unique(err)) throw err;
      await c.query('ROLLBACK TO SAVEPOINT made');
      return fail(msg.folderNameTakenMessage());
    }
  });
}

/** The folder, when it is one of the project's and the caller opens it; else `closed`. Everyone is no folder here. */
async function folderFor(c: PoolClient, org: string, p: string, access: FolderAccess, id: string): Promise<{ rows: Row[]; row: Row }> {
  const rows = await rowsOf(c, org, p);
  const row = rows.find((r) => r.id.toLowerCase() === id);
  if (!row || levelOf(access, id) === 'none') throw new FolderError('closed');
  return { rows, row };
}

/** A top-level folder needs a project admin; a subfolder Edit on it. */
async function mayChange(p: string, access: FolderAccess, row: Row): Promise<string | null> {
  if (row.parent_id === null) return (await rankOn(p)) >= 3 ? null : msg.folderTopLevelAdminMessage();
  mustEditFolder(access, row.id.toLowerCase());
  return null;
}

export async function renameFolder(projectId: string, folderId: string, name: string): Promise<Reply> {
  if (!orgDb()) return fail(msg.folderNeedsDatabaseMessage());
  const p = projectId.toLowerCase();
  const id = folderId.toLowerCase();
  if (id === p) return fail(msg.folderEveryoneFixedMessage());
  const access = await folderAccessOn(p);
  return inOrg(async (c, org) => {
    const { row } = await folderFor(c, org, p, access, id);
    const no = await mayChange(p, access, row);
    if (no) return fail(no);
    await c.query('SAVEPOINT named');
    try {
      await c.query('UPDATE folders SET name = $4 WHERE org_id = $1 AND project_id = $2 AND id = $3', [org, p, id, name]);
      return { ok: true as const };
    } catch (err) {
      if (!unique(err)) throw err;
      await c.query('ROLLBACK TO SAVEPOINT named');
      return fail(msg.folderNameTakenMessage());
    }
  });
}

/** The folder and every folder under it. */
function subtree(rows: readonly Row[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) for (const r of rows) if (r.parent_id?.toLowerCase() === out[i]) out.push(r.id.toLowerCase());
  return out;
}

export async function deleteFolder(projectId: string, folderId: string): Promise<Reply> {
  if (!orgDb()) return fail(msg.folderNeedsDatabaseMessage());
  const p = projectId.toLowerCase();
  const id = folderId.toLowerCase();
  if (id === p) return fail(msg.folderEveryoneFixedMessage());
  const access = await folderAccessOn(p);
  return inOrg(async (c, org) => {
    await lock(c, org, p);
    const { rows, row } = await folderFor(c, org, p, access, id);
    const no = await mayChange(p, access, row);
    if (no) return fail(no);
    const ids = subtree(rows, id);
    if (rows.some((r) => ids.includes(r.id.toLowerCase()) && r.items > 0)) throw new FolderError('not_empty');
    try {
      await c.query('DELETE FROM folders WHERE org_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])', [org, p, ids]);
    } catch (err) {
      if ((err as { code?: string }).code === '23503') throw new FolderError('not_empty'); // an item placed meanwhile
      throw err;
    }
    return { ok: true as const };
  });
}

/** A top-level folder of the project, for the admin channels: its row, or a reply saying why not. */
async function topLevel(c: PoolClient, org: string, p: string, id: string): Promise<Row | string> {
  if (id === p) return msg.folderEveryoneFixedMessage();
  const row = (await rowsOf(c, org, p)).find((r) => r.id.toLowerCase() === id);
  if (!row) throw new FolderError('closed');
  return row.parent_id === null ? row : msg.folderTopLevelOnlyMessage();
}

export async function setShareFigures(projectId: string, folderId: string, on: boolean): Promise<Reply> {
  if (!orgDb()) return fail(msg.folderNeedsDatabaseMessage());
  const p = projectId.toLowerCase();
  return inOrg(async (c, org) => {
    const row = await topLevel(c, org, p, folderId.toLowerCase());
    if (typeof row === 'string') return fail(row);
    await c.query('UPDATE folders SET share_figures = $4 WHERE org_id = $1 AND project_id = $2 AND id = $3', [org, p, row.id, on]);
    return { ok: true as const };
  });
}

export async function grantFolder(projectId: string, folderId: string, teamId: string, level: 'view' | 'edit' | null): Promise<Reply> {
  if (!orgDb()) return fail(msg.folderNeedsDatabaseMessage());
  const p = projectId.toLowerCase();
  return inOrg(async (c, org) => {
    await lock(c, org, p);
    const row = await topLevel(c, org, p, folderId.toLowerCase());
    if (typeof row === 'string') return fail(row);
    if (!isValidId(teamId) || (await c.query('SELECT 1 FROM teams WHERE id = $1 AND org_id = $2', [teamId, org])).rowCount !== 1) return fail(msg.folderUnknownTeamMessage());
    if (level === null) await c.query('DELETE FROM folder_grants WHERE org_id = $1 AND project_id = $2 AND folder_id = $3 AND team_id = $4', [org, p, row.id, teamId]);
    else {
      await c.query(
        `INSERT INTO folder_grants (org_id, project_id, folder_id, team_id, level) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, project_id, folder_id, team_id) DO UPDATE SET level = EXCLUDED.level`,
        [org, p, row.id, teamId, level],
      );
    }
    return { ok: true as const };
  });
}

/** A deleted project's folders, grants and placements: a project that is gone leaves no access behind (as dropGrants). */
export async function dropFolders(projectId: string): Promise<void> {
  if (!orgDb() || !isValidId(projectId)) return;
  const p = projectId.toLowerCase();
  await inOrg(async (c, org) => {
    await c.query('DELETE FROM folder_items WHERE org_id = $1 AND project_id = $2', [org, p]);
    await c.query('DELETE FROM folders WHERE org_id = $1 AND project_id = $2', [org, p]); // grants go with them (CASCADE)
  });
}

export interface FolderAccessReply {
  readonly ok: true;
  /** ORDINATE_FOLDERS is on (FolderTree.enabled). */
  readonly enabled: boolean;
  /** Project members who are not admins: Everyone in the project opens at their role. */
  readonly everyone: number;
  readonly folders: ReadonlyArray<{
    id: string;
    name: string;
    shareFigures: boolean;
    items: number;
    /** Members (not admins) who open it through a team: what its grants add up to. */
    people: number;
    grants: ReadonlyArray<{ teamId: string; team: string; level: 'view' | 'edit'; people: number }>;
  }>;
  /** The org's teams: members, and how many of them hold a project role here (only they get a folder grant's access). */
  readonly teams: ReadonlyArray<{ id: string; name: string; members: number; inProject: number }>;
}

/** Share → Folders (admins): each top-level folder, its grants and the people they add up to, and the org's teams. */
export async function folderAccess(projectId: string): Promise<FolderAccessReply | { ok: false; error: string }> {
  if (!orgDb()) return fail(msg.folderNeedsDatabaseMessage());
  const p = projectId.toLowerCase();
  return inOrg(async (c, org) => {
    const rows = (await rowsOf(c, org, p)).filter((r) => r.parent_id === null);
    const grants = (await c.query<{ folder_id: string; team_id: string; name: string; level: 'view' | 'edit' }>(
      `SELECT g.folder_id::text AS folder_id, g.team_id::text AS team_id, t.name, g.level
         FROM folder_grants g JOIN teams t ON t.id = g.team_id AND t.org_id = g.org_id
        WHERE g.org_id = $1 AND g.project_id = $2 ORDER BY lower(t.name)`,
      [org, p],
    )).rows;
    const teams = (await c.query<{ id: string; name: string; members: number }>(
      `SELECT t.id::text AS id, t.name, count(u.id)::int AS members
         FROM teams t LEFT JOIN team_members tm ON tm.team_id = t.id
         LEFT JOIN users u ON u.id = tm.user_id AND u.disabled_at IS NULL
        WHERE t.org_id = $1 GROUP BY t.id, t.name ORDER BY lower(t.name)`,
      [org],
    )).rows;
    const people = await membersOn(c, org, p);
    const grantsOn = (f: string) => grants.filter((g) => g.folder_id.toLowerCase() === f).map((g) => ({ teamId: g.team_id.toLowerCase(), team: g.name, level: g.level }));
    const opens = (root: string) => people.filter((m) => personLevel(m, root, p, grantsOn(root)) !== 'none').length;
    return {
      ok: true as const,
      enabled: creating,
      everyone: people.length,
      folders: rows.map((r) => {
        const id = r.id.toLowerCase();
        const given = grantsOn(id);
        return {
          id, name: r.name, shareFigures: r.share_figures, items: r.items, people: opens(id),
          grants: given.map((g) => ({ ...g, people: people.filter((m) => m.teams.includes(g.teamId)).length })),
        };
      }),
      teams: teams.map((t) => ({ id: t.id.toLowerCase(), name: t.name, members: t.members, inProject: people.filter((m) => m.teams.includes(t.id.toLowerCase())).length })),
    };
  });
}
