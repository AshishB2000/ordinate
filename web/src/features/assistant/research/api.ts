// Deep research's calls (src/api/research.ts; src/server/research/). A run is the starter's alone. Every count in a reply (steps used,
// queries used, seconds elapsed) is the server's; this module only shows it. A run moves on the server, so its query refetches on the
// `research:changed` push (ids and a state, never a figure) and, as a backstop, every few seconds while it is active.

import { skipToken, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { useServerEvent } from '../../../api/events';
import type { Turn } from '../api';

export type RunState = 'queued' | 'running' | 'writing' | 'done' | 'partial' | 'failed' | 'stopped';
export const ACTIVE: readonly RunState[] = ['queued', 'running', 'writing'];

export interface ResearchStep {
  n: number;
  kind: 'answer' | 'sql' | 'drivers' | 'none';
  title: string;
  status: 'done' | 'refused' | 'failed';
  reason?: string;
}
export interface ResearchReport {
  title: string;
  summary: string;
  sections: { heading: string; text: string; steps: number[] }[];
  caveats: string[];
  conclusion: string;
  chartsOnly?: boolean;
  writtenAt: string;
}
export interface Limits { steps: number; queries: number; minutes: number }
export interface ResearchRun {
  id: string;
  projectId: string;
  threadId: string;
  question: string;
  state: RunState;
  plan: string[];
  steps: ResearchStep[];
  report: ResearchReport | null;
  storyId: string | null;
  errorCode: string | null;
  stepsUsed: number;
  queriesUsed: number;
  limits: Limits;
  elapsedSec: number;
  resumable: boolean;
  startedAt: string;
  finishedAt: string | null;
}
type Failed = { ok: false; error?: string; notReady?: boolean };

export const isActive = (s: RunState): boolean => ACTIVE.includes(s);

/** Why a run ended the way it did, in a sentence (the server sends a code, never prose). */
export function endedText(run: Pick<ResearchRun, 'state' | 'errorCode'>): string {
  switch (run.state) {
    case 'done': return 'Finished.';
    case 'stopped': return 'Stopped. The steps already run are kept.';
    case 'partial':
      return { steps: 'Stopped at the step limit.', queries: 'Stopped at the query limit.', deadline: 'Stopped at the time limit.', write: 'The report could not be written, so it holds the charts only.' }[run.errorCode ?? ''] ?? 'Stopped early.';
    case 'failed':
      return (
        { model: 'The AI model did not answer.', limited: 'The AI request limit was reached. Try again in a minute.', access: 'You no longer have access to run research here.', no_steps: 'No step could be computed.', gave_up: 'The run kept being interrupted.' }[run.errorCode ?? ''] ??
        'The run failed.'
      );
    default: return '';
  }
}

export function useRun(projectId: string | undefined, runId: string | undefined) {
  const qc = useQueryClient();
  const key = ['research:get', projectId, runId];
  const q = useQuery({
    queryKey: key,
    queryFn: projectId && runId ? async () => {
      const r = (await rpc('research:get', { projectId, runId })) as { ok: true; run: ResearchRun } | Failed;
      if (!r.ok) throw new Error(r.error || 'This research run could not be found.');
      return r.run;
    } : skipToken,
    refetchInterval: (query) => (query.state.data && isActive(query.state.data.state) ? 4000 : false),
    retry: false,
  });
  useServerEvent('research:changed', (p) => {
    if ((p as { runId?: string } | null)?.runId === runId) void qc.invalidateQueries({ queryKey: key });
  });
  return q;
}

/** The caller's own runs in the project, with the one still going and the time limit (the composer's toggle). */
export function useResearchInfo(projectId: string | null | undefined, enabled = true) {
  const qc = useQueryClient();
  // Only a change of who is going (a run queued, ended, stopped, added) moves this: a step finishing does not.
  useServerEvent('research:changed', (p) => {
    if (!['running', 'writing'].includes((p as { state?: string } | null)?.state ?? '')) void qc.invalidateQueries({ queryKey: ['research:list', projectId] });
  });
  return useQuery({
    queryKey: ['research:list', projectId],
    enabled,
    queryFn: projectId ? async () => (await rpc('research:list', { projectId })) as { ok: true; activeRunId: string | null; limits: Limits | null } : skipToken,
    staleTime: 10_000,
  });
}

export async function startResearch(projectId: string, question: string, threadId: string | undefined, agentId: string | null): Promise<{ ok: true; runId: string; threadId: string; turns: Turn[] } | Failed> {
  return (await rpc('research:start', { projectId, question, ...(threadId ? { threadId } : {}), ...(agentId && !threadId ? { agentId } : {}) })) as never;
}

type RunAction = 'research:stop' | 'research:resume';
export function useRunAction(action: RunAction, projectId: string, runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await rpc(action, { projectId, runId })) as { ok: true } | Failed,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['research:get', projectId, runId] });
      void qc.invalidateQueries({ queryKey: ['research:list', projectId] });
    },
  });
}

export function useAddToProject(projectId: string, runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await rpc('research:addToProject', { projectId, runId })) as { ok: true; storyId: string; created: boolean } | Failed,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['research:get', projectId, runId] });
      void qc.invalidateQueries({ queryKey: ['story:list', projectId] });
    },
  });
}

/** One step's chart, drawn now by the server under the caller's access. */
export function useStepCard(projectId: string, runId: string, step: number, enabled: boolean) {
  return useQuery({
    queryKey: ['research:card', projectId, runId, step],
    enabled,
    queryFn: async () => (await rpc('research:card', { projectId, runId, step })) as Record<string, unknown>,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export interface AdminLimits { limits: Limits; ceilings: Limits }
export function useResearchLimits() {
  return useQuery({
    queryKey: ['research:limits'],
    queryFn: async () => {
      const r = (await rpc('research:limits')) as ({ ok: true } & AdminLimits) | Failed;
      if (!r.ok) throw new Error(r.error || 'The limits could not be loaded.');
      return r;
    },
  });
}
export function useSetResearchLimits(onDone: (r: ({ ok: true } & AdminLimits) | Failed) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (l: Limits) => (await rpc('research:setLimits', l)) as ({ ok: true } & AdminLimits) | Failed,
    onSuccess: (r) => {
      if (r.ok) void qc.setQueryData(['research:limits'], r);
      void qc.invalidateQueries({ queryKey: ['research:list'] });
      onDone(r);
    },
  });
}
