// Admin and personal-token calls. Contracts carry inputs only, so each reply is
// narrowed here by hand to what its handler returns (src/server/admin/*.ts,
// src/server/auth/tokens.ts). Every figure in a reply — a team count, a
// timestamp — is the server's; the screens only format it.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc, type Channel, type RpcArgs, type RpcInput } from '../../api/client';
import { toast } from '../../ui/Toast';

export type Role = 'admin' | 'editor' | 'viewer';

export interface AdminUser {
  id: string;
  email: string;
  role: Role;
  pending: boolean;
  /** Holds a temporary password an admin set (password sign-in). Absent from an older server. */
  mustChangePassword?: boolean;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  teams: number;
}

export interface Team {
  id: string;
  name: string;
  createdAt: string;
  members: { id: string; email: string }[];
}

export interface AdminProject {
  id: string;
  name: string;
  archived: boolean;
  updatedAt: string;
  owner: { id: string; name: string } | null;
}

export interface AuditRow {
  id: number;
  at: string;
  actor: string | null;
  action: string;
  channel: string | null;
  projectId: string | null;
  targets: string[];
  outcome: 'ok' | 'denied' | 'error';
  requestId: string | null;
}

export interface AuditFilter {
  actor?: string;
  action?: 'rpc' | 'login' | 'logout' | 'logout_everywhere' | 'password_change' | 'hook_refresh' | 'scheduled_refresh';
  channel?: string;
  projectId?: string;
  from?: string;
  to?: string;
  outcome?: 'ok' | 'denied' | 'error';
  before?: number;
}

export interface AuditPage {
  rows: AuditRow[];
  next: number | null;
  channels?: string[];
}

export interface OrgSettings {
  publicLinks: boolean;
  aiProviders: string[];
  uploadCapMb: number | null;
  maxUploadMb: number;
  providers: string[];
}

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** Admin → Live usage (src/server/admin/liveUsage.ts): one UTC day of one connection. */
export interface LiveUsageRow {
  day: string;
  connectionId: string;
  projectId: string;
  queries: number;
  /** Null: the warehouse reports no byte figure (Snowflake). */
  bytes: number | null;
  refused: number;
  /** Null: the connection was deleted (its count stays). */
  connection: string | null;
  connector: string | null;
  project: string | null;
  /** `bytes` as the server formatted it ("1.2 GB"). */
  bytesLabel: string | null;
}

export interface LiveUsage {
  /** Today, UTC: the day the limit counts. */
  today: string;
  /** LIVE_DAILY_QUERY_LIMIT; 0 = no limit. */
  limit: number;
  todayQueries: number;
  todayRefused: number;
  /** "12%", the server's; null without a limit. */
  usedLabel: string | null;
  /** No Postgres: this server's own counts, since it started. */
  perPod: boolean;
  days: number;
  rows: LiveUsageRow[];
}

/** One provider on Admin → AI (src/server/aiConfig.ts ProviderState): flags, never a key. */
export interface AiProviderState {
  provider: 'anthropic' | 'openai' | 'gemini' | 'gateway';
  /** Saved and its last connection test passed. */
  connected: boolean;
  /** Saved; with `connected` false, the last test failed. */
  saved: boolean;
  hasKey: boolean;
  baseUrl: string;
  verifiedAt: string | null;
}

export interface AiModelRow {
  provider: AiProviderState['provider'];
  model: string;
  label: string;
  isDefault: boolean;
}

/** `ai:admin`: the org's AI setup. `keyStore` says why this server cannot store a key, or null. */
export interface AiAdmin {
  keyStore: string | null;
  providers: AiProviderState[];
  models: AiModelRow[];
}

/** A provider's live list (`ai:providerModels`, src/ai/models.ts). */
export type ProviderModels = { ok: true; models: { id: string; label: string }[] } | { ok: false; errorType?: string };

/** An ai:* write's reply: a refusal (`error`) or a failed connection test (`message`, `detail`). */
export interface AiOutcome {
  ok: boolean;
  error?: string;
  message?: string;
  detail?: string;
}
export const aiWhy = (r: AiOutcome): string => r.error || [r.message, r.detail].filter(Boolean).join(' — ') || 'The change did not go through.';

