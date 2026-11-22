// The embedded Assistant's ask (docs/embedded-assistant/00-design.md, "The ask"): a thin path over an explicit
// allow-list of readers, inside an embed asker's request context (src/server/embed/asker.ts). NOT `copilot:ask`:
// that one saves threads, snapshots and verified answers, and falls back to the Project assistant.
//
// Facts are the schema of the embeddable datasets only (no sample value, no profile, no count of rows, no project
// name). The agent's own instructions are the only guidance. Only an `answer` action goes on (no SQL, no plan);
// the chart is built by the app through the doors, under the token's lock (`rowLockFor`). Nothing is saved.

import { embedAsker } from '../server/context';
import * as execConfig from '../app/execConfig';
import * as copilot from '../ai/copilot';
import { askCopilot } from '../ai/analyze';
import { allowedAction } from '../ai/suggestedAction';
import { readAgent } from '../ai/agents';
import { readTopic, topicForReaders } from '../analysis/topics';
import { guidanceBlock } from '../ai/guidanceFacts';
import * as datasets from '../data/datasets';
import { hiddenColumnsFor, isRowPolicyError, rowLockFor } from '../data/rowAccess';
import { dropHidden, tableWithout } from '../ai/hiddenFacts';
import { assistantColumnDocs } from '../app/sharePolicy';
import { tableFacts } from '../app/tableDocs';
import type { LedgerEntry } from '../ai/numberAudit';
import { answerFromAction } from './answers';
import { guardAnswer } from './copilot';
import { embedAskBlank, embedAskFailed, embedAskNoData, embedAskNotReady, embedAskOutside, embedAskUnavailable } from '../server/embedAskMessages';

export const MAX_QUESTION = 1000;
export const MAX_HISTORY = 10;
const MAX_TURN = 2000;

/** The card a customer's page draws: a whitelist. No steps, chips or `uses` (they call RPCs an embed asker has not), no spec. */
export interface EmbedCard {
  title: string; chartType: string; datasetName: string; data: unknown; caption: string; headline: unknown; bullets: string[]; filterLabels: string[]; notes: string[]; asOf?: unknown;
}

export type EmbedReply = { ok: true; text: string; card: EmbedCard | null } | { ok: false; error: string; kind: 'not_ready' | 'unavailable' | 'no_data' | 'failed' | 'blank' };

const fail = (kind: Extract<EmbedReply, { ok: false }>['kind'], error: string): EmbedReply => ({ ok: false, kind, error });

/** What the client sent as the conversation so far: text only, bounded, never trusted as more than a question. */
export function cleanHistory(raw: unknown): { role: 'user' | 'assistant'; text: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { role: 'user' | 'assistant'; text: string }[] = [];
  for (const t of raw.slice(-MAX_HISTORY)) {
    const e = t as { role?: unknown; text?: unknown } | null;
    if (e && (e.role === 'user' || e.role === 'assistant') && typeof e.text === 'string' && e.text.trim()) out.push({ role: e.role, text: e.text.slice(0, MAX_TURN) });
  }
  return out;
}

function card(c: Record<string, unknown>): EmbedCard {
  return {
    title: String(c.title ?? ''), chartType: String(c.chartType ?? ''), datasetName: String(c.datasetName ?? ''), data: c.data, caption: String(c.caption ?? ''), headline: c.headline,
    bullets: Array.isArray(c.bullets) ? c.bullets.map(String) : [], filterLabels: Array.isArray(c.filterLabels) ? c.filterLabels.map(String) : [], notes: Array.isArray(c.notes) ? c.notes.map(String) : [],
    ...(c.asOf ? { asOf: c.asOf } : {}),
  };
}

/** The datasets the lock holds on right now: a marked one that cannot honour it (a changed pipeline, a missing column) is left out. */
async function usableDatasets(projectId: string, ids: readonly string[]): Promise<datasets.DatasetMeta[]> {
  const out: datasets.DatasetMeta[] = [];
  for (const id of ids) {
    try {
      await rowLockFor(projectId, id);
    } catch (err) {
      if (isRowPolicyError(err)) continue;
      throw err;
    }
    const m = await datasets.getDatasetMeta(projectId, id);
    if (m) out.push(m);
  }
  return out;
}

