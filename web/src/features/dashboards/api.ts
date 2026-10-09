// Dashboards, sharing, alerts, comments (T2.9) — the server calls. Types mirror
// the handlers' replies (src/ipc/publishServer.ts, comments.ts, alerts.ts,
// summary.ts, fx.ts, dashboardsServer.ts), narrowed by hand as in
// web/src/api/projects.ts — contracts carry inputs only.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc, type RpcInput } from '../../api/client';
import { useServerEvent } from '../../api/events';
import type { AsOf } from '../../ui/asOf';

// ── Publish to a URL ─────────────────────────────────────────────────────

export type Access = 'org' | 'link';
export interface HostedSite {
  id: string;
  projectId: string;
  title: string;
  access: Access;
  publishedBy: string;
  publishedAt: string;
  bytes: number;
  combos: number;
  pages: { file: string; kind: 'dashboard' | 'story' | 'scorecard'; name: string }[];
  config: { dashboardIds: string[]; storyIds: string[]; scorecardIds: string[]; options: { title?: string; maxCombos?: number; afterRefresh?: boolean } };
}
export interface Targets {
  ok: boolean;
  dashboards: { id: string; name: string; sheets: number; style?: { theme: string; accent: string; accentHex?: string } }[];
  stories: { id: string; name: string }[];
  scorecards: { id: string; name: string }[];
}
export interface PlanPage {
  kind: 'dashboard' | 'story' | 'scorecard';
  id: string;
  name: string;
  combos: number;
  mode: 'all' | 'single';
  bytes: number;
  dropped: { control: string; options: string[] }[];
}
export interface Plan {
  pages: PlanPage[];
  combos: number;
  bytes: number;
  maxBytes: number;
  tooBig: boolean;
  summary: string;
  suggestions: string[];
}
export type PublishInput = RpcInput<'publish:run'>;

/** The URL a site is opened at — served by the server itself, never this app's router. */
export const siteUrl = (id: string): string => `${window.location.origin}/p/${id}/`;

export function useSites(projectId: string | null) {
  return useQuery({
    queryKey: ['publish:sites', projectId],
    enabled: !!projectId,
    queryFn: async () => (await rpc('publish:sites', { projectId: projectId as string })) as { ok: true; sites: HostedSite[]; publicLinks: boolean },
  });
}

export function useTargets(projectId: string, enabled: boolean) {
  return useQuery({ queryKey: ['publish:targets', projectId], enabled, queryFn: async () => (await rpc('publish:targets', { projectId })) as Targets });
}

/** A refusal's words or a thrown error's. */
export function reason(r: unknown, fallback: string): string {
  if (r instanceof Error) return r.message;
  const e = r && typeof r === 'object' ? (r as { error?: unknown }).error : undefined;
  return typeof e === 'string' && e ? e : fallback;
}

type Reply<T> = { ok: true } & T;
/** One call of any of `C`, typed per channel. */
type WriteOf<C extends Parameters<typeof rpc>[0]> = { [K in C]: { channel: K; input: RpcInput<K> } }[C];
async function must<T>(p: Promise<unknown>, fallback: string): Promise<Reply<T>> {
  const r = (await p) as { ok?: boolean };
  if (!r || r.ok !== true) throw new Error(reason(r, fallback));
  return r as Reply<T>;
}

export function usePublishActions(projectId: string) {
  const client = useQueryClient();
  const done = () => void client.invalidateQueries({ queryKey: ['publish:sites', projectId] });
  return {
    run: useMutation({ mutationFn: (input: PublishInput) => must<{ site: HostedSite }>(rpc('publish:run', input), 'Publishing failed.'), onSuccess: done }),
    access: useMutation({
      mutationFn: (v: { id: string; access: Access }) => must<{ site: HostedSite }>(rpc('publish:access', { projectId, ...v }), 'Could not change who can open it.'),
      onSuccess: done,
    }),
    unpublish: useMutation({ mutationFn: (id: string) => must(rpc('publish:unpublish', { projectId, id }), 'Could not unpublish.'), onSuccess: done }),
  };
}

// ── Comments ─────────────────────────────────────────────────────────────

export type TargetKind = 'analysis' | 'card' | 'visual' | 'dataset' | 'story';
export interface CommentReply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  deletedAt?: string;
  mine: boolean;
}
export interface Comment {
  id: string;
  target: { kind: TargetKind; id: string; point?: { label?: string; series?: string } };
  author: string;
  body: string;
  createdAt: string;
  updatedAt?: string;
  /** Present → resolved. */
  resolvedAt?: string;
  /** Tombstone: deleted. */
  deletedAt?: string;
  mine: boolean;
  replies: CommentReply[];
}
export interface CommentList {
  ok: true;
  comments: Comment[];
  targets: Record<string, { name: string; analysisId?: string }>;
}

/**
 * Another member's comment (`comments:changed`) re-reads the list. ONE listener
 * per open dashboard (DashboardChrome) — every card's door reads the same cached
 * list, and a listener per door would re-read it once per card.
 */
export function useCommentsLive(projectId: string) {
  const client = useQueryClient();
  useServerEvent('comments:changed', (p) => {
    const pid = (p as { projectId?: string } | undefined)?.projectId;
    if (!pid || pid === projectId) void client.invalidateQueries({ queryKey: ['comment:list', projectId] });
  });
}

/** The project's comments (one cached list for every door). */
export function useComments(projectId: string) {
  return useQuery({ queryKey: ['comment:list', projectId], queryFn: async () => must<Omit<CommentList, 'ok'>>(rpc('comment:list', { projectId }), 'Could not read the comments.') });
}

