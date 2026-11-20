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
  const titles = await titlesOf(projectId, ids).catch(() => new Map<string, string>());
  return turns.map((t) => {
    const docs = t.guidance?.documents;
    if (!t.guidance || !docs?.length) return t;
    return { ...t, guidance: { ...t.guidance, documentRefs: docs.map((id) => (titles.has(id) ? { id, title: titles.get(id) as string } : { id, title: '', gone: true as const })) } };
  });
}
