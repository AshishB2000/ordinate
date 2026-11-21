// Evaluation suites' calls (src/api/evals.ts; src/server/evals/). Every count, outcome and check in a reply is the server's; this module
// only shows it. A run moves on the server, so its query refetches on the `evals:changed` push (ids and a state, never a word of an
// answer) and, as a backstop, every few seconds while it is active. The answer's words and the judge's line arrive only for the person
// who ran it, and the page shows them only when they are there.

import { skipToken, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { useServerEvent } from '../../api/events';

export type Outcome = 'pass' | 'fail' | 'not_scored' | 'error';
export type RunState = 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'stopped';
export const isActive = (s: RunState): boolean => s === 'queued' || s === 'running';
export type Failed = { ok: false; error?: string; notReady?: boolean };

export interface Last { runId: string; state: RunState; startedAt: string; casesDone: number; casesTotal: number; passed: number; failed: number; notScored: number }
export interface SuiteRow {
  id: string; name: string; agentId: string | null; caseCount: number; createdAt: string;
  /** Warehouse queries the Live cases can make in one run: a number the server worked out. */
  liveQueries: number;
  last: Last | null;
  /** What changed since the last run: instructions, documents, model, topic. */
  stale: string[];
  runningId: string | null;
}
export interface SuitesReply { ok: true; available: boolean; suites: SuiteRow[]; activeRunId: string | null }

export interface CaseRow {
  id: string; position: number; question: string; source: 'verified' | 'answer' | 'inbox' | 'typed'; say: string | null; refuse: boolean;
  compute: { spec: Record<string, unknown>; datasetName: string } | null;
}
export interface CasesReply { ok: true; suite: { id: string; name: string; agentId: string | null }; max: number; cases: CaseRow[] }

export interface Check { id: 'answered' | 'question' | 'figure' | 'audit'; ok: boolean; code?: string }
export interface CaseLine {
  caseId: string; position: number; question: string; outcome: Outcome | 'pending'; score: number | null; judged: 'none' | 'scored' | 'not_scored';
  checks: Check[]; errorCode: string | null; calls: number; move: 'better' | 'worse' | 'same' | 'new' | null; reply?: string; why?: string;
}
export interface RunReply {
  ok: true;
  suite: { id: string; name: string } | null;
  run: {
    id: string; projectId: string; suiteId: string; agentId: string | null; state: RunState; errorCode: string | null; mine: boolean; resumable: boolean;
    casesTotal: number; casesDone: number; passed: number; failed: number; notScored: number; modelCalls: number;
    judge: string | null; judgeOwn: boolean; version: Record<string, string>; startedAt: string; finishedAt: string | null; elapsedSec: number;
  };
  cases: CaseLine[];
  compare: { runId: string; better: number; worse: number; same: number; new: number; changed: string[]; judgeDiffers: boolean } | null;
}
export interface InboxItem { turnId: string; question: string; agentId: string | null; agentName: string | null; reason: string | null; createdAt: string }

export const suitesKey = (projectId: string | null | undefined) => ['eval:suites', projectId];

export function useSuites(projectId: string | null | undefined, enabled = true) {
  const qc = useQueryClient();
  useServerEvent('evals:changed', () => void qc.invalidateQueries({ queryKey: suitesKey(projectId) }));
  return useQuery({
    queryKey: suitesKey(projectId),
    enabled,
    queryFn: projectId ? async () => (await rpc('eval:suites', { projectId })) as SuitesReply : skipToken,
    refetchInterval: (q) => (q.state.data?.suites.some((s) => s.runningId) ? 4000 : false),
    refetchOnWindowFocus: true,
  });
}

export function useCases(projectId: string, suiteId: string | null) {
  return useQuery({
    queryKey: ['eval:cases', projectId, suiteId],
    queryFn: suiteId ? async () => {
      const r = (await rpc('eval:cases', { projectId, suiteId })) as CasesReply | Failed;
      if (!r.ok) throw new Error(r.error || 'The test cases could not be loaded.');
      return r;
    } : skipToken,
  });
}

export function useRun(projectId: string | undefined, runId: string | undefined) {
  const qc = useQueryClient();
  const key = ['eval:runGet', projectId, runId];
  useServerEvent('evals:changed', (p) => {
    if ((p as { runId?: string } | null)?.runId === runId) void qc.invalidateQueries({ queryKey: key });
  });
  return useQuery({
    queryKey: key,
    queryFn: projectId && runId ? async () => {
      const r = (await rpc('eval:runGet', { projectId, runId })) as RunReply | Failed;
      if (!r.ok) throw new Error(r.error || 'This run could not be found.');
      return r;
    } : skipToken,
    refetchInterval: (q) => (q.state.data && isActive(q.state.data.run.state) ? 4000 : false),
    retry: false,
  });
}

export function useInbox(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['feedback:inbox', projectId],
    enabled,
    queryFn: async () => (await rpc('feedback:inbox', { projectId })) as { ok: true; items: InboxItem[]; available?: boolean },
  });
}

/** One eval call, and the lists it makes stale. A refusal is the reply `{ ok: false, error }`, never a throw. */
export function useEvalCall(projectId: string) {
  const qc = useQueryClient();
  return async <T extends { ok: true } = { ok: true }>(channel: string, payload: Record<string, unknown>): Promise<T | Failed> => {
    try {
      const r = (await rpc(channel as never, { projectId, ...payload } as never)) as T | Failed;
      for (const key of ['eval:suites', 'eval:cases', 'eval:runGet', 'eval:runList', 'feedback:inbox']) void qc.invalidateQueries({ queryKey: [key, projectId] });
      void qc.invalidateQueries({ queryKey: ['eval:runGet'] });
      return r;
    } catch (e) {
      return { ok: false, error: e instanceof Error && e.message ? e.message : 'That did not work.' };
    }
  };
}

// What a check or a failed case says, in words. The server sends codes: no model words and no figure ever arrive as a sentence.
export const CHECK_LABEL: Record<Check['id'], string> = { answered: 'Answered as expected', question: 'Same question', figure: 'Same figure', audit: 'No invented figure' };
export const CODE_TEXT: Record<string, string> = {
  no_answer: 'It computed no answer.',
  sql: 'It answered with SQL, which cannot be compared to a chart.',
  answered: 'It answered where a refusal was expected.',
  prose: 'It replied in words only: the app did not refuse.',
  different: 'It is not what was expected.',
  expected_failed: 'The expected answer could not be computed now.',
  answer_failed: 'The answer could not be computed now.',
  invented: 'The reply holds a figure the engine did not compute.',
};
export const ERROR_TEXT: Record<string, string> = {
  timeout: 'The question took too long to answer.', failed: 'The question could not be asked.', gone: 'The case was deleted after the run started.',
};
export const PART_TEXT: Record<string, string> = { instructions: 'Instructions changed', documents: 'Documents changed', model: 'Model changed', topic: 'Topic changed' };
export const END_TEXT: Record<string, string> = {
  limited: 'Stopped: the AI request limit was reached. Resume it in a minute.', deadline: 'Stopped at the time limit.', model: 'The AI model is not set up, or did not answer.',
  access: 'You no longer have access to run these tests.', gave_up: 'The run kept being interrupted.', error: 'The run failed.',
};
