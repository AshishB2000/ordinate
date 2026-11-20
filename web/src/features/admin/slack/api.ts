// Ordinate in Slack (docs/slack/00-design.md) — the server calls. Replies mirror src/server/slack/rpc.ts, narrowed by
// hand: contracts carry inputs only. A reply carries has-key flags, names and ids: never a key.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc, type RpcInput } from '../../../api/client';

export type SlackMode = 'events' | 'socket';

export interface SlackInstall {
  teamId: string;
  teamName: string;
  mode: SlackMode;
  enabled: boolean;
  allowGuests: boolean;
  allowShareOverride: boolean;
  botUserId: string;
  clientId: string;
  hasBotToken: boolean;
  hasSigningSecret: boolean;
  hasClientSecret: boolean;
  hasAppToken: boolean;
}

export interface SlackStatus {
  ok: true;
  /** The server can keep the keys (a database and a master key). */
  canSave: boolean;
  /** ORDINATE_PUBLIC_URL (or the OIDC origin), or null: then only Socket Mode works. */
  publicUrl: string | null;
  install: SlackInstall | null;
  linked: number;
  /** The app template as JSON text; `events` is null when the server does not know its public address. */
  manifest: { events: string | null; socket: string };
}
type Refusal = { ok: false; error: string };

const KEY = ['slack:status'];

export const useSlackStatus = () => useQuery({ queryKey: KEY, queryFn: async () => (await rpc('slack:status')) as SlackStatus | Refusal });

function useRefresh() {
  const client = useQueryClient();
  return () => Promise.all([client.invalidateQueries({ queryKey: KEY }), client.invalidateQueries({ queryKey: ['slack:myLink'] })]);
}

export function useSlackInstall() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (input: RpcInput<'slack:install'>) => (await rpc('slack:install', input)) as { ok: true; install: SlackInstall } | Refusal,
    onSuccess: async (r) => { if (r.ok) await refresh(); },
  });
}

export function useSlackSettings() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (input: RpcInput<'slack:settings'>) => (await rpc('slack:settings', input)) as { ok: true; install: SlackInstall } | Refusal,
    onSuccess: async (r) => { if (r.ok) await refresh(); },
  });
}

export function useSlackUninstall() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async () => (await rpc('slack:uninstall')) as { ok: true } | Refusal,
    onSuccess: async () => { await refresh(); },
  });
}

// ── a member's own link (Settings → You) ─────────────────────────────────────

export interface MySlack {
  ok: true;
  /** Slack is set up and on for this organization. */
  available: boolean;
  teamName?: string;
  links: Array<{ teamId: string; slackUserId: string; linkedAt: string }>;
}

export const useMySlack = () => useQuery({ queryKey: ['slack:myLink'], queryFn: async () => (await rpc('slack:myLink')) as MySlack | Refusal });

export function useUnlinkSlack() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => (await rpc('slack:unlink')) as { ok: true; removed: number } | Refusal,
    onSuccess: async () => { await client.invalidateQueries({ queryKey: ['slack:myLink'] }); },
  });
}

// ── an agent's channels (the agent page) ─────────────────────────────────────

export interface PickerChannel { id: string; name: string; isPrivate: boolean; agentId: string | null; projectId: string | null }

export const useSlackChannels = (projectId: string) =>
  useQuery({ queryKey: ['slack:channels', projectId], queryFn: async () => (await rpc('slack:channels', { projectId })) as { ok: true; connected: boolean; channels: PickerChannel[] } | Refusal });

export const useAgentChannels = (projectId: string, agentId: string) =>
  useQuery({
    queryKey: ['agent:slackChannels', projectId, agentId],
    queryFn: async () => (await rpc('agent:slackChannels', { projectId, agentId })) as { ok: true; connected: boolean; channels: Array<{ channelId: string; channelName: string }> } | Refusal,
  });

export function useSetAgentChannels(projectId: string, agentId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) =>
      (await rpc('agent:slackChannels', { projectId, agentId, channels: ids.map((id) => ({ id })) })) as { ok: true; connected: boolean; channels: Array<{ channelId: string; channelName: string }> } | Refusal,
    onSuccess: async () => {
      await Promise.all([client.invalidateQueries({ queryKey: ['agent:slackChannels', projectId, agentId] }), client.invalidateQueries({ queryKey: ['slack:channels', projectId] })]);
    },
  });
}
