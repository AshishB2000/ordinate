// Subscriptions and channels — the server calls. Types mirror the handlers'
// replies (src/server/subscriptions/rpc.ts), narrowed by hand as everywhere in
// web/: contracts carry inputs only. Every sentence here — a schedule, a next
// run, a run's outcome, a size — is the server's; the screens only place it.

import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc, type RpcInput } from '../../api/client';
import { useServerEvent } from '../../api/events';

export type ChannelKind = 'slack' | 'teams';
export interface Channel {
  id: string;
  name: string;
  kind: ChannelKind;
  /** A webhook URL is stored. The URL itself never reaches a browser. */
  secretSet: boolean;
}
export interface ChannelFrame {
  channels: Channel[];
  /** False when this server cannot keep a webhook URL (no database or no master key). */
  canStore: boolean;
  /** The caller is an org admin: they may add, test and remove channels. */
  canManage: boolean;
}

export type Cadence = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly';
export interface Schedule {
  cadence: Cadence;
  at: string;
  days?: number[];
  dayOfMonth?: number;
}
export type Draft = RpcInput<'subscription:save'>['subscription'];

export interface RunView {
  at: string;
  slot?: string;
  trigger: 'schedule' | 'manual';
  outcome: 'sent' | 'skipped' | 'failed' | 'missed';
  text: string;
}
export interface NextRun {
  at: string;
  text: string;
}
export interface Subscription {
  id: string;
  projectId: string;
  name: string;
  analysisId: string;
  /** Null: the dashboard was deleted. */
  dashboard: string | null;
  content: { mode: 'all' | 'cards'; cardIds: string[] };
  viewId: string | null;
  schedule: Schedule;
  timezone: string;
  channelIds: string[];
  message: { title: string; note: string; includeLink: boolean };
  conditions: { skipUnchanged: boolean; onlyWhenRefreshed: boolean };
  enabled: boolean;
  owner: string;
  scheduleText: string;
  nextRuns: NextRun[];
  lastRun: RunView | null;
  paused: { at: string; text: string; reason: string } | null;
  updatedAt: string;
}

// The message as the server composed it (src/analysis/subscriptionMessage.ts).
export interface MessageKpi {
  label: string;
  value: string;
  change?: string;
  tone?: 'good' | 'bad';
}
export interface MessageSection {
  title: string;
  caption?: string;
  columns: string[];
  rows: string[][];
  more: number;
  note?: string;
}
export interface MessageModel {
  title: string;
  subtitle: string[];
  note?: string;
  kpis: MessageKpi[];
  sections: MessageSection[];
  more: number;
  link?: { url: string; label: string };
  footer: string;
}
export interface PlatformPreview {
  model: MessageModel;
  bytes: number;
  size: string;
  blocks?: number;
  notes: string[];
}
export interface CardRef {
  id: string;
  type: 'metric' | 'visual';
  title: string;
  sheet: string;
  chartType?: string;
}
export interface Preview {
  scheduleText: string;
  nextRuns: NextRun[];
  cards: CardRef[];
  views: { id: string; name: string }[];
  /** Why no link can be sent, or null when one can. */
  linkNote: string | null;
  /** Why there is no message (the chosen cards are gone), or null. */
  empty: string | null;
  slack: PlatformPreview | null;
  teams: PlatformPreview | null;
}

/** A refusal's words or a thrown error's. */
export function reason(r: unknown, fallback: string): string {
  if (r instanceof Error) return r.message;
  const e = r && typeof r === 'object' ? (r as { error?: unknown }).error : undefined;
  return typeof e === 'string' && e ? e : fallback;
}

async function must<T>(p: Promise<unknown>, fallback: string): Promise<T> {
  const r = (await p) as { ok?: boolean };
  if (!r || r.ok !== true) throw new Error(reason(r, fallback));
  return r as T;
}

export const CHANNELS_KEY = ['channel:list'] as const;

/** The org's channels, for every member — to pick from, and for an admin to manage. */
export function useChannels(enabled = true) {
  return useQuery({ queryKey: CHANNELS_KEY, enabled, queryFn: () => must<ChannelFrame>(rpc('channel:list'), 'Channels could not be loaded.') });
}

export type SubscriptionList = ChannelFrame & { subscriptions: Subscription[] };

export function useSubscriptions(projectId: string) {
  return useQuery({
    queryKey: ['subscription:list', projectId],
    queryFn: () => must<SubscriptionList>(rpc('subscription:list', { projectId }), 'Subscriptions could not be loaded.'),
  });
}

