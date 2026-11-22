import { z } from 'zod';
import { byProjectId, rpc, Uuid } from './contract';

// Evaluation suites (docs/eval-suites/00-design.md; src/server/evals/). Thumbs are `read` (whoever may ask may rate, and only their own
// turn); everything about suites, cases, runs and the inbox is `write` (editors and admins). The lists and the run the page polls are
// `audit: 'denials'`, so a poll writes no audit row. Replies carry counts, outcomes and codes; reply text and the judge's line only for
// the person who ran it (src/server/evals/view.ts).
const Turn = z.string().min(1).max(100);
const Say = z.string().trim().max(500);
const Reason = z.enum(['wrong_number', 'wrong_data', 'didnt_answer', 'other']);
const Run = z.strictObject({ projectId: Uuid, runId: Uuid });

export const evals = {
  // A thumbs up or down on the caller's own answer turn; 'none' clears it. A thumbs-down shares the QUESTION (never the answer) with the editors.
  'feedback:rate': rpc({
    access: 'read', input: z.strictObject({ projectId: Uuid, threadId: Uuid, turnId: Turn, value: z.enum(['up', 'down', 'none']), reason: Reason.optional() }), project: byProjectId,
  }),
  // The thumbs-down questions of the project nobody has handled: the question, the agent, the reason, the date. Not the asker.
  'feedback:inbox': rpc({ access: 'write', audit: 'denials', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'feedback:dismiss': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, turnId: Turn }), project: byProjectId }),

  'eval:suites': rpc({ access: 'write', audit: 'denials', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // No id: a new suite for `agentId` (null: the Project assistant). With an id: renamed.
  'eval:suiteSave': rpc({
    access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid.optional(), name: z.string().trim().min(1).max(80), agentId: Uuid.nullable().optional() }), project: byProjectId,
  }),
  'eval:suiteDelete': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, id: Uuid }), project: byProjectId }),
  'eval:cases': rpc({ access: 'write', audit: 'denials', input: z.strictObject({ projectId: Uuid, suiteId: Uuid }), project: byProjectId }),
  // A typed case (no id: new) or an edit of a case's question and words (an id). A figure to compute comes from `eval:caseFrom`, never typed.
  'eval:caseSave': rpc({
    access: 'write', input: z.strictObject({ projectId: Uuid, suiteId: Uuid, id: Uuid.optional(), question: z.string().trim().min(1).max(4000), refuse: z.boolean().optional(), say: Say.optional() }), project: byProjectId,
  }),
  'eval:caseDelete': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, suiteId: Uuid, id: Uuid }), project: byProjectId }),
  // A case made from a verified question, an answer of the caller's own conversation, or an inbox question. Into `suiteId`, or a new suite.
  'eval:caseFrom': rpc({
    access: 'write',
    input: z.strictObject({
      projectId: Uuid,
      suiteId: Uuid.optional(),
      newSuite: z.strictObject({ name: z.string().trim().min(1).max(80), agentId: Uuid.nullable().optional() }).optional(),
      from: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('verified'), id: Uuid, say: Say.optional() }),
        z.strictObject({ kind: z.literal('turn'), threadId: Uuid, turnId: Turn, say: Say.optional() }),
        z.strictObject({ kind: z.literal('inbox'), turnId: Turn, say: Say.optional(), refuse: z.boolean().optional() }),
      ]),
    }),
    project: byProjectId,
  }),

  'eval:runStart': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid, suiteId: Uuid }), project: byProjectId }),
  'eval:runGet': rpc({ access: 'write', audit: 'denials', input: Run, project: byProjectId }),
  'eval:runStop': rpc({ access: 'write', input: Run, project: byProjectId }),
  'eval:runResume': rpc({ access: 'write', input: Run, project: byProjectId }),
  'eval:runList': rpc({ access: 'write', audit: 'denials', input: z.strictObject({ projectId: Uuid, suiteId: Uuid.optional() }), project: byProjectId }),

  // Admin -> AI: the judge's model, or none (the Assistant's own).
  'eval:judge': rpc({ access: 'admin', org: true, audit: 'denials', input: z.undefined() }),
  'eval:setJudge': rpc({ access: 'admin', org: true, audit: true, input: z.strictObject({ pick: z.strictObject({ provider: z.string().min(1).max(40), model: z.string().min(1).max(200) }).nullable() }) }),
} as const;
