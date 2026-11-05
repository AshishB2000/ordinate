// Topics in the Data model (semantic layer part 6, D14–D16; src/ipc/topics.ts): the list rides `model:navigation`
// (../navigation.ts); `topic:get` opens the drawer with the tag and the stale count; `topic:save` creates or updates.
// Contracts carry inputs only, so replies are narrowed here by hand.

import { skipToken, useQuery } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { okOr, type Fail } from '../../data/api';
import type { NavTopic } from '../navigation';

export type { NavTopic };

export const MAX_DATASETS = 12; // src/analysis/topics.ts MAX_TOPIC_DATASETS: the web does not import node-side files
export type TopicField = 'name' | 'datasets' | 'metricIds' | 'termIds';

export interface TopicGet {
  ok: true;
  /** As stored. */
  topic: NavTopic;
  tag: string;
  /** How many members have gone since (deleted, or a field a refresh dropped). */
  stale: number;
  /** The topic without them: what the drawer edits and saves. */
  kept: NavTopic;
}

export type SaveReply = { ok: true; topic: NavTopic; tag: string } | { ok: false; error: string; field?: TopicField };

export const useTopic = (projectId: string, id: string | undefined) =>
  useQuery({
    queryKey: ['topic:get', projectId, id],
    queryFn: id ? async () => okOr((await rpc('topic:get', { projectId, id })) as TopicGet | Fail, 'The topic') : skipToken,
    gcTime: 0, // each open reads afresh: the drawer's tag and what it shows come from one reply
  });

/** `items` in the order `ids` names them; an id with no item is skipped. */
export function inOrder<T extends { id: string }>(items: readonly T[], ids: readonly string[]): T[] {
  const by = new Map(items.map((i) => [i.id, i]));
  return ids.flatMap((id) => by.get(id) ?? []);
}
