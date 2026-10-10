// AI models (docs/ai-models/00-plan.md §4): Admin → AI connects providers and
// chooses the exact models members may use; every member picks one of them.
// Handlers: src/ipc/aiModels.ts over src/server/aiConfig.ts.
//
// Reading what you may use and choosing your own model are any member's
// (`read`); everything that touches a key or the org's list is org `admin`.
// A key goes in (ai:connect) and never comes back out of any channel.

import { z } from 'zod';
import { AI_PROVIDERS } from './admin';
import { rpc } from './contract';

const Provider = z.enum(AI_PROVIDERS);
const ModelId = z.string().trim().min(1).max(200);

export const ai = {
  // { ready, reason?, models, mine, copilotEnabled, keyStore } — the caller's models, never a key.
  'ai:status': rpc({ access: 'read', org: true, input: z.undefined() }),
  // The caller's own pick; refused unless the model is enabled on a connected provider.
  'ai:setMine': rpc({ access: 'read', org: true, input: z.strictObject({ provider: Provider, model: ModelId }) }),
  // { keyStore, providers, models } — has-key flags only.
  'ai:admin': rpc({ access: 'admin', org: true, audit: 'denials', input: z.undefined() }),
  // Save (key write-only) and test in one step; `model` is what the test calls (the gateway has no default).
  'ai:connect': rpc({
    access: 'admin',
    org: true,
    input: z.strictObject({
      provider: Provider,
      apiKey: z.string().max(4096).optional(),
      baseUrl: z.string().max(2048).regex(/^https?:\/\/[^\s]+$/).optional(),
      model: ModelId.optional(),
    }),
  }),
  'ai:disconnect': rpc({ access: 'admin', org: true, input: z.strictObject({ provider: Provider }) }),
  // The provider's live model list (src/ai/models.ts, SSRF-guarded through providerFetch).
  'ai:providerModels': rpc({ access: 'admin', org: true, audit: 'denials', input: z.strictObject({ provider: Provider }) }),
  'ai:setModels': rpc({
    access: 'admin',
    org: true,
    input: z.strictObject({
      models: z.array(z.strictObject({ provider: Provider, model: ModelId, label: z.string().trim().max(200) })).max(50),
      defaultIndex: z.number().int().min(0).max(49),
    }),
  }),
} as const;
