import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

// Deep research (docs/deep-research/00-design.md; src/server/research/). A run is PRIVATE to its starter: every research:*
// handler but the two limit channels checks that the caller started it (anything else is "not found"). Replies carry specs,
// statuses, reasons and the validated report; never a step's facts or ledger.
const Run = z.strictObject({ projectId: Uuid, runId: Uuid });

export const research = {
  // Starts a run in place of copilot:ask: appends the question and ONE research turn to the conversation. Editors and admins.
  'research:start': rpc({
    access: 'write', input: z.strictObject({ projectId: Uuid, threadId: Uuid.optional(), agentId: Uuid.optional(), question: z.string().trim().min(1).max(4000) }), project: byProjectId,
  }),
  // The run: state, plan, counts, steps (spec, status, reason) and the report.
  'research:get': rpc({ access: 'read', input: Run, project: byProjectId }),
  // One step's chart, drawn now under the caller's access.
  'research:card': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, runId: Uuid, step: z.number().int().min(1).max(200) }), project: byProjectId }),
  'research:stop': rpc({ access: 'write', input: Run, project: byProjectId }),
  'research:resume': rpc({ access: 'write', input: Run, project: byProjectId }),
  // Saves the cited charts, makes the Story, records it on the run. Idempotent: a second press opens the same story.
  'research:addToProject': rpc({ access: 'write', input: Run, project: byProjectId }),
  // The caller's own runs in a project (History), and what the composer needs: the active run and the time limit.
  'research:list': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // Admin -> AI: the three limits and their ceilings.
  'research:limits': rpc({ access: 'admin', org: true, audit: 'denials', input: z.undefined() }),
  'research:setLimits': rpc({
    access: 'admin', org: true, audit: true,
    input: z.strictObject({ steps: z.number().int().min(1).max(20), queries: z.number().int().min(1).max(30), minutes: z.number().int().min(1).max(30) }),
  }),
} as const;
