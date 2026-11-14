// Assistant agents IPC (docs/assistant-agents/00-design.md): list (with the preselection), save, delete, and one change to
// an agent's instructions. The contracts (src/api/agents.ts) let only a project admin save or delete and an editor change
// instructions; who may USE an agent is src/ai/agentAccess.ts. Ids, names and settings only, never a value (row policy META).

import { ipcMain } from './bus';
import * as trash from '../app/trash';
import { contentTag } from '../app/editConflict';
import { FIGURE_RE, type Instruction, type InstructionOp } from '../app/instructions';
import { listTopics, topicsForReaders } from '../analysis/topics';
import { changeAgentInstructions, saveAgent, updateAgent, type Agent, type AgentInput } from '../ai/agents';
import { ADMIN_RANK, agentProblem, agentsFor, EDITOR_RANK, preselect } from '../ai/agentAccess';
import { agentNotFound, agentNotSaved, agentsNotRead } from '../ai/agentMessages';
import * as copilot from '../ai/copilot';
import { orgTeams } from '../server/authz/caller';
import { logger } from '../app/logger';

const flagged = (list: Instruction[]) => list.map((i) => (FIGURE_RE.test(i.text) ? { ...i, figure: true as const } : i));

/** One agent as `agent:list` gives it. `instructions` and `tag` are an editor's and an admin's. */
async function rowsOf(projectId: string, list: Agent[], usable: Set<string>, rank: number) {
  const topics = new Map((await topicsForReaders(projectId, await listTopics(projectId))).map(({ topic }) => [topic.id, topic] as const));
  const teams = new Map((await orgTeams([...new Set(list.flatMap((a) => a.teamIds))])).map((t) => [t.id, t.name] as const));
  return list.map((a) => {
    const t = a.topicId ? topics.get(a.topicId) : undefined;
    return {
      id: a.id,
      name: a.name,
      ...(a.description ? { description: a.description } : {}),
      usable: usable.has(a.id),
      // A topic that is gone (in the Trash) narrows nothing: the agent answers from all data until one is picked again.
      topic: t ? { id: t.id, name: t.name, datasetIds: t.datasets.map((d) => d.id) } : null,
      ...(a.topicId && !t ? { topicGone: true } : {}),
      model: a.model,
      build: a.build,
      teams: a.teamIds.flatMap((id) => (teams.has(id) ? [{ id, name: teams.get(id)! }] : [])),
      ...(rank >= EDITOR_RANK ? { instructions: flagged(a.instructions) } : {}),
      ...(rank >= ADMIN_RANK ? { tag: contentTag('agent', a) } : {}),
    };
  });
}

export function register(): void {
  ipcMain.handle('agent:list', async (_e, { projectId }: { projectId: string }) => {
    try {
      const { all, usable, rank, teams } = await agentsFor(projectId);
      const latest = (await copilot.listThreads(projectId))[0];
      const mine = new Set(usable.map((a) => a.id));
      // A viewer sees the agents they may use; an editor every one, for its instructions.
      const shown = rank >= EDITOR_RANK ? all : usable;
      return {
        ok: true,
        agents: await rowsOf(projectId, shown, mine, rank),
        preselected: preselect(usable, teams, latest?.agentId),
        canManage: rank >= ADMIN_RANK,
        canInstruct: rank >= EDITOR_RANK,
      };
    } catch (err) {
      logger.error('[agents] list failed:', (err as Error).message);
      return { ok: false, error: agentsNotRead() };
    }
  });

  // `base`: the page's tag — a stale one is 409 record_changed (../app/editConflict); `tag` is the next base.
  ipcMain.handle('agent:save', async (_e, { projectId, id, base, agent }: { projectId: string; id?: string; base?: string; agent: AgentInput }) => {
    const problem = await agentProblem(projectId, agent, id);
    if (problem) return { ok: false, ...problem };
    // A stale base throws ERECORDCHANGED out of updateAgent, uncaught: the route answers it 409.
    const a = id ? await updateAgent(projectId, id, agent, base) : await saveAgent(projectId, agent);
    if (!a) return { ok: false, error: agentNotFound() };
    return { ok: true, agent: { id: a.id, name: a.name }, tag: contentTag('agent', a) };
  });

  ipcMain.handle('agent:delete', async (_e, { projectId, id }: { projectId: string; id: string }) => {
    const done = await trash.trashRecord(projectId, 'agent', id);
    return done.ok ? { ok: true } : { ok: false, error: agentNotFound() };
  });

  ipcMain.handle('agent:instructions', async (_e, { projectId, id, op }: { projectId: string; id: string; op: InstructionOp }) => {
    try {
      const a = await changeAgentInstructions(projectId, id, op);
      return a ? { ok: true, instructions: flagged(a.instructions) } : { ok: false, error: agentNotFound() };
    } catch (err) {
      return { ok: false, error: (err as Error).message || agentNotSaved() };
    }
  });
}
