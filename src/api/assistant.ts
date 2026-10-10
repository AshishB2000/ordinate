// The Assistant dock (T2.12): conversations, asking, answer cards, plans, and
// connecting a provider. Handlers: src/ipc/copilot.ts, answers.ts, plan.ts and
// providersServer.ts.
//
// Asking is `read`: a member who may read the project may ask about it, and the
// conversation it writes is the asker's own (threads are per member on the
// server, src/ai/copilot.ts). Running a plan writes records, so it is `write`.
// The provider settings are the org's — its key, its endpoint — so changing
// them is org `admin`; reading readiness is any member's.

import { z } from 'zod';
import { AI_PROVIDERS } from './admin';
import { byProjectId, FileToken, rpc, Uuid } from './contract';

const Provider = z.enum(AI_PROVIDERS);
const Steps = z.array(z.looseObject({ kind: z.string().max(40) })).max(50);
/** A stored answer spec; src/ai/answerSpec.ts `sanitizeStoredSpec` whitelists the rest. */
const AnswerSpec = z.looseObject({ datasetId: Uuid });
/** What the dock is looking at — src/ipc/copilot.ts `buildFacts` resolves it inside the project. */
const Context = z.strictObject({
  kind: z.enum(['', 'dataset', 'visual', 'capture', 'analysis', 'stats', 'drivers', 'scorecard', 'scenario']),
  id: z.string().max(200).optional(),
  offset: z.number().int().min(-1000).max(1000).optional(),
  // The open Statistics panel's analysis SPEC, never figures (src/ai/statsFacts.ts recomputes it).
  stats: z.looseObject({}).optional(),
});

/**
 * The project a plan run belongs to, for the plan channels' scope check. The
 * runs live in src/ipc/plan.ts, which installs this when it registers — a
 * contract file never imports a handler (the web type-checks this file).
 */
export const planRuns: { project(runId: string): string | null } = { project: () => null };
const byRun = (i: { runId: string }): string | null => planRuns.project(i.runId);

export const assistant = {
  // Readiness, has-key flags, the org's allowed providers. Never a key.
  'key:status': rpc({ access: 'read', org: true, input: z.undefined() }),
  // preload: invoke('byok:saveProvider', { provider, fields }). The key is write-only.
  'byok:saveProvider': rpc({
    access: 'admin',
    org: true,
    input: z.strictObject({
      provider: Provider,
      fields: z.strictObject({
        apiKey: z.string().max(4096).optional(),
        baseUrl: z.union([z.literal(''), z.string().max(2048).regex(/^https?:\/\/[^\s]+$/)]).optional(),
        model: z.string().max(200).optional(),
        maxTokens: z.string().max(10).regex(/^\d*$/).optional(),
      }),
    }),
  }),
  'byok:test': rpc({ access: 'admin', org: true, input: z.strictObject({ provider: Provider }) }),
  'byok:activate': rpc({ access: 'admin', org: true, input: z.strictObject({ provider: Provider }) }),
  // The org-wide on/off switch (config.copilotEnabled).
  'copilot:setEnabled': rpc({ access: 'admin', org: true, input: z.strictObject({ enabled: z.boolean() }) }),

  'copilot:history': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, threadId: Uuid.optional() }), project: byProjectId }),
  'copilot:threads': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  'copilot:newThread': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // A conversation is its asker's own, so renaming or deleting it is `read` like starting one;
  // the store acts only on the CALLER's threads (src/ai/copilot.ts `mine`). The title is cut to its cap there.
  'copilot:renameThread': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, threadId: Uuid, title: z.string().trim().min(1).max(200) }), project: byProjectId }),
  'copilot:deleteThread': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, threadId: Uuid }), project: byProjectId }),
  // The answer streams to the asking tab only (`copilot:ask:chunk` / `copilot:ask:activity`
  // on its own event stream, keyed by askId); the reply carries the persisted turns.
  'copilot:ask': rpc({
    access: 'read',
    input: z.strictObject({
      projectId: Uuid,
      context: Context,
      question: z.string().trim().min(1).max(4000),
      threadId: Uuid.optional(),
      askId: Uuid.optional(),
    }),
    project: byProjectId,
  }),

  'answer:card': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, spec: AnswerSpec }), project: byProjectId }),
  'answer:explain': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, visualId: Uuid.optional(), tile: z.looseObject({ datasetId: Uuid }).optional() }),
    project: byProjectId,
  }),
  'answer:rerun': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, threadId: Uuid.optional(), spec: AnswerSpec, label: z.string().max(200).optional() }),
    project: byProjectId,
  }),

  'plan:check': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, steps: Steps }), project: byProjectId }),
  'plan:start': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, threadId: z.union([Uuid, z.literal('')]).optional(), intent: z.string().max(400).optional(), steps: Steps }),
    project: byProjectId,
  }),
  // plan:next may hand over the upload an import step reads (POST /api/files).
  'plan:next': rpc({ access: 'write', input: z.strictObject({ runId: Uuid, fileToken: FileToken.optional() }), project: byRun }),
  'plan:skip': rpc({ access: 'write', input: z.strictObject({ runId: Uuid, index: z.number().int().min(0).max(49) }), project: byRun }),
  'plan:fix': rpc({ access: 'write', input: z.strictObject({ runId: Uuid, index: z.number().int().min(0).max(49) }), project: byRun }),
  'plan:stop': rpc({ access: 'write', input: z.strictObject({ runId: Uuid }), project: byRun }),
  'plan:undo': rpc({ access: 'write', input: z.strictObject({ runId: Uuid }), project: byRun }),
} as const;
