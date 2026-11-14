// Which Assistant agents a person may use, which one is preselected, and which one answers an ask
// (docs/assistant-agents/00-design.md, rules 2, 3, 5, 7, 11, 12). MAIN PROCESS ONLY. Code decides all of it, never a
// model: the ONE place an ask's agent is resolved (`agentForAsk`), so a later router or Slack door asks here too.
//
// May use: the caller is in one of the agent's teams, or edits the project (an editor, a project admin, an org admin),
// so the people who write an agent's instructions can try it in the test chat before its teams do ("What people
// see"). An agent never grants: what it answers from is still read through the caller's own doors, row locks and
// hidden columns, so trying one shows an editor nothing they could not already read.

import { readAgent, listAgents, MAX_AGENTS, MAX_AGENT_NAME, PROJECT_ASSISTANT, type Agent, type AgentInput } from './agents';
import * as msg from './agentMessages';
import { readTopic } from '../analysis/topics';
import { readEntry, recordName } from '../app/trashStore';
import { callerTeamIds, orgTeams, rankOn } from '../server/authz/caller';
import * as aiConfig from '../server/aiConfig';

export const ADMIN_RANK = 3;
export const EDITOR_RANK = 2;

/** May a caller of `rank` in `teams` use `agent`? */
export function mayUse(agent: Pick<Agent, 'teamIds'>, rank: number, teams: readonly string[]): boolean {
  return rank >= EDITOR_RANK || agent.teamIds.some((t) => teams.includes(t));
}

/**
 * The agent a new conversation starts with (rule 2, "What people see"): the agent of the caller's latest conversation
 * when they may still use it; else the first agent, in list order, given to one of their teams; else null, the
 * Project assistant. A latest conversation with the Project assistant names no agent, so the team's is next.
 */
export function preselect(usable: readonly Agent[], teams: readonly string[], latestAgentId: string | null | undefined): string | null {
  if (latestAgentId && usable.some((a) => a.id === latestAgentId)) return latestAgentId;
  return usable.find((a) => a.teamIds.some((t) => teams.includes(t)))?.id ?? null;
}

export interface AgentsFor {
  all: Agent[];
  usable: Agent[];
  rank: number;
  teams: string[];
}

/** Every agent of the project, the ones the caller may use, and who the caller is there. */
export async function agentsFor(projectId: string): Promise<AgentsFor> {
  const [all, rank, teams] = await Promise.all([listAgents(projectId), rankOn(projectId), callerTeamIds()]);
  return { all, usable: all.filter((a) => mayUse(a, rank, teams)), rank, teams };
}

/** Who answers an ask: the agent, or null for the Project assistant — with the line saying why when it fell back. */
export interface AskAgent {
  agent: Agent | null;
  note: string | null;
}

/**
 * The agent of a conversation (or of the one an ask starts), as it may answer now. A missing agent, one in the Trash,
 * or one the caller may not use falls back to the Project assistant with a line in the reply (rule 12): never an
 * error that costs the answer, and never the agent's topic, instructions or model for someone it was not given to.
 */
export async function agentForAsk(projectId: string, agentId: string | null | undefined): Promise<AskAgent> {
  if (!agentId) return { agent: null, note: null };
  const stored = await readAgent(projectId, agentId);
  if (!stored) {
    const trashed: unknown = await readEntry(projectId, 'agent', agentId);
    const name = trashed && typeof trashed === 'object' ? recordName(trashed as { name?: unknown }).trim() : '';
    return { agent: null, note: name ? msg.agentWasDeleted(name) : msg.agentGone() };
  }
  const [rank, teams] = await Promise.all([rankOn(projectId), callerTeamIds()]);
  return mayUse(stored.rec, rank, teams) ? { agent: stored.rec, note: null } : { agent: null, note: msg.agentNotYours() };
}

/** The name an agent shows under, for a conversation in History: a live one's, else its Trash entry's, else none. */
export async function agentNames(projectId: string, ids: Iterable<string>): Promise<Map<string, { name: string; gone?: true }>> {
  const live = new Map((await listAgents(projectId)).map((a) => [a.id, a.name] as const));
  const out = new Map<string, { name: string; gone?: true }>();
  for (const id of new Set(ids)) {
    const name = live.get(id);
    if (name !== undefined) {
      out.set(id, { name });
      continue;
    }
    const trashed: unknown = await readEntry(projectId, 'agent', id);
    const was = trashed && typeof trashed === 'object' ? recordName(trashed as { name?: unknown }).trim() : '';
    if (was) out.set(id, { name: was, gone: true });
  }
  return out;
}

/** A conversation's agent as a reply names it: null for the Project assistant; `gone` once it is deleted (or never was). */
export async function agentRef(projectId: string, id: string | null): Promise<{ id: string; name: string; gone?: true } | null> {
  if (!id) return null;
  const n = (await agentNames(projectId, [id])).get(id);
  return n && !n.gone ? { id, name: n.name } : { id, name: n?.name ?? '', gone: true };
}

export type AgentField = 'name' | 'topicId' | 'model' | 'teamIds';

/** Why `input` cannot be saved (the box it belongs beside, and the sentence), or null. `exceptId`: the agent being edited. */
export async function agentProblem(projectId: string, input: AgentInput, exceptId?: string): Promise<{ field: AgentField; error: string } | null> {
  const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim().slice(0, MAX_AGENT_NAME) : '';
  if (!name) return { field: 'name', error: msg.agentNameMissing() };
  const others = (await listAgents(projectId)).filter((a) => a.id !== exceptId);
  const lower = name.toLocaleLowerCase();
  if (lower === PROJECT_ASSISTANT.toLocaleLowerCase() || others.some((a) => a.name.toLocaleLowerCase() === lower)) return { field: 'name', error: msg.agentNameTaken(name) };
  if (!exceptId && others.length >= MAX_AGENTS) return { field: 'name', error: msg.tooManyAgents(MAX_AGENTS) };
  if (typeof input.topicId === 'string' && !(await readTopic(projectId, input.topicId))) return { field: 'topicId', error: msg.agentTopicGone() };
  const m = input.model as { provider: string; model: string } | null | undefined;
  // A model kept as it was is not checked again: one no longer enabled just falls back (rule 7), and must not block a rename.
  const was = exceptId ? (await readAgent(projectId, exceptId))?.rec.model : null;
  if (m && !(was && was.provider === m.provider && was.model === m.model)) {
    // Only a model members may use now (Admin → AI): without a database none is, so none can be named.
    const models = aiConfig.enabled() ? (await aiConfig.memberView()).models : [];
    if (!models.some((x) => x.provider === m.provider && x.model === m.model)) return { field: 'model', error: msg.agentModelNotEnabled() };
  }
  const teams = Array.isArray(input.teamIds) ? [...new Set((input.teamIds as string[]).map((t) => t.toLowerCase()))] : [];
  if (teams.length && (await orgTeams(teams)).length !== teams.length) return { field: 'teamIds', error: msg.agentTeamGone() };
  return null;
}
