// The Assistant's calls. Contracts carry inputs only, so every reply is
// narrowed here by hand to what its handler returns (src/ipc/copilot.ts,
// answers.ts, plan.ts, aiModels.ts). Every figure in a reply — a KPI, a
// row count, a turn count — is the server's; the dock only formats it.

import { useEffect } from 'react';
import { useInfiniteQuery, useQuery, type InfiniteData, type QueryClient } from '@tanstack/react-query';
import { rpc, type RpcInput } from '../../api/client';
import { useVerified } from '../model/assistant/api';
import type { Card, CardReply } from './AnswerCard';
import type { SqlTurn } from './AnswerSql';

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
  /** A stored answer spec: what Refresh computes again. */
  answer?: { datasetId: string; title?: string } & Record<string, unknown>;
  /**
   * The card the answer kept, as the server computed it then (src/ipc/answerSnapshots.ts): sent only while the
   * caller's access is what it was computed under. None: the card asks `answer:refresh` (not kept yet, too big
   * to keep, or the access changed).
   */
  card?: Card;
  /** An answer the chart form could not express: the SQL it ran (src/ai/answerSql.ts). Its kept table rides in `card` (./AnswerSql `isSqlCard`). */
  sql?: SqlTurn;
  /** A refused chart's "Did you mean": the server's options, each a complete spec `answer:rerun` takes (src/ai/answerSuggest.ts). */
  suggest?: { part: string; said: string; options: { label: string; spec: Record<string, unknown>; column?: string }[] };
  /** An answer run from a "Did you mean" column: the name that was said, which its card can offer to remember. */
  learn?: { said: string; column: string };
  /** The Visual this answer was saved as ("Save as visual"): its card links there instead of offering to save again. */
  savedVisualId?: string;
  /** How the answer was guided: ids and counts only (src/ai/turnGuidance.ts). None on a chip, a follow-up or an older turn. */
  guidance?: { verifiedId?: string; instructions: number; examples: string[]; narrated?: boolean; documents?: string[]; documentRefs?: { id: string; title: string; gone?: true }[] };
  /** An Assistant agent's out-of-scope reply: the dataset the Project assistant can answer from (src/ipc/agentAsk.ts). */
  outside?: { dataset: string };
  /** What a refused answer needs an editor to add first (src/ai/answerNeeds.ts): the reason Ask an editor carries. */
  needs?: 'link' | 'copy';
  /** A measure or filter name nobody defined (src/ipc/answerCheck.ts): the turn offers "Propose a definition". */
  define?: boolean;
  /** Outcome E for an editor: the link the server checked, which ./LinkCard offers to add. */
  link?: AnswerLink;
  /** Auto picked the agent that answered this: why, in the app's words (src/ai/routeTurn.ts). */
  route?: { why: string };
  /** A deep-research run's turn: the run id (src/ai/researchTurn.ts). Its text is a fixed sentence; the run card reads the rest from `research:get`. */
  research?: { runId: string };
  /** The asker's thumbs up or down on this answer (src/ai/feedback.ts): a value and a reason code, never words of the answer. */
  feedback?: { value: 'up' | 'down'; reason?: string };
}

/** A link the server checked between two datasets (src/ai/answerNeeds.ts `AnswerLink`): every check is the engine's. */
export interface AnswerLink {
  from: { datasetId: string; dataset: string; column: string };
  to: { datasetId: string; dataset: string; column: string };
  cardinality: 'many_to_one' | 'one_to_one';
  checks: { names: boolean; types: boolean; foundPct: number | null; unique: boolean };
  /** The counts were taken inside the date range a Live table requires: the server's sentence, said under the checks. */
  note?: string;
  /** Why the link can't be saved here (a Live side no one engine can count with the other): the card offers no Add. */
  blocked?: string;
  /** With `blocked`: the Live datasets whose copies would let it be saved — the card's "Make a copy" (the Live copy flow). */
  copy?: string[];
}

/** The Assistant agent a conversation is with (null: the Project assistant); `gone` once it was deleted. */
export type ConversationAgent = { id: string; name: string; gone?: boolean } | null;

export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
  turnCount: number;
  /** The Assistant agent it is with, by name (absent: the Project assistant); `agentGone` once that agent was deleted. */
  agentId?: string;
  agentName?: string;
  agentGone?: boolean;
}

export interface ActivityStep {
  kind: 'read' | 'compute' | 'quality' | 'model' | 'inventory';
  label: string;
  detail?: string;
}

