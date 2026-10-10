// The Assistant's calls. Contracts carry inputs only, so every reply is
// narrowed here by hand to what its handler returns (src/ipc/copilot.ts,
// answers.ts, plan.ts, aiModels.ts). Every figure in a reply — a KPI, a
// row count, a turn count — is the server's; the dock only formats it.

import { useQuery } from '@tanstack/react-query';
import { rpc, type RpcInput } from '../../api/client';

export type Provider = 'anthropic' | 'openai' | 'gemini' | 'gateway';

/** The names the desktop's model menu used (execMenu BYOK_DISPLAY). */
export const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  gateway: 'OpenAI-compatible gateway',
};

/** A model the org admin enabled (src/server/aiConfig.ts AiModel). */
export interface AiModel {
  provider: Provider;
  model: string;
  label: string;
  isDefault: boolean;
}

/** `ai:status` — what the caller may use and what answers them. There is no key in it, ever. */
export interface AiStatus {
  ready: boolean;
  /** Why not: this server cannot store a key, or no model is enabled on a connected provider. */
  reason?: 'no_key_store' | 'no_model';
  models: AiModel[];
  /** The caller's pick while it is enabled, else the org default. */
  mine: { provider: Provider; model: string } | null;
  copilotEnabled: boolean;
  /** Why this server cannot store an API key (no database / no master key), or null. */
  keyStore: string | null;
}

/** The model that answers, as the picker and "Powered by" name it. */
export function mineModel(status: AiStatus | undefined): AiModel | undefined {
  const m = status?.mine;
  return m ? status.models.find((x) => x.provider === m.provider && x.model === m.model) : undefined;
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

/** One hook for every AI surface: the dock, Home, Analyses, Visuals, captures. */
export function useAiStatus(enabled = true) {
  return useQuery({
    queryKey: ['ai:status'],
    queryFn: async () => (await rpc('ai:status')) as AiStatus,
    enabled,
  });
}

/** The caller's own pick (`ai:setMine`); refused unless the admin enabled it. */
export async function setMyModel(provider: Provider, model: string): Promise<boolean> {
  return ((await rpc('ai:setMine', { provider, model })) as { ok: boolean }).ok;
}

export function useHistory(projectId: string | null, threadId: string) {
  return useQuery({
    queryKey: ['copilot:history', projectId, threadId],
    enabled: !!projectId,
    queryFn: async () => {
      const r = (await rpc('copilot:history', { projectId: projectId as string, ...(threadId ? { threadId } : {}) })) as
        | { ok: true; turns: Turn[]; threadId: string | null; title?: string | null }
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

/** What the server calls a conversation nobody has named yet — by a first question or by hand (src/ai/copilot.ts FALLBACK_TITLE). */
export const UNTITLED = 'Conversation';

/** A conversation's row, as the title menu and History both write it. */
export const threadTitle = (t: ThreadSummary): string => t.title || UNTITLED;
export const turnsLabel = (t: ThreadSummary): string => (t.turnCount === 1 ? '1 turn' : `${t.turnCount} turns`);

/** The project's conversations, newest-touched first — one list for the header's switcher and History. */
export function useThreads(projectId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['copilot:threads', projectId],
    enabled: enabled && !!projectId,
    queryFn: () => listThreads(projectId as string),
  });
}

/** Something the composer's `@` can point the Assistant at. */
export interface Mentionable {
  id: string;
  name: string;
}

/**
 * The project's visuals and analyses by name — the lists (and cache entries)
 * the Visuals and Analyses pages read, so opening `@` after either costs no call.
 */
export function useVisualNames(projectId: string) {
  return useQuery({ queryKey: ['visual:list', projectId], queryFn: async () => (await rpc('visual:list', { projectId })) as Mentionable[] });
}
export function useAnalysisNames(projectId: string) {
  return useQuery({ queryKey: ['analysis:gallery', projectId], queryFn: async () => (await rpc('analysis:gallery', { projectId })) as Mentionable[] });
}

export async function newThread(projectId: string): Promise<string> {
  const r = (await rpc('copilot:newThread', { projectId })) as { ok: boolean; thread?: { id: string } };
  return r.ok && r.thread ? r.thread.id : '';
}

/** Rename or delete one of the caller's own conversations; false = it was not there to act on. */
export async function renameThread(projectId: string, threadId: string, title: string): Promise<boolean> {
  return ((await rpc('copilot:renameThread', { projectId, threadId, title })) as { ok: boolean }).ok;
}
export async function deleteThread(projectId: string, threadId: string): Promise<boolean> {
  return ((await rpc('copilot:deleteThread', { projectId, threadId })) as { ok: boolean }).ok;
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
