// The Assistant's calls. Contracts carry inputs only, so every reply is
// narrowed here by hand to what its handler returns (src/ipc/copilot.ts,
// answers.ts, plan.ts, providersServer.ts). Every figure in a reply — a KPI, a
// row count, a turn count — is the server's; the dock only formats it.

import { useQuery } from '@tanstack/react-query';
import { rpc, type RpcInput } from '../../api/client';

export type Provider = 'anthropic' | 'openai' | 'gemini' | 'gateway';

/** The names the desktop's model menu used (execMenu BYOK_DISPLAY). */
export const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  gateway: 'Gateway (OpenAI-compatible)',
};

export interface ProviderStatus {
  hasKey: boolean;
  verified: boolean;
  connected: boolean;
  baseUrl: string;
  maxTokens: string;
  model: string;
}

/** `key:status` — readiness and has-key FLAGS. There is no key in it, ever. */
export interface KeyStatus {
  isReady: boolean;
  copilotEnabled: boolean;
  byok: { activeProvider: Provider | null; providers: Record<Provider, ProviderStatus> };
  allowedProviders: Provider[];
  /** Why this server cannot store an API key (no database / no master key), or null. */
  keyStore: string | null;
}

export interface Provenance {
  kind?: string;
  name?: string;
  datasetName?: string;
  columns?: string[];
  note?: string;
}

export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  provenance?: Provenance;
  /** A stored answer spec: the card is recomputed from it on every render (`answer:card`). */
  answer?: { datasetId: string; title?: string } & Record<string, unknown>;
}

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
  turnCount: number;
}

export interface ActivityStep {
  kind: 'read' | 'compute' | 'quality' | 'model' | 'inventory';
  label: string;
  detail?: string;
}

/** What a turn proposes next (src/ai/suggestedAction.ts). The dock acts on `plan`. */
export interface SuggestedAction {
  kind: string;
  intent: string;
  steps?: unknown[];
  droppedSteps?: number;
}

export type AskReply =
  | { ok: true; answer: string; turns: Turn[]; threadId: string | null; suggestedAction?: SuggestedAction }
  | { ok: false; notReady?: boolean; error?: string };

/** What the dock is looking at — resolved inside the project by the server (buildFacts). */
export type Ask = { kind: RpcInput<'copilot:ask'>['context']['kind']; id?: string };

export function useKeyStatus(enabled = true) {
  return useQuery({
    queryKey: ['key:status'],
    queryFn: async () => (await rpc('key:status')) as KeyStatus,
    enabled,
  });
}

export function useHistory(projectId: string | null, threadId: string) {
  return useQuery({
    queryKey: ['copilot:history', projectId, threadId],
    enabled: !!projectId,
    queryFn: async () => {
      const r = (await rpc('copilot:history', { projectId: projectId as string, ...(threadId ? { threadId } : {}) })) as
        | { ok: true; turns: Turn[]; threadId: string | null }
        | { ok: false; error?: string };
      if (!r.ok) throw new Error(r.error || 'Could not load the conversation.');
      return r;
    },
  });
}

export async function listThreads(projectId: string): Promise<ThreadSummary[]> {
  const r = (await rpc('copilot:threads', { projectId })) as { ok: boolean; threads?: ThreadSummary[] };
  return r.ok && Array.isArray(r.threads) ? r.threads : [];
}

export async function newThread(projectId: string): Promise<string> {
  const r = (await rpc('copilot:newThread', { projectId })) as { ok: boolean; thread?: { id: string } };
  return r.ok && r.thread ? r.thread.id : '';
}

export async function ask(projectId: string, context: Ask, question: string, threadId: string, askId: string): Promise<AskReply> {
  return (await rpc('copilot:ask', {
    projectId,
    context: { kind: context.kind, ...(context.id ? { id: context.id } : {}) },
    question,
    ...(threadId ? { threadId } : {}),
    askId,
  })) as AskReply;
}

export async function setAssistantEnabled(enabled: boolean): Promise<void> {
  await rpc('copilot:setEnabled', { enabled });
}

/** One typed result from `byok:test` / a refused save. */
export interface Outcome {
  ok: boolean;
  error?: string;
  message?: string;
  detail?: string;
}

/**
 * Connect a provider the way the desktop's settings pane did it, in its three
 * steps: save (the key goes to the server's encrypted store and never comes
 * back), a real connectivity test, then make it the active one.
 */
export async function connectProvider(provider: Provider, fields: { apiKey: string; baseUrl?: string; model?: string }): Promise<Outcome> {
  const saved = (await rpc('byok:saveProvider', {
    provider,
    fields: {
      apiKey: fields.apiKey,
      ...(fields.baseUrl !== undefined ? { baseUrl: fields.baseUrl } : {}),
      ...(fields.model !== undefined ? { model: fields.model } : {}),
    },
  })) as Outcome;
  if (!saved.ok) return { ok: false, message: saved.error || saved.message || 'The key could not be saved.' };
  const tested = (await rpc('byok:test', { provider })) as Outcome;
  if (!tested.ok) return { ok: false, message: [tested.message, tested.detail].filter(Boolean).join(' — ') || 'The provider did not answer.' };
  const active = (await rpc('byok:activate', { provider })) as Outcome;
  return active.ok ? { ok: true } : { ok: false, message: 'Connected, but it could not be made the active provider.' };
}

export async function activateProvider(provider: Provider): Promise<boolean> {
  return ((await rpc('byok:activate', { provider })) as Outcome).ok;
}
