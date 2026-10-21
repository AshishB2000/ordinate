// @mentions on the web (docs/notifications/00-design.md §5.9-5.12): the caller's
// "Mentioned you" list, its seen marks, and their email setting. Every figure-free
// word here is the server's; the browser never derives a person's name.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../api/client';
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
export interface MentionList {
  available: boolean;
  items: HomeMention[];
}
export interface MentionPrefs {
  available: boolean;
  mail: boolean;
  emailMe: boolean;
}

export const MENTIONS_KEY = ['mentions:list'] as const;

/** The caller's mentions, unseen first. `available` false: no user directory here, so no list. */
export function useMentions() {
  return useQuery({
    queryKey: MENTIONS_KEY,
    queryFn: async (): Promise<MentionList> => {
      const r = (await rpc('mentions:list')) as Partial<MentionList> & { ok?: boolean; error?: string };
      if (r && r.ok === false) throw new Error(r.error || 'Could not read your mentions.');
      return { available: r?.available === true, items: Array.isArray(r?.items) ? r.items : [] };
    },
  });
}

/** Mark one of the caller's mentions seen (or, with no argument, all of them); the list re-reads. */
export function useMentionSeen() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (one?: { projectId: string; id: string }) => rpc('mentions:seen', one ?? {}),
    onSettled: () => void client.invalidateQueries({ queryKey: MENTIONS_KEY }),
  });
}

export function useMentionPrefs() {
  return useQuery({
    queryKey: ['mentions:prefs'],
    queryFn: async (): Promise<MentionPrefs> => {
      const r = (await rpc('mentions:prefs')) as Partial<MentionPrefs> & { ok?: boolean; error?: string };
      if (r && r.ok === false) throw new Error(r.error || 'Could not read your notification settings.');
      return { available: r?.available === true, mail: r?.mail === true, emailMe: r?.emailMe !== false };
    },
  });
}

export function useSetMentionPrefs() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (emailMe: boolean) => {
      const r = (await rpc('mentions:setPrefs', { emailMe })) as { ok?: boolean; error?: string };
      if (!r || r.ok !== true) throw new Error(r?.error || 'Could not save that setting.');
      return emailMe;
    },
    onSuccess: (emailMe) => client.setQueryData<MentionPrefs>(['mentions:prefs'], (p) => (p ? { ...p, emailMe } : p)),
  });
}
