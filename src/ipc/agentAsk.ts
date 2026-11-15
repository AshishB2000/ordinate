// An Assistant agent's part in one `copilot:ask` (docs/assistant-agents/00-design.md, "The ask"). MAIN PROCESS ONLY.
//
// `askScope` is who answers (src/ai/agentAccess.ts `agentForAsk`, the one place that decides) and what they answer
// from: an agent's topic narrows the facts to its datasets, metrics and terms (the topic context buildFacts already
// has), its examples first, and the datasets an answer may name. It only narrows: every reader below is still the
// caller's own, under their row lock and hidden columns.
//
// OUT OF SCOPE (rule 10) is code: when the model says the topic does not hold the question's data (the `outside`
// action) or writes an answer on a dataset outside it, `outsideTurn` looks for the data among the datasets OUTSIDE the
// topic that the caller can read — through step 3's index, names only: no row is read and no figure is computed for it —
// and offers the Project assistant. One the caller cannot read is never named.

import { readTopic, topicForReaders } from '../analysis/topics';
import * as visuals from '../analysis/visuals';
import * as datasets from '../data/datasets';
import { rowLockFor } from '../data/rowAccess';
import { isRowPolicyError } from '../data/rowPolicyError';
import { searchModel, type ModelHit, type SearchOptions } from './assistantSearch';
import { agentForAsk } from '../ai/agentAccess';
import type { Agent } from '../ai/agents';
import * as msg from '../ai/agentMessages';
import type { SuggestedAction } from '../ai/suggestedAction';
import { ctx } from '../server/context';
import { namedDataset } from './answers';

export interface AskScope {
  /** The agent that answers; null: the Project assistant. */
  agent: Agent | null;
  /** Why it fell back to the Project assistant, said above the answer; null when it did not. */
  note: string | null;
  /** The topic's datasets (gone ones left out): all an answer may name. Null: all data. */
  only: ReadonlySet<string> | null;
  topic: { id: string; name: string } | null;
}

export const PROJECT_SCOPE: AskScope = { agent: null, note: null, only: null, topic: null };

/** Who answers an ask in a conversation with `agentId`, and from what. A personal API token always gets the Project assistant (rule 13). */
export async function askScope(projectId: string, agentId: string | null | undefined): Promise<AskScope> {
  if (ctx().via === 'token') return PROJECT_SCOPE;
  const { agent, note } = await agentForAsk(projectId, agentId);
  if (!agent || !agent.topicId) return { ...PROJECT_SCOPE, agent, note };
  const stored = await readTopic(projectId, agent.topicId);
  if (!stored) return { ...PROJECT_SCOPE, agent, note }; // its topic is in the Trash: all data, until one is picked again
  const { topic } = await topicForReaders(projectId, stored.rec);
  return { agent, note, only: new Set(topic.datasets.map((d) => d.id)), topic: { id: topic.id, name: topic.name } };
}

type ContextRef = { kind?: string; id?: string; offset?: number; stats?: unknown; scoped?: boolean };

/** What the facts are built from: the screen's own when it is a dataset (or a visual of one) in the topic, else the topic. */
export async function scopedContext(projectId: string, scope: AskScope, context: ContextRef): Promise<ContextRef> {
  if (!scope.only || !scope.topic) return context;
  if (context.kind === 'dataset' && context.id && scope.only.has(context.id)) return context;
  if (context.kind === 'visual' && context.id) {
    const v = await visuals.getVisual(projectId, context.id);
    if (v && scope.only.has(v.datasetId)) return context;
  }
  return { kind: 'topic', id: scope.topic.id, scoped: true };
}

/** May the caller read `datasetId`'s rows at all? Its row rules give them none (or it is built from such a dataset): no. */
async function readable(projectId: string, datasetId: string): Promise<boolean> {
  try {
    await rowLockFor(projectId, datasetId);
    return true;
  } catch (err) {
    if (isRowPolicyError(err)) return false;
    throw err;
  }
}

/** Ranked items read for the outside-the-topic check: datasets, columns, metrics and terms. */
const OUTSIDE_HITS = 60;

/**
 * The readable dataset OUTSIDE the topic that best matches the question: step 3's search (./assistantSearch) with the
 * topic's datasets left out, each dataset scored by the sum of its own, its columns', its metrics' and its terms' matches
 * (ties in rank order), the first the caller can read. Metadata only; a column hidden from them finds nothing. Null when
 * nothing outside the topic shares a word with the question. `canRead` and `search` are for scripts/test-agentOutside.ts
 * and scripts/test-askIndex.ts (the index against the reference).
 */
export async function matchOutside(
  projectId: string, question: string, only: ReadonlySet<string>, canRead = readable,
  search: (p: string, q: string, o: SearchOptions) => Promise<ModelHit[]> = searchModel,
): Promise<{ id: string; name: string } | null> {
  const hits = await search(projectId, question, { kinds: ['dataset', 'column', 'metric', 'term'], limit: OUTSIDE_HITS, exceptDatasetIds: [...only] });
  const score = new Map<string, number>();
  // A hit found by meaning alone (no word, score 0) never qualifies: meaning may reorder what the words found, not offer more.
  for (const h of hits) if (h.score > 0 && h.datasetId && !only.has(h.datasetId)) score.set(h.datasetId, (score.get(h.datasetId) ?? 0) + h.score);
  for (const [id] of [...score].sort((a, b) => b[1] - a[1])) { // stable: an equal score keeps the better-ranked first
    if (!(await canRead(projectId, id))) continue;
    const meta = await datasets.getDatasetMeta(projectId, id);
    if (meta) return { id, name: meta.name };
  }
  return null;
}

/** The out-of-scope turn: the app's words, and the dataset the Project assistant can answer from, if there is one. */
export interface OutsideTurn {
  text: string;
  outside?: { dataset: string };
}

/**
 * Null when the reply is the agent's to give (no topic, or an answer inside it). Otherwise the turn that says so: the
 * dataset an outside answer named if the caller can read it, else the best match outside the topic, else nowhere.
 */
export async function outsideTurn(projectId: string, scope: AskScope, question: string, action: SuggestedAction): Promise<OutsideTurn | null> {
  if (!scope.only || !scope.topic) return null;
  let found: { id: string; name: string } | null = null;
  if (action.kind === 'answer') {
    const named = await namedDataset(projectId, action);
    if (!named || scope.only.has(named)) return null; // inside it, or no dataset at all: the answer's own gate decides
    if (await readable(projectId, named)) found = { id: named, name: (await datasets.getDatasetMeta(projectId, named))?.name ?? '' };
  } else if (action.kind !== 'outside') return null;
  found = found?.name ? found : await matchOutside(projectId, question, scope.only);
  const head = msg.outsideTopic(scope.topic.name);
  return found ? { text: `${head}\n${msg.outsideOffer(found.name)}`, outside: { dataset: found.name } } : { text: `${head}\n${msg.outsideNowhere()}` };
}
