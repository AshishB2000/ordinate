// A Slack question, asked the way the app asks it: the SAME registered `copilot:ask` handler, as the linked user, with
// the org's configured model. Slack carries text in and out only; nothing is built from Slack (no `askId`, so no
// streaming, and any `suggestedAction` that is not an answer is ignored).
//
// Calling a handler skips the RPC layer, so this does what the layer does first: `authorize()` for that user on the
// contract and the project (a refusal answers "denied", the handler never called), the same per-user budget and the same
// time limit (an aborted ask stops its DuckDB queries). The contract does not take `context.noSources`: only this server
// code sets it, after the input has parsed, so that a Slack question is never offered the project's SOURCE TABLES (an
// answer over one names a document id no folder, row rule or column rule is recorded for: src/ipc/sourceAnswers.ts).
//
// What an answer showed comes from the STORED turns, not the browser reply (which strips them): every assistant turn of
// the conversation the model was replayed (`openTurns`), because the handler hands the earlier turns' words to the model,
// which may quote them: the union of `shows()` and `dashboardsFrom`.

import type { Pool } from 'pg';
import { contractFor } from '../../api/index';
import { authorize } from '../authz/index';
import { seedRank } from '../authz/caller';
import { runInContext, type Identity } from '../context';
import { handlers } from '../rpc';
import { untilAborted } from '../limits';
import * as copilot from '../../ai/copilot';
import { agentsFor, preselect } from '../../ai/agentAccess';
import { askScope } from '../../ipc/agentAsk';
import { routeAsk } from '../../ipc/agentRoute';
import { openTurns, shows } from '../../ipc/turnsOpen';
import * as projects from '../../app/projects';
import { inOrg } from '../db/inOrg';
import { slackLimits } from './db';

/** `why`: the router's reason for `agentId` (a direct message with Auto), kept on the answer's turn. */
export interface Target { projectId: string; agentId: string | null; threadId?: string; why?: string }

/** A card as the browser gets it (src/ipc/answerSnapshots.ts): a chart's, or an SQL answer's table. Read, never written. */
export type Card = Record<string, any>; // any: AnswerCard | SqlCard, told apart by `kind`

export interface Shown {
  datasetIds: string[]; dashboardIds: string[];
  /** Some turn of the conversation answered from a source table (never posted in a channel). */
  sourceTable: boolean;
  /** The answer is the app's "outside the topic" reply (never posted in a channel). */
  outside: boolean;
}

export type Asked =
  | ({ ok: true; text: string; card: Card | null; turnId: string; threadId: string; projectId: string; agentName: string | null } & Shown)
  | { ok: false; reason: 'denied' | 'not_ready' | 'failed' | 'no_project' | 'limited' | 'agent' | 'timeout' };

/** What an assistant turn (or a replayed set of them) showed. */
export async function shownBy(projectId: string, history: readonly copilot.CopilotTurn[]): Promise<Shown & { last: copilot.CopilotTurn | undefined }> {
  const replayed = (await openTurns(projectId, history)).filter((t) => t.role === 'assistant'); // the turns the handler replayed to the model
  const last = [...history].reverse().find((t) => t.role === 'assistant');
  const all = last && !replayed.includes(last) ? [...replayed, last] : replayed;
  return {
    last,
    datasetIds: [...new Set(all.flatMap((t) => shows(t)))],
    dashboardIds: [...new Set(all.flatMap((t) => t.dashboardsFrom ?? []))],
    sourceTable: all.some((t) => t.answer?.table !== undefined || t.sql?.table !== undefined),
    outside: !!last?.outside,
  };
}

// The per-user budget the RPC layer applies (RATE_LIMIT_RPC_PER_MINUTE), per pod like its buckets.
const recent = new Map<string, number[]>();
export function underBudget(org: string, email: string): boolean {
  const key = `${org}\u0000${email}`;
  const now = Date.now();
  const mine = (recent.get(key) ?? []).filter((t) => now - t < 60_000);
  if (mine.length >= slackLimits().perMinute) {
    recent.set(key, mine);
    return false;
  }
  mine.push(now);
  recent.set(key, mine);
  if (recent.size > 5000) for (const k of recent.keys()) { recent.delete(k); break; }
  return true;
}

/** Test hook: every person's count starts again. */
export function _clearBudgetForTest(): void {
  recent.clear();
}

/** Does `who` pass the RPC layer's check for `copilot:ask` on `projectId`? Inside `who`'s request context. */
export async function mayAsk(pool: Pool, who: Identity, projectId: string): Promise<boolean> {
  const contract = contractFor('copilot:ask');
  if (!contract) return false;
  const d = await authorize(contract, { projectId }, who, pool);
  if (d.ok && d.rank !== undefined) seedRank(projectId, d.rank);
  return d.ok;
}

