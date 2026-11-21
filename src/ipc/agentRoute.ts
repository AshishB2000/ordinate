// The agent router (docs/agent-router/00-design.md): which of the agents a person may use answers a question, when they have
// not picked one ("Auto"). MAIN PROCESS ONLY. The scores are ../ai/agentRoute (pure); this reads what they compare, from
// the same doors an ask uses: ONE search of the Data model for the project (never one per agent), the verified questions the
// caller may see, one query for the agents' document titles, the agents' topics as the caller may read them.
//
// Only the agents in `usable` (agentsFor, `mayUse`) are read, scored, offered or named. A model is called only when two agents
// are close: one call with the question and the two agents' names and descriptions, counted against the person's budget.

import { listBoth } from '../analysis/verifiedQuestions';
import { readTopic, topicsForReaders } from '../analysis/topics';
import { decide, scoreAgents, whyOf, type RouteAgent, type RouteHit, type RouteVerified } from '../ai/agentRoute';
import { parseRoute, routeUser, ROUTE_SYSTEM } from '../ai/agentRoutePrompt';
import * as msg from '../ai/agentRouteMessages';
import { agentsFor, preselect } from '../ai/agentAccess';
import type { Agent } from '../ai/agents';
import * as copilot from '../ai/copilot';
import * as analyze from '../ai/analyze';
import * as execConfig from '../app/execConfig';
import { titlesByAgent } from '../knowledge/store';
import { ctx } from '../server/context';
import { searchModel } from './assistantSearch';

export type Route =
  /** `why`: the app's sentence from the matches. */
  | { kind: 'agent'; agentId: string; why: string }
  /** Two or three agents too close to tell: the person picks (the web), nothing is answered yet. */
  | { kind: 'choose'; options: Array<{ id: string; name: string; description?: string }> }
  /** Nothing to compare (fewer than two agents, or no agent matches): the usual pick stands. */
  | { kind: 'none' };

export interface RouteDeps {
  search(projectId: string, question: string): Promise<RouteHit[]>;
  verified(projectId: string): Promise<RouteVerified[]>;
  titles(projectId: string, agentIds: readonly string[]): Promise<Map<string, string[]>>;
  /** The small model call between two agents: 0 (the first), 1 (the second), null (neither, or it could not). */
  pick(question: string, a: Agent, b: Agent): Promise<0 | 1 | null>;
}

const SEARCH_LIMIT = 200;

const defaults: RouteDeps = {
  search: (projectId, question) => searchModel(projectId, question, { kinds: ['dataset', 'column', 'metric', 'term'], limit: SEARCH_LIMIT }),
  // shortcut: one read of every verified question the caller may see (the index ranks one dataset at a time); upgrade to a word-ranked index query past a few thousand.
  verified: async (projectId) => {
    const both = await listBoth(projectId);
    return [
      ...both.spec.map(({ rec: q }) => ({ texts: [q.question, ...q.phrasings], datasetIds: [q.spec.datasetId] })),
      ...both.sql.map(({ rec: q }) => ({ texts: [q.question, ...q.phrasings], datasetIds: q.sql.datasetIds })),
    ];
  },
  titles: titlesByAgent,
  pick: modelPick,
};

/** The model call. Null without a model, over the person's budget, on an error or on a reply that is not a clear 1 or 2. */
async function modelPick(question: string, a: Agent, b: Agent): Promise<0 | 1 | null> {
  try {
    if (!(execConfig.assistantOn() && (await execConfig.executionReady()))) return null;
    const { underBudget } = require('../server/slack/ask') as typeof import('../server/slack/ask'); // lazy: slack/ask reaches the handlers that reach this module
    const who = ctx();
    if (!underBudget(who.org.id, who.user.email)) return null;
    const out = await analyze.dispatch(ROUTE_SYSTEM, [{ role: 'user', text: routeUser(question, { name: a.name, description: a.description ?? '' }, { name: b.name, description: b.description ?? '' }) }], undefined, { prose: true });
    return out.error ? null : parseRoute(out.rawText);
  } catch {
    return null;
  }
}