type CommentChannel = 'comment:add' | 'comment:reply' | 'comment:edit' | 'comment:resolve' | 'comment:reopen' | 'comment:delete' | 'comment:deleteReply';

/** One comment write; the reply IS the new list, so the cache takes it as is. */
export function useCommentWrite(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (v: WriteOf<CommentChannel>) =>
      must<Omit<CommentList, 'ok'>>((rpc as (c: string, i: unknown) => Promise<unknown>)(v.channel, v.input), 'Could not save the comment.'),
    onSuccess: (list) => client.setQueryData(['comment:list', projectId], list),
  });
}

/** Threads not deleted, on one target. */
export const threadsOn = (list: Comment[] | undefined, kind: TargetKind, id: string): Comment[] =>
  (list ?? []).filter((c) => !c.deletedAt && c.target.kind === kind && c.target.id === id);

// ── Alerts ───────────────────────────────────────────────────────────────

export interface AlertRule {
  id: string;
  name: string;
  datasetId: string;
  metric: { column: string; aggregation: string; filters?: unknown[]; label?: string; metricId?: string };
  compare: 'threshold' | 'change' | 'anomaly';
  enabled: boolean;
  threshold?: { op: '<' | '<=' | '>' | '>='; value: number };
  change?: { pct: number; direction: 'up' | 'down' | 'either'; vs: 'previous_refresh' | 'previous_period'; periodColumn?: string };
  createdFrom?: { analysisId: string; cardId: string };
  quietHours?: { from: number; to: number };
  snoozedUntil?: string;
  lastValue?: number;
  lastFiredAt?: string;
  history?: number[];
  fromWatch?: boolean;
}
export interface AlertEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  datasetId: string;
  message: string;
  at: string;
  value: number | null;
  seen: boolean;
  analysisId?: string;
}
export interface AlertList {
  ok: true;
  rules: AlertRule[];
  events: AlertEvent[];
  digest: boolean;
  unseen: number;
}

/** A fired alert (`alerts:fired`) re-reads the list — ONE listener, the top bar's bell. */
export function useAlertsLive(projectId: string | null, onFire?: () => void) {
  const client = useQueryClient();
  useServerEvent('alerts:fired', (p) => {
    const pid = (p as { projectId?: string } | undefined)?.projectId;
    if (pid && pid !== projectId) return;
    onFire?.();
    void client.invalidateQueries({ queryKey: ['alerts:list', projectId] });
  });
}

/** The project's rules and what fired (one cached list for the bell, the cards and the dialog). */
export function useAlerts(projectId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['alerts:list', projectId],
    enabled: !!projectId && enabled,
    queryFn: async () => must<Omit<AlertList, 'ok'>>(rpc('alerts:list', { projectId: projectId as string }), 'Could not read alerts.'),
  });
}

type AlertChannel = 'alerts:save' | 'alerts:patch' | 'alerts:delete' | 'alerts:markSeen' | 'alerts:setDigest';
export function useAlertWrite(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (v: WriteOf<AlertChannel>) =>
      must<Record<string, unknown>>((rpc as (c: string, i: unknown) => Promise<unknown>)(v.channel, v.input), 'That rule is not complete.'),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['alerts:list', projectId] }),
  });
}

// ── The viewer's scope: As of, the dashboard's currency ──────────────────

export interface FxView {
  ok: true;
  settings: { target: string; columns: Record<string, Record<string, unknown>>; dashboards: Record<string, string> };
  target: string;
  workspaceCurrency: string;
  codes: string[];
}
export function useFx(projectId: string) {
  return useQuery({ queryKey: ['fx:get', projectId], queryFn: async () => must<Omit<FxView, 'ok'>>(rpc('fx:get', { projectId }), 'Could not read currencies.') });
}
export function useSetDashboardCurrency(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (v: { dashboardId: string; code: string | null }) => must<Omit<FxView, 'ok'>>(rpc('fx:dashboard', { projectId, ...v }), 'Could not set the currency.'),
    onSuccess: (fx) => client.setQueryData(['fx:get', projectId], fx),
  });
}

/** The As of picker's snapshot times, and `latest`: how fresh the sheet is at "Latest" (its stalest dataset, L0.2). */
export function useAsOfStamps(projectId: string, datasetIds: string[], metricIds: string[]) {
  return useQuery({
    queryKey: ['dashboard:asOfStamps', projectId, datasetIds, metricIds],
    enabled: datasetIds.length + metricIds.length > 0,
    queryFn: async () => must<{ items: { at: string; datasets: string[] }[]; latest?: AsOf }>(rpc('dashboard:asOfStamps', { projectId, datasetIds, metricIds }), 'Could not list snapshot times.'),
  });
}

// ── The Summary card ─────────────────────────────────────────────────────

export interface SummarySentence {
  kind: 'kpi' | 'driver' | 'insight' | 'quality' | 'alert';
  text: string;
  tone: 'good' | 'bad' | 'neutral';
  cardId?: string;
}
export type SummaryReq = RpcInput<'summary:compute'>;
export function useSummary(req: SummaryReq) {
  return useQuery({
    queryKey: ['summary:compute', req],
    queryFn: async () => must<{ sentences: SummarySentence[]; computedAt: string; canRewrite: boolean; rewriteReason?: string }>(rpc('summary:compute', req), 'Could not summarise this dashboard.'),
    placeholderData: (prev) => prev,
  });
}