/** What a turn proposes next (src/ai/suggestedAction.ts). The dock acts on `plan`, `import` and `dashboard`. */
export interface SuggestedAction {
  kind: string;
  intent: string;
  steps?: unknown[];
  droppedSteps?: number;
}

/** An agent Auto could not tell apart from another for this question (src/ipc/agentRoute.ts): the person picks. */
export interface AgentChoice { id: string; name: string; description?: string }

export type AskReply =
  | { ok: true; answer: string; turns: Turn[]; threadId: string | null; suggestedAction?: SuggestedAction; agent?: ConversationAgent }
  /** Auto: two or three agents fit about equally. Nothing was asked or stored. */
  | { ok: true; choose: AgentChoice[] }
  | { ok: false; notReady?: boolean; error?: string };

/** What the dock is looking at — resolved inside the project by the server (buildFacts). `offset`: a scorecard's period, in periods back. */
export type Ask = { kind: RpcInput<'copilot:ask'>['context']['kind']; id?: string; offset?: number };

/** One hook for every AI surface: the dock, Home, Analyses, Visuals, captures. */
export function useAiStatus(enabled = true) {
  return useQuery({
    queryKey: ['ai:status'],
    queryFn: async () => (await rpc('ai:status')) as AiStatus,
    enabled,
    // A surface mounted after the first reply (Home's ask bar beside the dock) reads it instead of
    // asking again. A change is pushed (`key:changed`) or invalidated by the door that made it.
    staleTime: 30_000,
  });
}

const READY_HINT = 'ordinate.aiReady';

/**
 * Whether a model is ready, for the rail's Assistant entry (Shell.tsx), with no request of its own: the rail is
 * on every page, and a page already at its RPC budget (e2e rpcBudget) has no room for one. The status an AI
 * surface fetched (Home's ask bar, Explore, the dock, the Assistant's page), else what this browser saw last.
 * shortcut: one hint per browser, not per org; a stale one shows the entry until an AI surface refetches, and
 * the page it opens explains itself. Upgrade by carrying the flag on a reply the shell already reads.
 */
export function useAiReady(): boolean {
  const known = useAiStatus(false).data?.ready;
  useEffect(() => {
    if (known === undefined) return;
    try {
      localStorage.setItem(READY_HINT, known ? '1' : '0');
    } catch {
      // storage blocked: the next page load waits for an AI surface again
    }
  }, [known]);
  if (known !== undefined) return known;
  try {
    return localStorage.getItem(READY_HINT) === '1';
  } catch {
    return false;
  }
}

/** The caller's own pick (`ai:setMine`); refused unless the admin enabled it. */
export async function setMyModel(provider: Provider, model: string): Promise<boolean> {
  return ((await rpc('ai:setMine', { provider, model })) as { ok: boolean }).ok;
}

export function useHistory(projectId: string | null, threadId: string) {
  return useQuery({
    queryKey: ['copilot:history', projectId, threadId],
    enabled: !!projectId,
    // The dock seeds a new conversation's key from copilot:ask's reply (setTurns); without this
    // it fetched those same turns again the moment it switched to that key.
    staleTime: 30_000,
    queryFn: async () => {
      const r = (await rpc('copilot:history', { projectId: projectId as string, ...(threadId ? { threadId } : {}) })) as
        | { ok: true; turns: Turn[]; threadId: string | null; title?: string | null; agent?: ConversationAgent }
        | { ok: false; error?: string };
      if (!r.ok) throw new Error(r.error || 'Could not load the conversation.');
      return r;
    },
  });
}

/** An answer of the caller's conversation computed now and kept in place of its card (`answer:refresh`). */
export async function refreshAnswer(projectId: string, threadId: string, turnId: string): Promise<CardReply> {
  return (await rpc('answer:refresh', { projectId, threadId, turnId })) as CardReply;
}

/** The conversation's copy of a turn now carries `card`, so the card draws it, a remount included, with no call. */
export function keepInConversation(qc: QueryClient, projectId: string, turnId: string, card: Card): void {
  type History = { ok: true; turns: Turn[] } & Record<string, unknown>;
  qc.setQueriesData<History>({ queryKey: ['copilot:history', projectId] }, (old) =>
    old?.ok && old.turns.some((t) => t.id === turnId) ? { ...old, turns: old.turns.map((t) => (t.id === turnId ? { ...t, card } : t)) } : old,
  );
}

/** One page of the caller's conversations, and the cursor of the page after it (null: the last). */
export interface ThreadPage {
  threads: ThreadSummary[];
  next: string | null;
}

