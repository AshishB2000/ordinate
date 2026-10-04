// Home's server state: Recent, Starred, one project's overview, the
// Get-started card. Contracts carry inputs only, so each reply is narrowed by
// hand to the fields Home reads (mirrored from src/app/recent.ts,
// src/ipc/recent.ts and src/app/onboarding.ts) — and narrowed defensively: a
// reply in an unexpected shape reads as empty, never as a crash.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from './client';

export type RecentType = 'dataset' | 'analysis' | 'capture' | 'report';

export interface RecentItem {
  type: RecentType;
  id: string;
  projectId: string;
  projectName: string;
  name: string;
  updatedAt: string;
  meta?: { rowCount?: number; columnCount?: number; sheetCount?: number; qualityFailing?: number };
}

export interface HomeOverview {
  counts: { datasets: number; dashboards: number; captures: number; visuals: number };
  datasets: { id: string; name: string; rowCount: number; columnCount: number; qualityFailing?: number }[];
  visuals: { id: string; name: string; chartType: string }[];
  /** T2.11: "What stands out" — insights with a chart, each with its sparkline's figures (src/ipc/insights.ts standsOut). */
  standsOut: Array<{ id: string; spark: { labels: unknown[]; series: unknown[] } | null } & Record<string, unknown>>;
  /** Home's "Recent comments" (T2.9): the open threads, newest activity first. */
  comments: { open: number; recent: RecentComment[] };
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

export type StepId = 'import' | 'visual' | 'dashboard' | 'assistant';

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
        visuals: list(o.visuals),
        standsOut: list(o.standsOut),
        comments: { open: n(obj(o.comments).open), recent: list(obj(o.comments).recent) },
      };
    },
  });
}

const ONBOARDING = ['onboarding:status'] as const;

export function useOnboarding() {
  return useQuery({
    queryKey: ONBOARDING,
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

export function useSetOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { collapsed?: boolean; dismissed?: true }) => rpc('onboarding:set', patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ONBOARDING }),
  });
}
