// A topic named by an automation caller (semantic part 6, step 08) — MAIN PROCESS. A topic orders and narrows LISTS
// only (D15): query_sql, aggregate and metric_value read every dataset whatever it says. Gone members are left out
// (`topicForReaders`), so a list never names what no longer exists.

import { listTopics, topicForReaders, type Topic } from '../analysis/topics';
import { AutomationError } from './errors';

/** The topic `ref` names: its id, or its name ignoring case; else a `usage` error. Its gone members are dropped. */
export async function resolveTopicRef(projectId: string, ref: string): Promise<Topic> {
  const r = ref.trim();
  const all = await listTopics(projectId);
  const t = all.find((x) => x.id === r) ?? all.find((x) => x.name.toLowerCase() === r.toLowerCase());
  if (!t) throw new AutomationError('usage', `No topic called "${ref}".`);
  return (await topicForReaders(projectId, t)).topic;
}

/** `items` that the topic lists, in the topic's order. */
export function inTopicOrder<T extends { id: string }>(items: readonly T[], ids: readonly string[]): T[] {
  return ids.flatMap((id) => items.filter((x) => x.id === id));
}