/** A run finished or a subscription paused somewhere (`subscriptions:changed`, ids only): re-read the list. The pause's own notice is ./notices. */
export function useSubscriptionsLive(projectId: string) {
  const client = useQueryClient();
  useServerEvent('subscriptions:changed', (p) => {
    const pid = (p as { projectId?: string } | undefined)?.projectId;
    if (pid && pid !== projectId) return;
    void client.invalidateQueries({ queryKey: ['subscription:list', projectId] });
    void client.invalidateQueries({ queryKey: ['subscription:history', projectId] });
  });
}

export function useHistory(projectId: string, id: string | null) {
  return useQuery({
    queryKey: ['subscription:history', projectId, id],
    enabled: !!id,
    queryFn: () => must<{ runs: RunView[] }>(rpc('subscription:history', { projectId, id: id as string }), 'The runs could not be loaded.'),
  });
}

/** `value`, `ms` after it last changed — so typing a title does not ask the server per keystroke. */
export function useDebounced<T>(value: T, ms = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** The message a draft would send now, as the server composes it. The last answer stays up while the next one loads. */
export function usePreview(projectId: string, draft: Draft | null) {
  const settled = useDebounced(draft);
  return useQuery({
    queryKey: ['subscription:preview', projectId, settled],
    enabled: !!settled,
    placeholderData: keepPreviousData,
    queryFn: () => must<Preview>(rpc('subscription:preview', { projectId, draft: settled as Draft }), 'The preview could not be built.'),
  });
}

export function useSubscriptionWrites(projectId: string) {
  const client = useQueryClient();
  const done = () => {
    void client.invalidateQueries({ queryKey: ['subscription:list', projectId] });
    void client.invalidateQueries({ queryKey: ['subscription:history', projectId] });
  };
  return {
    save: useMutation({
      mutationFn: (v: { id?: string; subscription: Draft }) => must<{ subscription: Subscription }>(rpc('subscription:save', { projectId, ...v }), 'The subscription could not be saved.'),
      onSuccess: done,
    }),
    setEnabled: useMutation({
      mutationFn: (v: { id: string; enabled: boolean }) => must<{ subscription: Subscription }>(rpc('subscription:setEnabled', { projectId, ...v }), 'That did not work.'),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (id: string) => must(rpc('subscription:delete', { projectId, id }), 'Could not delete the subscription.'), onSuccess: done }),
    // A send that failed is an answer, not an exception: the reply says why, and the list shows it.
    sendNow: useMutation({
      mutationFn: async (id: string) => (await rpc('subscription:sendNow', { projectId, id })) as { ok: boolean; error?: string; run?: RunView },
      onSettled: done,
    }),
  };
}

export function useChannelWrites() {
  const client = useQueryClient();
  const done = () => {
    void client.invalidateQueries({ queryKey: CHANNELS_KEY });
    void client.invalidateQueries({ queryKey: ['subscription:list'] });
  };
  return {
    save: useMutation({
      mutationFn: (v: RpcInput<'channel:save'>) => must<{ channel: Channel }>(rpc('channel:save', v), 'The channel could not be saved.'),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (id: string) => must(rpc('channel:delete', { id }), 'Could not remove the channel.'), onSuccess: done }),
    test: useMutation({ mutationFn: (id: string) => must(rpc('channel:test', { id }), 'The test message could not be sent.') }),
  };
}

export interface ChannelUse {
  projectId: string;
  project: string;
  id: string;
  name: string;
}

/** What posts to a channel — asked when an admin is about to remove it. */
export function useChannelUsage(id: string | null) {
  return useQuery({
    queryKey: ['channel:usage', id],
    enabled: !!id,
    queryFn: () => must<{ subscriptions: ChannelUse[]; alerts: ChannelUse[] }>(rpc('channel:usage', { id: id as string }), 'Could not check what uses this channel.'),
  });
}

/** A new subscription's defaults for a dashboard, in the reader's own time zone. */
export function newDraft(analysisId: string, name: string): Draft {
  let timezone = 'UTC';
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    // an engine without Intl time zones: UTC
  }
  return {
    name,
    analysisId,
    content: { mode: 'all', cardIds: [] },
    viewId: null,
    schedule: { cadence: 'weekdays', at: '08:00' },
    timezone,
    channelIds: [],
    message: { title: '', note: '', includeLink: true },
    conditions: { skipUnchanged: false, onlyWhenRefreshed: false },
  };
}

/** A saved subscription as the draft the dialog edits. */
export function draftOf(s: Subscription): Draft {
  return {
    name: s.name, analysisId: s.analysisId, content: s.content, viewId: s.viewId, schedule: s.schedule, timezone: s.timezone,
    channelIds: s.channelIds, message: s.message, conditions: s.conditions, enabled: s.enabled,
  };
}
