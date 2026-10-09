// Which API-key (BYOK) provider and model a call runs on — MAIN PROCESS / SERVER.
//
// Split out of ./analyze.ts (over its 800-line cap). One resolver for every
// model call (dispatch: the dock, captures, suggestions), so every feature
// follows the same answer:
//
//   - with a database (src/server/aiConfig.ts): the CALLER's pick among the
//     models the org admin enabled, else the org default — from Postgres, so
//     every pod answers the same (docs/ai-models/00-plan.md);
//   - without one (dev mode, the e2e harness, a plain-Node self-check): the
//     pod's config.json — the active connected provider and its model.
//
// The HTTP call itself goes through ./providerFetch.ts.

import * as config from '../app/config';
import * as execConfig from '../app/execConfig';
import * as aiConfig from '../server/aiConfig';
import { aiNotSetUp } from './aiMessages';
import { errProvider, type TypedError } from './analyze';

export const DEFAULT_MODEL = 'claude-sonnet-4-6';

export function errNoKey(): TypedError {
  return { ok: false, errorType: 'auth', message: aiNotSetUp() };
}

/** What a capture (or any model call) can run on right now — the same checks resolveByok makes, for a not-ready state. */
export type ModelStatus = { ready: true; provider: string; model: string } | { ready: false; reason: 'no_model' | 'no_key_store' };

export async function modelStatus(): Promise<ModelStatus> {
  if (aiConfig.enabled()) {
    const v = await aiConfig.memberView();
    return v.mine ? { ready: true, ...v.mine } : { ready: false, reason: v.reason ?? 'no_model' };
  }
  const provider = execConfig.effectiveByokActive();
  if (!provider) return { ready: false, reason: 'no_model' };
  return { ready: true, provider, model: execConfig.getByokProvider(provider).model };
}

// Resolve the caller's provider, model + credentials, or return an error.
export async function resolveByok(): Promise<
  | { error: TypedError }
  | { error?: undefined; provider: string; apiKey?: string | null; baseUrl?: string; model: string; maxTokens?: number | string }> {
  if (aiConfig.enabled()) {
    const r = await aiConfig.resolve();
    if (!r.ok) return { error: { ok: false, errorType: 'auth', message: r.error } };
    return { provider: r.provider, apiKey: r.apiKey, baseUrl: r.baseUrl, model: r.model };
  }
  // Only ever run a provider that is actually Connected (verified). A stale or
  // keyless active provider resolves to null → ask the user to connect one.
  const provider = execConfig.effectiveByokActive();
  if (!provider) return { error: errNoKey() };
  const entry = await execConfig.byokCredentials(provider); // includes apiKey — main only
  if (provider !== 'gateway' && !entry.apiKey) return { error: errNoKey() };
  if (provider === 'gateway' && !entry.baseUrl) {
    return { error: Object.assign(errProvider(), { detail: 'Gateway · set a base URL in Settings' }) };
  }
  // Gateway/custom can't auto-list models, so there's no safe default — sending a
  // built-in model id (an Anthropic one) to e.g. OpenRouter just 404s. Require the
  // user's own model id instead of silently substituting DEFAULT_MODEL.
  let model = entry.model || (config.BYOK_DEFAULTS[provider] && config.BYOK_DEFAULTS[provider].model) || '';
  if (provider === 'gateway' && !model) {
    return { error: Object.assign(errProvider(), { message: 'Enter a model id for the gateway in Settings (e.g. openai/gpt-4o-mini).' }) };
  }
  if (!model) model = DEFAULT_MODEL;
  return { provider, apiKey: entry.apiKey, baseUrl: entry.baseUrl, model, maxTokens: entry.maxTokens };
}
