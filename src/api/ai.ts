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

/**
 * The fingerprint (embedding) models meaning search may use, 768 numbers each (src/ai/fingerprints.ts).
 * A gateway's is typed in. Anthropic has no embedding API, so it has none.
 */
export const FINGERPRINT_MODELS = {
  openai: ['text-embedding-3-small', 'text-embedding-3-large'],
  gemini: ['gemini-embedding-001', 'gemini-embedding-2'],
} as const;
const FingerprintPick = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('openai'), model: z.enum(FINGERPRINT_MODELS.openai) }),
  z.strictObject({ provider: z.literal('gemini'), model: z.enum(FINGERPRINT_MODELS.gemini) }),
  z.strictObject({ provider: z.literal('gateway'), model: ModelId }),
]);

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
  // The org's fingerprint model for meaning search (ai:admin's `fingerprintModel`); null turns it off, the default.
  // Its provider must be connected. Saving sends nothing to the provider.
  'ai:setFingerprintModel': rpc({ access: 'admin', org: true, input: z.strictObject({ pick: FingerprintPick.nullable() }) }),
  // Fingerprints one short sample with `pick`, saved or not: { ok, dimensions, ms } or the provider's sentence.
  'ai:testFingerprint': rpc({ access: 'admin', org: true, input: z.strictObject({ pick: FingerprintPick }) }),
  // Meaning search's coverage: { vectors: 'ready' | why not (no_database, no_extension, not_created, no_table),
  // items, fingerprinted } — the org's searched items with a text, and how many have a fresh fingerprint of its model
  // (null with no model or no table). Counts only: no item, no text.
  'ai:fingerprintStatus': rpc({ access: 'admin', org: true, input: z.undefined() }),
} as const;
