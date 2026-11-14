// Assistant agents (docs/assistant-agents/00-design.md; src/ipc/agents.ts over src/ai/agents.ts): several assistants
// per project, each a topic, its own instructions, a model, what it may do and the teams that use it. An agent only
// narrows what a person can read; who may use one is decided in code (src/ai/agentAccess.ts), never by a model.
//
// Any project reader lists the agents they may use and which one is preselected; an editor also gets every agent, to
// change its instructions (`write`, as the project's own instructions); creating, changing and deleting one, and its
// teams, topic, model and actions, are the project admin's (rule 5). Ids, names and settings only: never a value.

import { z } from 'zod';
import { AI_PROVIDERS } from './admin';
import { Base, byProjectId, rpc, Uuid } from './contract';

const Agent = z.strictObject({
  name: z.string().trim().min(1).max(80), // unique in the project, ignoring case, and never "Project assistant"
  description: z.string().max(500).optional(),
  topicId: Uuid.nullable(), // none = all data
  model: z.strictObject({ provider: z.enum(AI_PROVIDERS), model: z.string().trim().min(1).max(200) }).nullable(), // none = each person's own
  build: z.boolean(),
  teamIds: z.array(Uuid).max(50),
});

export const agents = {
  // { agents, preselected, canManage, canInstruct }: the agents the caller may use (an editor and an admin get every
  // one, `usable` marking theirs), each with its topic's name and dataset ids, teams by name, its instructions (editor
  // prose, as catalog:instructions) and, for an admin, the tag `agent:save` takes as `base`. Ids and names only
  // (scripts/rowPolicyReaders.ts: META).
  'agent:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // Creates without `id`, replaces the settings with one (never the instructions). A topic, model or team that is not
  // there is refused with a sentence; a stale `base` is 409 record_changed.
  'agent:save': rpc({ access: 'admin', input: z.strictObject({ projectId: Uuid, id: Uuid.optional(), base: Base.optional(), agent: Agent }), project: byProjectId }),
  // To the project's Trash, restorable by a project admin. Its conversations stay readable.
  'agent:delete': rpc({ access: 'admin', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  // ONE change to an agent's instructions, by the rules of the project's own (catalog:setInstructions).
  'agent:instructions': rpc({
    access: 'write',
    project: byProjectId,
    input: z.strictObject({
      projectId: Uuid,
      id: Uuid,
      op: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('add'), text: z.string().max(300) }),
        z.strictObject({ kind: z.literal('edit'), id: Uuid, text: z.string().max(300) }),
        z.strictObject({ kind: z.literal('remove'), id: Uuid }),
      ]),
    }),
  }),
} as const;