/** Each agent's topic as the caller may read it: its datasets with the fields kept, its metrics and terms. A gone topic: none (all data). */
async function topicsOf(projectId: string, agents: readonly Agent[]): Promise<Map<string, { datasets: Map<string, readonly string[] | null>; metricIds: Set<string>; termIds: Set<string> }>> {
  const out = new Map<string, { datasets: Map<string, readonly string[] | null>; metricIds: Set<string>; termIds: Set<string> }>();
  const stored = await Promise.all(agents.map(async (a) => (a.topicId ? { a, t: await readTopic(projectId, a.topicId) } : null)));
  const live = stored.flatMap((s) => (s && s.t ? [{ a: s.a, rec: s.t.rec }] : []));
  const read = await topicsForReaders(projectId, live.map((l) => l.rec));
  live.forEach((l, i) => {
    const { topic } = read[i];
    out.set(l.a.id, { datasets: new Map(topic.datasets.map((d) => [d.id, d.fields ?? null] as const)), metricIds: new Set(topic.metricIds), termIds: new Set(topic.termIds) });
  });
  return out;
}

/**
 * The agent that answers `question` among `usable`, or what to do when it cannot say. `unsure`: a close call the model cannot
 * settle goes to the person (`ask`, the web's buttons) or to the agent with more matches (`best`, a Slack direct message, where
 * there is nobody to click). `usable` is the caller's own (agentsFor): the one filter by `mayUse`.
 */
export async function routeAsk(projectId: string, question: string, usable: readonly Agent[], unsure: 'ask' | 'best', deps: Partial<RouteDeps> = {}): Promise<Route> {
  if (usable.length < 2) return { kind: 'none' };
  const d = { ...defaults, ...deps };
  const topics = await topicsOf(projectId, usable);
  const [hits, verified, titles] = await Promise.all([
    topics.size ? d.search(projectId, question) : Promise.resolve([]),
    topics.size ? d.verified(projectId) : Promise.resolve([]),
    d.titles(projectId, usable.map((a) => a.id)),
  ]);
  const agents: RouteAgent[] = usable.map((a) => {
    const t = topics.get(a.id);
    return { id: a.id, description: a.description ?? '', datasets: t?.datasets ?? null, metricIds: t?.metricIds ?? new Set(), termIds: t?.termIds ?? new Set(), titles: titles.get(a.id) ?? [] };
  });
  const scored = scoreAgents(question, agents, hits, verified);
  const decision = decide(scored);
  if (decision.kind === 'none') return { kind: 'none' };
  if (decision.kind === 'clear') return { kind: 'agent', agentId: decision.id, why: whyOf(scored[0]) };
  const byId = new Map(usable.map((a) => [a.id, a] as const));
  const [first, second] = decision.ids.map((id) => byId.get(id)!);
  const picked = await d.pick(question, first, second);
  if (picked !== null) return { kind: 'agent', agentId: (picked === 0 ? first : second).id, why: msg.routeModelPicked() };
  if (unsure === 'best') return { kind: 'agent', agentId: first.id, why: msg.routeMoreMatches() };
  return { kind: 'choose', options: decision.ids.map((id) => byId.get(id)!).map((a) => ({ id: a.id, name: a.name, ...(a.description ? { description: a.description } : {}) })) };
}

/** What an Auto ask does: the agent (null: the Project assistant) with its reason, or the agents to offer. Null: Auto does not apply. */
export type Auto = { agentId: string | null; why?: string } | { choose: Array<{ id: string; name: string; description?: string }> } | null;

/**
 * `copilot:ask` with `auto`. Only for a conversation with no turns yet (`blank`, or none at all), never for a personal API token
 * (it always gets the Project assistant), and only for a person with two or more agents: anyone else is unchanged. Nothing to
 * compare leaves the conversation as it is, else the usual pick (src/ai/agentAccess.ts `preselect`).
 */
export async function autoRoute(projectId: string, question: string, into: copilot.ThreadRef | null, blank: boolean): Promise<Auto> {
  if (ctx().via === 'token' || (into && !blank)) return null;
  const { usable, teams } = await agentsFor(projectId);
  if (usable.length < 2) return null;
  const r = await routeAsk(projectId, question, usable, 'ask');
  if (r.kind === 'choose') return { choose: r.options };
  if (r.kind === 'agent') return { agentId: r.agentId, why: r.why };
  return { agentId: into ? (into.agentId ?? null) : preselect(usable, teams, (await copilot.threadFor(projectId))?.agentId) };
}
