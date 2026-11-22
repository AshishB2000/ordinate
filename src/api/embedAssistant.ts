// The embedded Assistant's setup (docs/embedded-assistant/00-design.md, src/ipc/embedAssistant.ts): which agents may be embedded
// and on which datasets, and the caps. Embedding is an org-level, security-relevant switch, so every channel is an org admin's
// (`org: true` + `admin`, refused 403 before the handler); the project an agent lives in is named in the input and checked by the
// handler. No channel here reads rows, and none is reachable by an embed asker (it has no RPC at all).

import { z } from 'zod';
import { rpc, Uuid } from './contract';

const Dataset = z.strictObject({ id: Uuid, column: z.string().trim().min(1).max(256) });

export const embedAssistant = {
  'embedAssistant:settings': rpc({ access: 'admin', org: true, audit: 'denials', input: z.undefined() }),
  // The agents and the datasets (with their text columns) of one project, for the pickers.
  'embedAssistant:options': rpc({ access: 'admin', org: true, audit: 'denials', input: z.strictObject({ projectId: Uuid }) }),
  'embedAssistant:save': rpc({ access: 'admin', org: true, input: z.strictObject({ projectId: Uuid, agentId: Uuid, enabled: z.boolean(), datasets: z.array(Dataset).max(12) }) }),
  'embedAssistant:remove': rpc({ access: 'admin', org: true, input: z.strictObject({ agentId: Uuid }) }),
  'embedAssistant:setLimits': rpc({ access: 'admin', org: true, input: z.strictObject({ daily: z.number().int().min(1).max(1_000_000), perMinute: z.number().int().min(1).max(600) }) }),
} as const;
