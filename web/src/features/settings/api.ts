// Settings' server state. Contracts carry inputs only, so each reply is
// narrowed here by hand to what its handler returns (src/ipc/prefs.ts,
// themes.ts, privacy.ts, settingsServer.ts; key:status for the org's
// Assistant rules and switches). Every figure in a reply is the server's.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc, type Channel, type RpcArgs, type RpcInput } from '../../api/client';
import type { FormatPrefs } from '../../../../src/app/format.ts';
import { toast } from '../../ui/Toast';

export type { FormatPrefs };

export interface Branding {
  accent: string;
  logo: string;
  dashboardStyle: 'auto' | 'clean' | 'executive' | 'dense' | 'dark';
}

export interface Prefs {
  formats: FormatPrefs;
  branding: Branding;
}

/** The org's Assistant rules and switches, off `key:status` (publicConfig: no secret in it). */
export interface OrgConfig {
  globalRules: string;
  autoRefresh: boolean;
  notifications: { alerts?: boolean; alertExplain?: boolean };
}

export interface ThemeRecord {
  id: string;
  name: string;
  tokens: Record<string, string | number>;
  updatedAt: string;
}
export interface ThemeState {
  defaultId: string;
  themes: ThemeRecord[];
}

export type SharePath = 'export' | 'report' | 'publish' | 'bundle';
export type ShareAction = 'mask' | 'drop' | 'include';
export type Level = 'personal' | 'financial';

export interface Proposal {
  column: string;
  kind: string;
  level: Level;
  reason: string;
}
export interface PrivacyOverview {
  ok: boolean;
  error?: string;
  projectName: string;
  policy: Record<SharePath, ShareAction>;
  datasets: { id: string; name: string; sensitive: { column: string; level: Level; maskedInPrepare?: boolean }[]; pending: Proposal[] }[];
  datasetCount: number;
}

export interface ShareSummary {
  ok: boolean;
  count: number;
  action: ShareAction;
  line: string;
  columns: { column: string; datasetName?: string }[];
}

/** A write's reply: `{ ok }`, or why not. */
type Result = { ok: boolean; error?: string };

export function usePrefs() {
  return useQuery({ queryKey: ['prefs:get'], queryFn: async () => (await rpc('prefs:get')) as Prefs, staleTime: Infinity });
}

export function useOrgConfig() {
  return useQuery({ queryKey: ['key:status'], queryFn: async () => (await rpc('key:status')) as OrgConfig });
}

export function useLogo() {
  return useQuery({
    queryKey: ['branding:logo'],
    queryFn: async () => ((await rpc('branding:logo', 'workspace')) as { dataUrl: string | null }).dataUrl,
  });
}

export function useThemes() {
  return useQuery({ queryKey: ['themes:list'], queryFn: async () => (await rpc('themes:list')) as ThemeState });
}

export function usePrivacy(projectId: string | null) {
  return useQuery({
    queryKey: ['privacy:overview', projectId],
    queryFn: async () => {
      const r = (await rpc('privacy:overview', { projectId: projectId as string })) as PrivacyOverview;
      if (!r.ok) throw new Error(r.error ?? 'Could not read this project’s privacy settings.');
      return r;
    },
    enabled: !!projectId,
  });
}

/**
 * A write: calls `channel`, refreshes `refresh` on success, toasts a refusal
 * (`ok: false`) or a failure. Replies that are not `{ ok }` count as done.
 */
export function useWrite<C extends Channel, R = Result>(channel: C, refresh: readonly (readonly unknown[])[], onDone?: (reply: R) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: RpcInput<C>) => (await rpc(channel, ...([input] as RpcArgs<C>))) as R,
    onSuccess: (reply) => {
      for (const key of refresh) void client.invalidateQueries({ queryKey: key });
      const r = reply as Partial<Result> | null;
      if (r && r.ok === false) toast(r.error ?? 'The change was refused.', { kind: 'error' });
      onDone?.(reply);
    },
    onError: (err) => toast(`The change did not go through: ${err.message}`, { kind: 'error' }),
  });
}