export async function listThreads(projectId: string, cursor?: string): Promise<ThreadPage> {
  const r = (await rpc('copilot:threads', { projectId, ...(cursor ? { cursor } : {}) })) as { ok: boolean; threads?: ThreadSummary[]; next?: string | null };
  return { threads: r.ok && Array.isArray(r.threads) ? r.threads : [], next: r.ok && typeof r.next === 'string' ? r.next : null };
}

const allLoaded = (d: InfiniteData<ThreadPage, string>): ThreadSummary[] => d.pages.flatMap((p) => p.threads);

/** What the server calls a conversation nobody has named yet — by a first question or by hand (src/ai/copilot.ts FALLBACK_TITLE). */
export const UNTITLED = 'Conversation';

/** A conversation's row, as the title menu and History both write it. */
export const threadTitle = (t: ThreadSummary): string => t.title || UNTITLED;
export const turnsLabel = (t: ThreadSummary): string => (t.turnCount === 1 ? '1 turn' : `${t.turnCount} turns`);

/**
 * The project's conversations, newest-touched first — one list for the header's switcher and History.
 * The server sends them a page at a time: `data` is every page loaded so far, `fetchNextPage()` the
 * next one while `hasNextPage` (History.tsx `MoreThreads`).
 */
export function useThreads(projectId: string | null, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['copilot:threads', projectId],
    enabled: enabled && !!projectId,
    initialPageParam: '',
    queryFn: ({ pageParam }) => listThreads(projectId as string, pageParam || undefined),
    getNextPageParam: (last) => last.next ?? undefined,
    select: allLoaded,
  });
}

export type Threads = ReturnType<typeof useThreads>;

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

/** `agentId`: the Assistant agent it is with; null or absent, the Project assistant. */
export async function newThread(projectId: string, agentId?: string | null): Promise<string> {
  const r = (await rpc('copilot:newThread', { projectId, ...(agentId ? { agentId } : {}) })) as { ok: boolean; thread?: { id: string } };
  return r.ok && r.thread ? r.thread.id : '';
}

/** Rename or delete one of the caller's own conversations; false = it was not there to act on. */
export async function renameThread(projectId: string, threadId: string, title: string): Promise<boolean> {
  return ((await rpc('copilot:renameThread', { projectId, threadId, title })) as { ok: boolean }).ok;
}
export async function deleteThread(projectId: string, threadId: string): Promise<boolean> {
  return ((await rpc('copilot:deleteThread', { projectId, threadId })) as { ok: boolean }).ok;
}

/**
 * `agentId`: the agent a conversation this ask STARTS is with (no `threadId`); an existing one keeps its own.
 * `skipVerified`: "Not what I asked" on a verified answer, so the model takes the same question.
 */
export async function ask(
  projectId: string, context: Ask, question: string, threadId: string, askId: string, agentId?: string | null, skipVerified = false, auto = false,
): Promise<AskReply> {
  return (await rpc('copilot:ask', {
    projectId,
    context: { kind: context.kind, ...(context.id ? { id: context.id } : {}), ...(context.offset ? { offset: context.offset } : {}) },
    question,
    ...(threadId ? { threadId } : {}),
    askId,
    ...(!threadId && agentId && !auto ? { agentId } : {}),
    ...(auto ? { auto: true } : {}),
    ...(skipVerified ? { skipVerified: true } : {}),
  })) as AskReply;
}

export async function setAssistantEnabled(enabled: boolean): Promise<void> {
  await rpc('copilot:setEnabled', { enabled });
}

/** A verified question the dock and Home offer as a chip: it runs, and its spec is shown to this caller. */
export interface VerifiedChip {
  question: string;
  spec: { datasetId: string } & Record<string, unknown>;
}
const MAX_CHIPS = 4;

/**
 * The first 4 verified questions that run, the context's dataset first. A chip is an extra: an old pod's 404 or any
 * error gives none, with no error state. ONE read of the project's list (newest first), shared by Home and the dock
 * and kept a minute, so a page load asks once (its RPC budget); the context's dataset goes first here, the stable
 * order `verified:list` gives a `datasetId`.
 */
export function useVerifiedChips(projectId: string | null | undefined, datasetId?: string): VerifiedChip[] {
  const q = useVerified(projectId ?? '', undefined, { enabled: !!projectId, retry: false, staleTime: 60_000 });
  const rows = (q.data?.questions ?? []).flatMap((r) => (r.runs && r.spec ? [{ question: r.question, spec: r.spec }] : []));
  const first = (c: VerifiedChip): number => (c.spec.datasetId === datasetId ? 0 : 1);
  return (datasetId ? rows.sort((a, b) => first(a) - first(b)) : rows).slice(0, MAX_CHIPS);
}
