// Projects, sharing, Trash and version-history calls (T2.2). Contracts carry
// inputs only, so each reply is narrowed here by hand to what its handler
// returns (src/ipc/projects.ts, src/ipc/trash.ts, src/ipc/versions.ts,
// src/server/authz/share.ts). Every figure — a count, days left — is the
// server's; the screens only format it.

import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc, type Channel, type RpcArgs, type RpcInput } from '../../api/client';
import { toast } from '../../ui/Toast';

export type Role = 'viewer' | 'editor' | 'admin';

/** One switcher row (`projects:overview`). */
export interface ProjectRow {
  id: string;
  name: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  archived: boolean;
  datasets: number;
  dashboards: number;
  sample: boolean;
}

/** `project:access`: who holds which role. The owner team's grant is moved in Admin, not here. */
export interface Grant {
  kind: 'user' | 'team';
  id: string;
  label: string;
  role: Role;
  owner: boolean;
}

export interface ShareTargets {
  users: { id: string; email: string }[];
  teams: { id: string; name: string }[];
}

export type RecordType = 'dataset' | 'visual' | 'dashboard' | 'metric' | 'report' | 'alert';
export type VersionType = Exclude<RecordType, 'alert'>;

/** `trash:list`: one deleted record. */
export interface TrashItem {
  type: RecordType;
  id: string;
  name: string;
  deletedAt: string;
  /** The dataset whose delete took this visual along. */
  deletedWith?: string;
  daysLeft: number;
}

export interface Restored {
  type: RecordType;
  id: string;
  name: string;
}

/** `versions:list`: one save, newest first. */
export interface VersionMeta {
  key: string;
  savedAt: string;
  summary: string;
  restoredFrom?: string;
  /** Dashboards: the first sheet's tiles on the 12-column grid. */
  thumb?: { x: number; y: number; w: number; h: number; type: string }[];
}

/** `versions:get`: one version's content — the record as it was (its store's own shape). */
export interface VersionFile {
  savedAt: string;
  summary: string;
  restoredFrom?: string;
  record: Record<string, unknown>;
}

const OVERVIEW = 'projects:overview';
const ROLES = 'projects:roles';

/** Most recently opened first; never-opened ones by their last edit. */
export function byRecent(list: readonly ProjectRow[]): ProjectRow[] {
  const key = (p: ProjectRow) => p.lastOpenedAt || p.updatedAt || '';
  return [...list].sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));
}

export function useOverview() {
  return useQuery({ queryKey: [OVERVIEW], queryFn: async () => (await rpc(OVERVIEW)) as ProjectRow[] });
}

/**
 * The caller's role on each project they can open. One call, cached across
 * screens — and asked only when something shows actions (`enabled`): the
 * shell itself must cost every page no more than the one `projects:overview`.
 */
export function useRoles(enabled = true) {
  return useQuery({ queryKey: [ROLES], queryFn: async () => (await rpc(ROLES)) as Record<string, Role>, staleTime: 30_000, enabled });
}

const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };

/** May the caller do what `need` names on `projectId`? False until the roles are known. */
export function useCan(projectId: string | null | undefined) {
  const roles = useRoles();
  const role = projectId ? roles.data?.[projectId] : undefined;
  return (need: Role) => !!role && RANK[role] >= RANK[need];
}

/** May the caller change things in `projectId` (editor or admin)? False until the roles are known: a viewer never sees a control flash. */
export function useCanEdit(projectId: string | null | undefined): boolean {
  return useCan(projectId)('editor');
}

export function useAccess(projectId: string | null) {
  return useQuery({
    queryKey: ['project:access', projectId],
    queryFn: projectId ? async () => (await rpc('project:access', { projectId })) as Grant[] : skipToken,
  });
}

export function useShareTargets(projectId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['project:shareTargets', projectId],
    queryFn: projectId && enabled ? async () => (await rpc('project:shareTargets', { projectId })) as ShareTargets : skipToken,
  });
}

export function useTrash(projectId: string | null) {
  return useQuery({
    queryKey: ['trash:list', projectId],
    queryFn: projectId ? async () => (await rpc('trash:list', { projectId })) as TrashItem[] : skipToken,
  });
}

export function useVersions(projectId: string, type: VersionType, id: string) {
  return useQuery({
    queryKey: ['versions:list', projectId, type, id],
    queryFn: async () => (await rpc('versions:list', { projectId, type, id })) as VersionMeta[],
  });
}

/** One version's content; `null` data = that version is gone. */
export function useVersion(projectId: string, type: VersionType, id: string, key: string | undefined) {
  return useQuery({
    queryKey: ['versions:get', projectId, type, id, key],
    queryFn: key ? async () => (await rpc('versions:get', { projectId, type, id, key })) as VersionFile | null : skipToken,
  });
}

/**
 * A change: calls `channel`, refreshes the queries named in `refresh` (by
 * their first key) when it settles, toasts a failure. `onDone` gets the reply.
 */
export function useChange<C extends Channel, R>(channel: C, refresh: readonly string[], onDone?: (reply: R, input: RpcInput<C>) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: RpcInput<C>) => (await rpc(channel, ...([input] as RpcArgs<C>))) as R,
    onSuccess: (reply, input) => onDone?.(reply, input),
    onError: (err) => toast(err.message === 'forbidden' ? 'You do not have permission to do that here.' : `That did not go through: ${err.message}`, { kind: 'error' }),
    onSettled: () => {
      for (const key of refresh) void client.invalidateQueries({ queryKey: [key] });
    },
  });
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const timeOnly = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayName = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const monthDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

export const fmtWhen = (iso: string) => dateTime.format(new Date(iso));
export const fmtTime = (iso: string) => timeOnly.format(new Date(iso));

/** "Today", "Yesterday" or "Mon, Oct 3" — a version list's day heading. */
export function fmtDay(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const days = Math.round((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return dayName.format(d);
}

/** "opened 2h ago" — or "never opened" for a project nobody has switched to. */
export function fmtOpened(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never opened';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return 'opened just now';
  if (s < 3600) return `opened ${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `opened ${Math.floor(s / 3600)}h ago`;
  if (s < 86_400 * 7) return `opened ${Math.floor(s / 86_400)}d ago`;
  return `opened ${monthDay.format(new Date(iso))}`;
}

export const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
