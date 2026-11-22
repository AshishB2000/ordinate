// What the Assistant was when a suite ran (docs/eval-suites/00-design.md, "Version stamp"): short hashes of its instructions (the
// project's and the agent's) and its documents (the project's and the agent's, by id and edit time), its model and its topic. Two
// stamps that differ say what changed ("Instructions changed"); a suite whose last run's stamp is not today's is the "Run tests" prompt.
// Read in the caller's request context. No text is kept, only hashes.

import { createHash } from 'crypto';
import { listAgents, readAgent } from '../../ai/agents';
import { listInstructions } from '../../app/instructions';
import * as knowledge from '../../knowledge/store';

const short = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 10);
export const PARTS = ['instructions', 'documents', 'model', 'topic'] as const;
export type Part = (typeof PARTS)[number];

export async function versionOf(projectId: string, agentId: string | null): Promise<Record<Part, string>> {
  const agent = agentId ? (await readAgent(projectId, agentId))?.rec ?? null : null;
  const instructions = [...(await listInstructions(projectId)), ...(agent?.instructions ?? [])].map((i) => i.text);
  const docs = knowledge.knowledgeOn()
    ? [...(await knowledge.listDocs(projectId, null)), ...(agentId ? await knowledge.listDocs(projectId, agentId) : [])].map((d) => `${d.id}@${d.updatedAt}`).sort()
    : [];
  return { instructions: short(JSON.stringify(instructions)), documents: short(JSON.stringify(docs)), model: agent?.model ? `${agent.model.provider}/${agent.model.model}` : '', topic: agent?.topicId ?? '' };
}

/** The parts that differ between two stamps (a part a stamp lacks counts as different). */
export function changedParts(a: Record<string, string>, b: Record<string, string>): Part[] {
  return PARTS.filter((p) => (a[p] ?? null) !== (b[p] ?? null));
}

/** Does the project's agent still exist (for a suite's agent)? Used to refuse a run of a suite whose agent was deleted. */
export async function agentExists(projectId: string, agentId: string): Promise<boolean> {
  return (await listAgents(projectId)).some((a) => a.id === agentId);
}
