// The data issues board's calls (src/api/issues.ts; src/server/issues/). A reply carries counts, the title and fix, and example question
// words with a reason: never an answer, a figure or who asked. Every figure shown is the server's count.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';

export type Status = 'open' | 'resolved' | 'ignored';
export type Kind = 'needs_link' | 'needs_copy' | 'undefined_name' | 'refused' | 'outside' | 'untraced' | 'thumbs_down' | 'asked_again';
export type Provider = 'linear' | 'jira';
export type Failed = { ok: false; error?: string };

export interface Issue {
  id: string; title: string; fix: string; kind: Kind; status: Status; reopened: number; questions: number; people: number;
  kinds: Array<{ kind: Kind; count: number }>;
  examples: Array<{ kind: Kind; reason: string | null; question: string; at: string }>;
  tickets: Array<{ provider: Provider; ref: string; url: string }>;
  proposalId: string | null; updatedAt: string;
}
export interface Board { ok: true; available: boolean; issues: Issue[]; trackers: Record<Provider, boolean> }
export interface Settings { ok: true; available: boolean; enabled: boolean; lastRunAt: string | null; lastError: string | null; trackers: Record<Provider, boolean> }

/** What each kind of trouble is called on the board. */
export const KIND_LABEL: Record<Kind, string> = {
  needs_link: 'Needs a link', needs_copy: 'Needs a copy', undefined_name: 'Not defined', refused: 'Not found', outside: 'Wrong assistant',
  untraced: 'Untraced figure', thumbs_down: 'Thumbs down', asked_again: 'Asked again',
};
export const REASON_LABEL: Record<string, string> = { wrong_number: 'Wrong number', wrong_data: 'Wrong data', didnt_answer: 'Didn’t answer', other: 'Something else' };
export const PROVIDER_LABEL: Record<Provider, string> = { linear: 'Linear', jira: 'Jira' };

const boardKey = (projectId: string) => ['issues:list', projectId] as const;
const settingsKey = (projectId: string) => ['issues:settings', projectId] as const;

export function useBoard(projectId: string) {
  return useQuery({ queryKey: boardKey(projectId), queryFn: async () => (await rpc('issues:list', { projectId })) as Board | Failed });
}
export function useSettings(projectId: string) {
  return useQuery({ queryKey: settingsKey(projectId), queryFn: async () => (await rpc('issues:settings', { projectId })) as Settings | Failed });
}

/** One board call, and the lists it makes stale. A refusal is the reply `{ ok: false, error }`. */
export function useIssueCall(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (p: { channel: 'issues:setStatus' | 'issues:propose' | 'issues:send' | 'issues:setEnabled' | 'issues:checkNow'; input: Record<string, unknown> }) =>
      (await rpc(p.channel as never, { projectId, ...p.input } as never)) as { ok: true; [k: string]: unknown } | Failed,
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: boardKey(projectId) }), qc.invalidateQueries({ queryKey: settingsKey(projectId) }), qc.invalidateQueries({ queryKey: ['proposal:list', projectId] })]),
  });
}