/** The facts: schema only (names, declared types, the editors' notes), then the closing line. No row-derived text. */
async function factsOf(projectId: string, metas: readonly datasets.DatasetMeta[]): Promise<{ text: string; ledger: LedgerEntry[] }> {
  const schemas = [];
  for (const m of metas) {
    const hidden = await hiddenColumnsFor(projectId, m.id);
    schemas.push({ name: m.name, columns: dropHidden(m.columns, hidden), docs: await assistantColumnDocs(projectId, m.id), table: tableWithout(await tableFacts(projectId, m.id), hidden) });
  }
  const base = copilot.projectFacts('Your data', { datasets: metas.map((m) => m.name), visuals: [], dashboards: [] }, schemas);
  const text = base.text.split('\n').filter((l) => !/^(Visuals|Dashboards) \(0\): \(none\)\.$/.test(l) && !l.startsWith('Project: ')).join('\n');
  return { text, ledger: base.ledger };
}

/**
 * One question, inside the embed asker's context. Never throws: a failure is a reply. `signal`: the time limit. The model call takes
 * no signal, so the ask is RACED against it: when it fires, the customer gets the failure sentence at once (the call finishes on its own).
 */
export async function embedAsk(question: string, history: unknown, signal?: AbortSignal): Promise<EmbedReply> {
  if (!signal) return run(question, history, signal);
  if (signal.aborted) return fail('failed', embedAskFailed());
  let onAbort: () => void = () => undefined;
  const timeout = new Promise<EmbedReply>((resolve) => {
    onAbort = () => resolve(fail('failed', embedAskFailed()));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([run(question, history, signal), timeout]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function run(question: string, history: unknown, signal?: AbortSignal): Promise<EmbedReply> {
  const who = embedAsker();
  if (!who) return fail('unavailable', embedAskUnavailable());
  try {
    const q = question.trim().slice(0, MAX_QUESTION);
    if (!q) return fail('blank', embedAskBlank());
    const stored = await readAgent(who.projectId, who.agentId);
    if (!stored) return fail('unavailable', embedAskUnavailable()); // never a fall-back to the Project assistant
    const agent = stored.rec;
    if (!execConfig.assistantOn()) return fail('not_ready', embedAskNotReady());
    // The marking, narrowed by the agent's topic when it has one (a topic only narrows). A topic in the Trash narrows nothing: the marking is the limit.
    const topic = agent.topicId ? await readTopic(who.projectId, agent.topicId) : null;
    const inTopic = topic ? new Set((await topicForReaders(who.projectId, topic.rec)).topic.datasets.map((d) => d.id.toLowerCase())) : null;
    const metas = await usableDatasets(who.projectId, Object.keys(who.datasets).filter((id) => !inTopic || inTopic.has(id)));
    if (!metas.length) return fail('no_data', embedAskNoData());
    const only = new Set(metas.map((m) => m.id));
    const facts = await factsOf(who.projectId, metas);
    const guided = guidanceBlock({ instructions: [], agent: { name: agent.name, instructions: agent.instructions.map((i) => i.text) } });
    const ledger = facts.ledger.concat(guided.ledger);
    if (signal?.aborted) return fail('failed', embedAskFailed());
    const res = await askCopilot(cleanHistory(history), [facts.text, guided.text].filter(Boolean).join('\n\n'), q, undefined, { build: false, topic: true, model: agent.model });
    if (!res.ok) return res.errorType === 'not_ready' ? fail('not_ready', embedAskNotReady()) : fail('failed', embedAskFailed());
    const action = allowedAction(res.suggestedAction, { build: false, topic: true });
    if (action.kind === 'outside') return { ok: true, text: embedAskOutside(), card: null };
    let built: Awaited<ReturnType<typeof answerFromAction>> | null = null;
    // Only `answer`: sql and every other action are dropped here, server side.
    if (action.kind === 'answer') {
      const ctxRef = metas.length === 1 ? { kind: 'dataset', id: metas[0].id } : {};
      built = await answerFromAction(who.projectId, ctxRef, action, q, undefined, undefined, only);
    }
    const ok = built && built.ok ? built : null;
    const refused = built && !built.ok ? built.reason : null;
    const guarded = guardAnswer(refused ? `${res.text}\n\n${refused}` : res.text, ok ? ledger.concat(ok.ledger) : ledger);
    return { ok: true, text: guarded.text, card: ok ? card(ok.card as unknown as Record<string, unknown>) : null };
  } catch (err) {
    // Typed refusals say nothing about data; anything else is not echoed.
    return isRowPolicyError(err) ? fail('no_data', embedAskNoData()) : fail('failed', embedAskFailed());
  }
}
