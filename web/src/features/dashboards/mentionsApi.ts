// @mentions on the web (docs/notifications/00-design.md §5.9-5.12): the caller's
// "Mentioned you" list, viewers' asks and dashboard requests (in the bell), their seen marks, and their email settings. Every figure-free
// word here is the server's; the browser never derives a person's name.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { ME_KEY } from '../auth/api';
import type { ThreadKind } from '../../../../src/app/threadPath.ts';

export interface HomeMention {
  projectId: string;
  id: string;
  commentId: string;
  target: { kind: ThreadKind; id: string };
  on: { name: string; analysisId?: string };
  by: string;
  snippet: string;
  at: string;
  seen: boolean;
}
/** A viewer's "Ask an editor" of a project the caller edits (src/server/mentions/asks.ts): their words, the reason, a name. */
export interface AskRow {
  projectId: string;
  id: string;
  by: string;
  question: string;
  reason: 'missing' | 'link' | 'copy';
  /** The reason as the server words it. */
  why: string;
  note: string;
  at: string;
  seen: boolean;
}
/** A dashboard request (src/server/requests/requests.ts `RequestRow`): the caller's own once decided, or one they may approve. */
export interface RequestRow {
  projectId: string;
  id: string;
  /** Who asked for it. */
  by: string;
  title: string;
  note: string;
  charts: number;
  state: 'open' | 'drafted' | 'approved' | 'declined';
  /** Who decided it ('' while open). */
  decidedBy: string;
  /** A decline's note. */
  answer: string;
  dashboardId: string | null;
  at: string;
  /** The caller asked for it; else they were asked to approve it. */
  mine: boolean;
  seen: boolean;
}
export interface MentionList {
  available: boolean;
  items: HomeMention[];
  asks: AskRow[];
  requests: RequestRow[];
  /** The caller's unseen mentions and asks in the database (some may not be among `items` and `asks`). */
  unseen: number;
}
export interface MentionPrefs {
  available: boolean;
  mail: boolean;
  emailMe: boolean;
  /** "Email me about data asks and dashboard requests": off unless they turned it on. */
  requestEmail: boolean;
}

export const MENTIONS_KEY = ['mentions:list'] as const;

/** The caller's mentions, unseen first. `available` false: no user directory here, so no list. */
export function useMentions(enabled = true) {
  return useQuery({
    queryKey: MENTIONS_KEY,
    enabled,
    queryFn: async (): Promise<MentionList> => {
      const r = (await rpc('mentions:list')) as Partial<MentionList> & { ok?: boolean; error?: string };
      if (r && r.ok === false) throw new Error(r.error || 'Could not read your mentions.');
      const items = Array.isArray(r?.items) ? r.items : [];
      const asks = Array.isArray(r?.asks) ? r.asks : [];
      const requests = Array.isArray(r?.requests) ? r.requests : [];
      return { available: r?.available === true, items, asks, requests, unseen: typeof r?.unseen === 'number' ? r.unseen : [...items, ...asks, ...requests].filter((m) => !m.seen).length };
    },
  });
}

/** Mark one of the caller's mentions seen, or all of them up to `through` (the newest one shown); the list and the bell's count re-read. */
export function useMentionSeen() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (which: { projectId: string; id: string } | { through: string }) => rpc('mentions:seen', which),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: MENTIONS_KEY });
      void client.invalidateQueries({ queryKey: ME_KEY });
    },
  });
}

export function useMentionPrefs() {
  return useQuery({
    queryKey: ['mentions:prefs'],
    queryFn: async (): Promise<MentionPrefs> => {
      const r = (await rpc('mentions:prefs')) as Partial<MentionPrefs> & { ok?: boolean; error?: string };
      if (r && r.ok === false) throw new Error(r.error || 'Could not read your notification settings.');
      return { available: r?.available === true, mail: r?.mail === true, emailMe: r?.emailMe !== false, requestEmail: r?.requestEmail === true };
    },
  });
}

/** One switch per call: `{ emailMe }` or `{ requestEmail }`. */
export function useSetMentionPrefs() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (which: { emailMe: boolean } | { requestEmail: boolean }) => {
      const r = (await rpc('mentions:setPrefs', which)) as { ok?: boolean; error?: string };
      if (!r || r.ok !== true) throw new Error(r?.error || 'Could not save that setting.');
      return which;
    },
    onSuccess: (which) => client.setQueryData<MentionPrefs>(['mentions:prefs'], (p) => (p ? { ...p, ...which } : p)),
  });
}
