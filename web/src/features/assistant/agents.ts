// Assistant agents (docs/assistant-agents/00-design.md; src/ipc/agents.ts): the agents a person may use and the one
// preselected for them — the composer's picker, Home's ask bar and the Data model's Agents section read ONE list.
// Contracts carry inputs only, so the replies are narrowed here by hand. Who may use an agent is the server's to say;
// nothing here decides it.

import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import { okOr, type Fail } from '../data/api';
import type { Instruction } from '../model/assistant/api';
import type { AiModel, AiStatus, Provider } from './api';

/** The one that is always there: today's Assistant, all the data the person can read. Not a record. */
export const PROJECT_ASSISTANT = 'Project assistant';

export interface AgentRow {
  id: string;
  name: string;
  description?: string;
  /** May the caller use it: in one of its teams, or a project admin. */
  usable: boolean;
  /** Its topic, by name, with its datasets' ids; null: all data. */
  topic: { id: string; name: string; datasetIds: string[] } | null;
  /** It names a topic that is gone (in the Trash): it answers from all data until another is picked. */
  topicGone?: true;
  model: { provider: Provider; model: string } | null;
  build: boolean;
  teams: { id: string; name: string }[];
  /** Editor prose every reader of the agent sees, as the project's own instructions. */
  instructions?: Instruction[];
  /** An admin's only: the base `agent:save` takes. */
  tag?: string;
}

export interface AgentList {
  agents: AgentRow[];
  /** The agent a new conversation starts with; null: the Project assistant. */
  preselected: string | null;
  canManage: boolean;
  canInstruct: boolean;
}

export const AGENTS = 'agent:list';
export const agentsKey = (projectId: string | null) => [AGENTS, projectId] as const;

/** One read per project, kept half a minute: the dock, the page, Home and the Data model share it. */
export function useAgents(projectId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: agentsKey(projectId ?? null),
    enabled: enabled && !!projectId,
    staleTime: 30_000,
    queryFn: async () => {
      const r = okOr((await rpc(AGENTS, { projectId: projectId as string })) as ({ ok: true } & AgentList) | Fail, 'The assistants');
      return { agents: r.agents, preselected: r.preselected, canManage: r.canManage, canInstruct: r.canInstruct } satisfies AgentList;
    },
  });
}

/** The agents the caller may use, in list order. */
export const usableAgents = (list: AgentList | undefined): AgentRow[] => (list?.agents ?? []).filter((a) => a.usable);

/** What a conversation's agent is called, as History writes it. */
export function agentName(t: { agentId?: string; agentName?: string; agentGone?: boolean }): string {
  if (!t.agentId) return PROJECT_ASSISTANT;
  const name = t.agentName || 'An assistant';
  return t.agentGone ? `${name} (deleted)` : name;
}

/** The agent's model, when it is set and still one the org admin enabled: it answers everyone in the agent then. */
export function agentModel(agent: AgentRow | null | undefined, status: AiStatus | undefined): AiModel | undefined {
  const m = agent?.model;
  return m ? status?.models.find((x) => x.provider === m.provider && x.model === m.model) : undefined;
}
