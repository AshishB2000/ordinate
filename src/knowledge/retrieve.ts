// Knowledge passages for an ask, and the document titles a turn shows (docs/knowledge-docs/00-design.md rules 7 and 8).
// MAIN PROCESS. Never throws into an ask: the caller (src/ipc/guidance.ts) logs a failure and goes on without passages.

import type { TurnGuidance } from '../ai/turnGuidance';
import { rankPassages, type Ranked } from './rank';
import { candidates, knowledgeOn, titlesOf } from './store';

/** The passages that answer `question` from the project's documents and the answering agent's; none without a database. */
export async function passagesFor(projectId: string, agentId: string | null, question: string): Promise<Ranked[]> {
  if (!knowledgeOn() || !question.trim()) return [];
  return rankPassages(question, await candidates(projectId, agentId, question));
}

/**
 * `turns` for the browser: each turn's guidance names its documents by title (`documentRefs`), a document deleted since
 * then as gone, as `agentRef` does an agent. One lookup for all of them. Never throws: a failed lookup shows them as gone.
 */
export async function withDocumentTitles<T extends { guidance?: TurnGuidance }>(projectId: string, turns: readonly T[]): Promise<T[]> {
  const ids = [...new Set(turns.flatMap((t) => t.guidance?.documents ?? []))];
  if (!ids.length) return [...turns];
  const found = await titlesOf(projectId, ids).catch(() => new Map<string, { title: string; agentId: string | null }>());
  // An agent's document is named only to someone who may still use that agent (rule 3): a person taken off its team sees
  // "a removed document", never a title that has since been renamed. One check per agent.
  const { agentForAsk } = require('../ai/agentAccess') as typeof import('../ai/agentAccess'); // lazy: agentAccess reaches the stores that reach this module
  const mayUse = new Map<string, boolean>();
  for (const agentId of new Set([...found.values()].flatMap((d) => (d.agentId ? [d.agentId] : [])))) {
    mayUse.set(agentId, await agentForAsk(projectId, agentId).then((r) => r.agent !== null, () => false));
  }
  const titles = new Map([...found].flatMap(([id, d]) => (d.agentId === null || mayUse.get(d.agentId) ? [[id, d.title] as const] : [])));
  return turns.map((t) => {
    const docs = t.guidance?.documents;
    if (!t.guidance || !docs?.length) return t;
    return { ...t, guidance: { ...t.guidance, documentRefs: docs.map((id) => (titles.has(id) ? { id, title: titles.get(id) as string } : { id, title: '', gone: true as const })) } };
  });
}
