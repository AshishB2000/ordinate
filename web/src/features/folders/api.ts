// Shared folders on the web (docs/team-folders/00-design.md, "What you will see"): the tree the rail, the chips and the
// Move dialog draw from (`folder:tree`), Share → Folders (`folder:access`) and the writes. Every rule is the server's
// (src/server/authz/folderTree.ts, folderMove.ts): a screen only offers what the tree says the caller may do, and a
// refusal comes back in the server's words.

import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { rpc, type Channel, type RpcInput } from '../../api/client';

export type Level = 'view' | 'edit' | 'manage';
export type PlacedKind = 'dataset' | 'dashboard';

export interface FolderNode {
  id: string;
  /** null: a top-level folder; the project id: under Everyone; else its parent folder. */
  parentId: string | null;
  name: string;
  level: Level;
  items: number;
  shareFigures?: boolean;
  grants?: Array<{ teamId: string; team: string; level: 'view' | 'edit' }>;
  adminOnly?: boolean;
}

export interface FolderTree {
  available: boolean;
  /** ORDINATE_FOLDERS is on: folders may be made, shared and moved (off: those actions are hidden, FOLDERS_OFF says why). */
  enabled: boolean;
  everyone: Level;
  admin: boolean;
  folders: FolderNode[];
  placed: Record<PlacedKind, Record<string, string>>;
}

export interface FolderAccess {
  ok: true;
  enabled: boolean;
  everyone: number;
  folders: Array<{ id: string; name: string; shareFigures: boolean; items: number; people: number; grants: Array<{ teamId: string; team: string; level: 'view' | 'edit'; people: number }> }>;
  teams: Array<{ id: string; name: string; members: number; inProject: number }>;
}

export interface MoveImpact {
  ok: true;
  to: string | null;
  moving: { datasets: number; dashboards: number };
  lose: Array<{ team: string | null; people: number }>;
  gain: Array<{ team: string | null; people: number }>;
  viewOnly: number;
  canEdit: number;
  published: number;
  recipients: number;
  reachers: { dashboards: number; keeps: boolean };
  hash: string;
}

export type Failed = { ok: false; error: string };

/** What Everyone is called on every screen. */
export const EVERYONE = 'Everyone in the project';

/** The one line shown where a folder change is hidden because the server has folders off (ORDINATE_FOLDERS). */
export const FOLDERS_OFF = 'Making, sharing and moving folders is off on this server. An operator turns it on once every server runs this version.';

export function useFolderTree(projectId: string | null | undefined) {
  return useQuery({
    queryKey: ['folder:tree', projectId],
    queryFn: projectId ? async () => (await rpc('folder:tree', { projectId })) as FolderTree : skipToken,
    staleTime: 15_000,
  });
}

export function useFolderAccess(projectId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['folder:access', projectId],
    queryFn: projectId && enabled ? async () => (await rpc('folder:access', { projectId })) as FolderAccess | Failed : skipToken,
  });
}

/** Lists that change when folders or placements do. */
const AFTER = ['folder:tree', 'folder:access', 'dataset:list', 'analysis:gallery', 'projects:overview', 'search:query'];

/** A folder write: refreshes the tree and the lists; a reply `{ok:false}` or a refusal is the caller's to show. */
export function useFolderWrite<C extends Channel>(channel: C) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: RpcInput<C>) => (await rpc(channel, ...([input] as never))) as { ok: true } & Record<string, unknown> | Failed,
    onSettled: () => {
      for (const key of AFTER) void client.invalidateQueries({ queryKey: [key] });
    },
  });
}

/** Does the project hold a folder besides Everyone? Then the rail, chips and Move appear. */
export const hasFolders = (t: FolderTree | undefined): t is FolderTree => !!t?.available && Array.isArray(t.folders) && t.folders.length > 0;

export const byId = (t: FolderTree): Map<string, FolderNode> => new Map(t.folders.map((f) => [f.id, f]));

/** `id` and its ancestors, nearest last: Everyone is not in it. */
export function pathOf(t: FolderTree, id: string): FolderNode[] {
  const all = byId(t);
  const out: FolderNode[] = [];
  for (let f = all.get(id); f && out.length < 8; f = f.parentId ? all.get(f.parentId) : undefined) out.unshift(f);
  return out;
}

/** The folder an item sits in: its id, or the project id for Everyone. */
export const folderOfItem = (t: FolderTree | undefined, projectId: string, kind: PlacedKind, id: string): string => t?.placed?.[kind]?.[id.toLowerCase()] ?? projectId;

/** "Finance can view, Finance leads can edit" — the teams a top-level folder was given. */
export function grantsLine(root: FolderNode | undefined): string {
  if (!root?.grants?.length) return 'Only project admins';
  return root.grants.map((g) => `${g.team} can ${g.level}`).join(', ');
}

/** The rail's selection, in `?folder=` (absent: every item the caller opens; the project id: Everyone). */
export function useFolderParam(): [string | null, (id: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const set = (id: string | null) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (id) n.set('folder', id);
      else n.delete('folder');
      return n;
    }, { replace: true });
  return [params.get('folder'), set];
}

/** Can the caller put things in, or make a subfolder of, `id` (the project id: Everyone)? */
export function editsFolder(t: FolderTree, projectId: string, id: string): boolean {
  const level = id === projectId ? t.everyone : byId(t).get(id)?.level;
  return level === 'edit' || level === 'manage';
}

/** Children of `parent` (null: top level; the project id: under Everyone), by name. */
export const childrenOf = (t: FolderTree, parent: string | null): FolderNode[] =>
  t.folders.filter((f) => f.parentId === parent).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

/** `n people` / `1 person`. */
export const people = (n: number): string => `${n} ${n === 1 ? 'person' : 'people'}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `?folder=` when it names a folder: where a dataset made from the Data rail lands (the server checks it, D18). */
export const landingFolder = (params: URLSearchParams): string | undefined => {
  const f = params.get('folder');
  return f && UUID.test(f) ? f : undefined;
};
