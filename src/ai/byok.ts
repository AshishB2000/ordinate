// Which API-key (BYOK) provider a model call runs on — MAIN PROCESS / SERVER.
//
// Split out of ./analyze.ts (over its 800-line cap). One resolver for every
// model call (dispatch: the dock, captures, suggestions): the ACTIVE connected
// provider, refused when the org does not allow it (execConfig.providerAllowed,
// Admin → Settings), its key from execConfig.byokCredentials (the org's secrets
// store on the server, config.json on the desktop). The HTTP call itself goes
// through ./providerFetch.ts.

import * as config from '../app/config';
import * as execConfig from '../app/execConfig';
import { ADAPTERS, errProvider, type TypedError } from './analyze';

export const DEFAULT_MODEL = 'claude-sonnet-4-6';

export function errNoKey(): TypedError {
  return { ok: false, errorType: 'auth', message: 'No API key saved — add one in Settings.' };
}

/** What a capture (or any model call) can run on right now — the same checks resolveByok makes, for a not-ready state. */
export type ModelStatus = { ready: true; provider: string } | { ready: false; reason: 'no_model' | 'not_allowed' };

export async function modelStatus(): Promise<ModelStatus> {
  const provider = execConfig.effectiveByokActive();
  if (!provider) return { ready: false, reason: 'no_model' };
  if (!(await execConfig.providerAllowed(provider))) return { ready: false, reason: 'not_allowed' };
  return { ready: true, provider };
}

// Resolve the active BYOK provider + credentials, or return an error.
export async function resolveByok(): Promise<
  | { error: TypedError }
  | { error?: undefined; provider: string; apiKey?: string | null; baseUrl?: string; model: string; maxTokens?: number | string }> {
  // Only ever run a provider that is actually Connected (verified). A stale or
  // keyless active provider resolves to null → ask the user to connect one.
  const provider = execConfig.effectiveByokActive();
  if (!provider) return { error: errNoKey() };
  if (!(await execConfig.providerAllowed(provider))) {
    return { error: { ok: false, errorType: 'provider', message: `Your organization does not allow ${ADAPTERS[provider]?.label || provider}. Ask an admin to connect an allowed provider.` } };
  }
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