/**
 * A direct message has no project: the project of the person's latest conversation they may still ask in, else the
 * first project they may ask in (the newest updated). The agent is the router's pick for the question when the person may
 * use two or more (docs/agent-router: nobody to click here, so a close call the model cannot settle takes the agent with more
 * matches), else the composer's preselection (src/ai/agentAccess.ts). Inside the person's request context.
 */
export async function directTarget(pool: Pool, who: Identity, question: string): Promise<Target | null> {
  const mine = (await projects.listProjects()).filter((p) => !p.archivedAt);
  const latest = await inOrg(
    (c, org) => c.query<{ project_id: string; id: string }>('SELECT project_id, id FROM assistant_threads WHERE org_id = $1 AND owner = $2 ORDER BY updated_at DESC, touched DESC LIMIT 5', [org, who.user.email]),
    who.org.id,
  );
  const order = [...latest.rows.map((r) => r.project_id), ...mine.map((p) => p.id)];
  for (const projectId of new Set(order)) {
    if (!mine.some((p) => p.id === projectId) || !(await mayAsk(pool, who, projectId))) continue;
    const { usable, teams } = await agentsFor(projectId);
    const thread = await copilot.threadFor(projectId);
    const routed = await routeAsk(projectId, question, usable, 'best');
    return routed.kind === 'agent' ? { projectId, agentId: routed.agentId, why: routed.why } : { projectId, agentId: preselect(usable, teams, thread?.agentId) };
  }
  return null;
}

/** Asks as `who` and reads the stored turns. `signal`: the caller's lease; it aborts the ask when the lease is lost. */
export async function ask(pool: Pool, who: Identity, requestId: string, question: string, target: Target, signal?: AbortSignal): Promise<Asked> {
  const contract = contractFor('copilot:ask');
  const handler = handlers.get('copilot:ask');
  if (!contract || !handler) return { ok: false, reason: 'failed' };
  if (!underBudget(who.org.id, who.user.email)) return { ok: false, reason: 'limited' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('slack ask time limit')), slackLimits().timeoutMs);
  const onLost = () => ac.abort(signal?.reason);
  signal?.addEventListener('abort', onLost, { once: true });
  const work = runInContext(who, requestId, async (): Promise<Asked> => {
    if (!(await mayAsk(pool, who, target.projectId))) return { ok: false, reason: 'denied' };
    // Always a conversation named here: left to the handler, a first question would land in the asker's LATEST conversation
    // (a web one, with ITS agent). A new one is made for the asker with the channel's agent, refused as copilot:newThread
    // refuses an agent the caller may not use; a Slack thread's own is continued.
    let into = target.threadId;
    if (!into) {
      if (target.agentId && !(await askScope(target.projectId, target.agentId)).agent) return { ok: false, reason: 'agent' };
      into = (await copilot.createThread(target.projectId, target.agentId))?.id;
    }
    if (!into) return { ok: false, reason: 'failed' };
    const parsed = contract.input.safeParse({
      projectId: target.projectId, context: { kind: '' }, question, threadId: into, ...(target.agentId ? { agentId: target.agentId } : {}),
    });
    if (!parsed.success) return { ok: false, reason: 'failed' };
    const data = parsed.data as { context: object };
    const input = { ...data, context: { ...data.context, noSources: true, ...(target.why ? { routed: target.why } : {}) } }; // server-only: never the project's source tables; the router's reason for the agent
    const res = (await handler({}, input)) as { ok?: boolean; notReady?: boolean; threadId?: string | null; turns?: Array<{ role: string; card?: Card }>; agent?: { name?: string } | null };
    if (!res || res.ok !== true) return { ok: false, reason: res?.notReady ? 'not_ready' : 'failed' };
    const threadId = res.threadId;
    if (!threadId) return { ok: false, reason: 'failed' };
    const history = await copilot.loadHistory(target.projectId, threadId);
    const seen = await shownBy(target.projectId, history);
    if (!seen.last) return { ok: false, reason: 'failed' };
    const shown = [...(res.turns ?? [])].reverse().find((t) => t.role === 'assistant');
    const { last, ...rest } = seen;
    return { ok: true, text: last?.text ?? '', card: shown?.card ?? null, turnId: seen.last.id, threadId, projectId: target.projectId, agentName: res.agent?.name ?? null, ...rest };
  }, undefined, ac.signal);
  try {
    return await untilAborted(work, ac.signal);
  } catch (err) {
    if (signal?.aborted) throw err; // the lease was lost: the caller stops
    return { ok: false, reason: 'timeout' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onLost);
  }
}