export const useAiAdmin = () => useQuery({ queryKey: ['ai:admin'], queryFn: async () => (await rpc('ai:admin')) as AiAdmin });

export type Created = { ok: true; id: string; name: string; prefix: string; createdAt: string; token: string } | { ok: false; error: string };

/** A write's reply: `{ ok }`, or why not. */
type Result = { ok: boolean; error?: string };

export const ROLES: readonly { value: Role; label: string }[] = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
  { value: 'admin', label: 'Admin' },
];

/** What a refusal means, in words. */
const REFUSAL: Record<string, string> = {
  exists: 'That name or address is already taken.',
  domain: 'That email domain is not allowed to sign in to this server.',
  'last-admin': 'The organization needs at least one enabled admin.',
  self: 'You cannot disable your own account.',
  unknown: 'That person or team no longer exists. Refresh and try again.',
  'unknown project': 'That project no longer exists.',
  'unknown team': 'That team no longer exists.',
  cap: 'The cap cannot be above the server limit.',
  session: 'Tokens can only be created from a signed-in browser session.',
  limit: 'You have 50 active tokens. Revoke one first.',
  'password-short': 'A password needs at least 10 characters.',
  'password-long': 'A password can be 256 characters at most.',
  'self-password': 'Change your own password from the account menu instead.',
  mode: 'This server does not sign in with passwords.',
};
export const refusal = (code: string | undefined): string => REFUSAL[code ?? ''] ?? 'The change was refused.';

type ListChannel = 'admin:users' | 'admin:teams' | 'admin:projects' | 'admin:settings' | 'admin:liveUsage' | 'tokens:list';
const list = <T,>(channel: ListChannel) => ({ queryKey: [channel], queryFn: async () => (await rpc(channel)) as T });

export const useAdminUsers = () => useQuery(list<AdminUser[]>('admin:users'));
export const useTeams = () => useQuery(list<Team[]>('admin:teams'));
export const useAdminProjects = () => useQuery(list<AdminProject[]>('admin:projects'));
export const useOrgSettings = () => useQuery(list<OrgSettings>('admin:settings'));
export const useTokens = () => useQuery(list<ApiToken[]>('tokens:list'));
export const useLiveUsage = () => useQuery(list<LiveUsage>('admin:liveUsage'));

export function useAudit(filter: AuditFilter) {
  return useQuery({
    queryKey: ['admin:audit', filter],
    queryFn: async () => (await rpc('admin:audit', filter)) as AuditPage,
    placeholderData: (prev) => prev,
  });
}

/**
 * A write: calls `channel`, refreshes the lists in `refresh` on success, and
 * toasts a refusal (`ok: false`) or a failure. `onDone` gets the reply.
 */
export function useWrite<C extends Channel, R extends Result = Result>(
  channel: C,
  refresh: readonly Channel[],
  onDone?: (reply: R) => void,
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: RpcInput<C>) => (await rpc(channel, ...([input] as RpcArgs<C>))) as R,
    onSuccess: (reply) => {
      for (const key of refresh) void client.invalidateQueries({ queryKey: [key] });
      if (!reply.ok) toast(refusal(reply.error), { kind: 'error' });
      onDone?.(reply);
    },
    onError: (err) => toast(`The change did not go through: ${err.message}`, { kind: 'error' }),
  });
}

/**
 * An ai:* write: refreshes the admin view and every member's `ai:status` (the
 * dock re-reads it), and hands the reply on — a refusal or a failed test is
 * shown where it happened, not as a toast.
 */
export function useAiWrite<C extends 'ai:connect' | 'ai:disconnect' | 'ai:setModels'>(channel: C, onDone?: (reply: AiOutcome) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: RpcInput<C>) => (await rpc(channel, ...([input] as RpcArgs<C>))) as AiOutcome,
    // Pending until the admin view is re-read, so a control never shows the old state in between.
    onSuccess: async (reply) => {
      await Promise.all([client.invalidateQueries({ queryKey: ['ai:admin'] }), client.invalidateQueries({ queryKey: ['ai:status'] })]);
      onDone?.(reply);
    },
    onError: (err) => toast(`The change did not go through: ${err.message}`, { kind: 'error' }),
  });
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
export const fmtDateTime = (iso: string) => dateTime.format(new Date(iso));
export const fmtDate = (iso: string) => dateOnly.format(new Date(iso));
