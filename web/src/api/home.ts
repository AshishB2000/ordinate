// Home's server state: Recent, Starred, one project's overview, the
// Get-started card. Contracts carry inputs only, so each reply is narrowed by
// hand to the fields Home reads (mirrored from src/app/recent.ts,
// src/ipc/recent.ts and src/app/onboarding.ts) — and narrowed defensively: a
// reply in an unexpected shape reads as empty, never as a crash.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from './client';
import type { AutoRefreshEvery } from './datasets';

export type RecentType = 'dataset' | 'analysis' | 'capture' | 'report' | 'visual';

export interface RecentItem {
  type: RecentType;
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  updatedAt: string;
  meta?: { rowCount?: number; columnCount?: number; sheetCount?: number; qualityFailing?: number; chartType?: string; previewIds?: string[] };
}

export interface HomeOverview {
  counts: { datasets: number; dashboards: number; captures: number; visuals: number };
  datasets: OverviewDataset[];
  /** T2.11: "What stands out" — insights with a chart, each with its sparkline's figures (src/ipc/insights.ts standsOut). */
  standsOut: Array<{ id: string; spark: { labels: unknown[]; series: unknown[] } | null } & Record<string, unknown>>;
  /** Home's "Recent comments" (T2.9): the open threads, newest activity first. */
  comments: { open: number; recent: RecentComment[] };
}

/** One dataset in `home:overview`: its size, and its refresh state as the dataset list has it (src/ipc/recent.ts). */
export interface OverviewDataset {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  qualityFailing?: number;
  sourceKind?: string;
  mode?: 'live';
  /** Its refresh schedule; absent = none. */
  every?: AutoRefreshEvery;
  lastRefreshedAt?: string;
  lastRefreshStatus?: 'ok' | 'error';
  /** Why the last refresh failed, already redacted by the server. */
  lastRefreshError?: string;
  behindSchedule?: true;
}

export interface RecentComment {
  id: string;
  author: string;
  snippet: string;
  at: string;
  replies: number;
  target: { kind: 'analysis' | 'card' | 'visual' | 'dataset' | 'story'; id: string };
  on: { name: string; analysisId?: string } | null;
}

export type StepId = 'assistant' | 'explore' | 'dashboards' | 'reports' | 'data';

export interface Onboarding {
  show: boolean;
  collapsed: boolean;
  steps: { id: StepId; done: boolean }[];
  doneCount: number;
  total: number;
}

const list = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export function useRecent() {
  return useQuery({
    queryKey: ['recent:list'],
    queryFn: async () => list<RecentItem>(await rpc('recent:list')),
  });
}

const STARRED = ['starred:get'] as const;

export function useStarred() {
  return useQuery({
    queryKey: STARRED,
    queryFn: async () => list<string>(await rpc('starred:get')).filter((k) => typeof k === 'string'),
  });
}

/** Replaces the caller's pins; the list shows the change at once and rolls back on failure. */
export function useSetStarred() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ids: string[]) => rpc('starred:set', { ids }),
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: STARRED });
      const prev = qc.getQueryData<string[]>(STARRED);
      qc.setQueryData(STARRED, ids);
      return { prev };
    },
    onError: (_err, _ids, c) => qc.setQueryData(STARRED, c?.prev),
  });
}

export function useOverview(projectId: string | undefined) {
  return useQuery({
    queryKey: ['home:overview', projectId],
    enabled: !!projectId,
    queryFn: async (): Promise<HomeOverview> => {
      const o = obj(await rpc('home:overview', { projectId: projectId! }));
      const c = obj(o.counts);
      const n = (v: unknown) => (typeof v === 'number' ? v : 0);
      return {
        counts: { datasets: n(c.datasets), dashboards: n(c.dashboards), captures: n(c.captures), visuals: n(c.visuals) },
        datasets: list(o.datasets),
        standsOut: list(o.standsOut),
        comments: { open: n(obj(o.comments).open), recent: list(obj(o.comments).recent) },
      };
    },
  });
}

const ONBOARDING = ['onboarding:status'] as const;

/** The caller's own Get-started tour. `enabled: false` asks nothing and reads what Home already fetched. */
export function useOnboarding(enabled = true) {
  return useQuery({
    queryKey: ONBOARDING,
    enabled,
    queryFn: async (): Promise<Onboarding> => {
      const o = obj(await rpc('onboarding:status'));
      return {
        show: o.show === true,
        collapsed: o.collapsed === true,
        steps: list(o.steps),
        doneCount: typeof o.doneCount === 'number' ? o.doneCount : 0,
        total: typeof o.total === 'number' ? o.total : 0,
      };
    },
  });
}

/** The caller opened a tour stop's page (or the Assistant): the server ticks it for them. */
export function useVisitTour() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (step: StepId) => rpc('onboarding:visit', { step }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ONBOARDING }),
  });
}

export function useSetOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { collapsed?: boolean; dismissed?: true }) => rpc('onboarding:set', patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ONBOARDING }),
  });
}

// ── Home's "Your numbers" (src/ipc/numbers.ts): every figure, label and change in a tile is the server's. ──

export interface MetricTile {
  kind: 'metric';
  id: string;
  name: string;
  dataset: string | null;
  display: string;
  period: string | null;
  change: { text: string; up: boolean; tone: 'good' | 'bad' | 'flat' | 'neutral'; vs: string } | null;
  spark: Array<number | null> | null;
  error?: string;
}
export interface GoalsTile { kind: 'scorecard'; id: string; name: string; period: string; off: number; warn: number; good: number; scored: number; error?: string }
export type NumberTile = MetricTile | GoalsTile;
export interface NumberChoice { kind: 'metric' | 'scorecard'; id: string; name: string; followed: boolean }
export interface Numbers { tiles: NumberTile[]; suggestions: MetricTile[]; choices: NumberChoice[] }

const numbersKey = (projectId: string | undefined) => ['numbers:get', projectId] as const;

export function useNumbers(projectId: string | undefined) {
  return useQuery({
    queryKey: numbersKey(projectId),
    enabled: !!projectId,
    queryFn: async (): Promise<Numbers> => {
      const o = obj(await rpc('numbers:get', { projectId: projectId! }));
      if (o.ok === false) throw new Error(typeof o.error === 'string' ? o.error : 'Your numbers could not be loaded.');
      return { tiles: list(o.tiles), suggestions: list(o.suggestions), choices: list(o.choices) };
    },
  });
}

/** Follow or unfollow one, for the caller; the tiles are read again. A refusal (the limit) throws its reason. */
export function useFollowNumber(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { kind: 'metric' | 'scorecard'; id: string; on: boolean }) => {
      const r = obj(await rpc('numbers:follow', { projectId: projectId!, ...v }));
      if (r.ok === false) throw new Error(typeof r.error === 'string' ? r.error : 'That could not be saved. Try again.');
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: numbersKey(projectId) }),
  });
}
