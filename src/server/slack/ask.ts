// A Slack question, asked the way the app asks it: the SAME registered `copilot:ask` handler, as the linked user, with
// the org's configured model. Slack carries text in and out only; nothing is built from Slack (no `askId`, so no
// streaming, and any `suggestedAction` that is not an answer is ignored).
//
// Calling a handler skips the RPC layer's 403, so this runs `authorize()` first, for that user, on the contract and the
// project — the same rule the route applies (src/server/authz/index.ts). A refusal answers "denied" and the handler
// is never called.
//
// The datasets an answer showed come from the STORED turn (`shows()` and `dashboardsFrom`), not the browser reply,
// which strips them (src/ipc/answerSnapshots.ts turnsForBrowser).

import type { Pool } from 'pg';
import { contractFor } from '../../api/index';
import { authorize } from '../authz/index';
import { seedRank } from '../authz/caller';
import { runInContext, type Identity } from '../context';
import { inOrg } from '../db/inOrg';
import { handlers } from '../rpc';
import * as copilot from '../../ai/copilot';
import { agentsFor, preselect } from '../../ai/agentAccess';
import { shows } from '../../ipc/turnsOpen';
import * as projects from '../../app/projects';

export interface Target { projectId: string; agentId: string | null; threadId?: string }

/** A card as the browser gets it (src/ipc/answerSnapshots.ts): a chart's, or an SQL answer's table. Read, never written. */
export type Card = Record<string, any>; // any: AnswerCard | SqlCard, told apart by `kind`

export type Asked =
  | { ok: true; text: string; card: Card | null; datasetIds: string[]; dashboardIds: string[]; threadId: string; projectId: string; agentName: string | null }
  | { ok: false; reason: 'denied' | 'not_ready' | 'failed' | 'no_project' };

/** Does `who` pass the RPC layer's check for `copilot:ask` on `projectId`? (The caller seeds the rank for the request.) */
export async function mayAsk(pool: Pool, who: Identity, projectId: string): Promise<boolean> {
  const contract = contractFor('copilot:ask');
  if (!contract) return false;
  const d = await authorize(contract, { projectId }, who, pool);
  if (d.ok && d.rank !== undefined) seedRank(projectId, d.rank);
  return d.ok;
}

/**
 * A direct message has no project: the project of the person's latest conversation they may still ask in, else the
 * first project they may ask in (the newest updated). The agent is the composer's preselection (src/ai/agentAccess.ts).
 * Inside the person's request context.
 */
export async function directTarget(pool: Pool, who: Identity): Promise<Target | null> {
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
    return { projectId, agentId: preselect(usable, teams, thread?.agentId) };
  }
  return null;
}

/** Asks as `who` and reads the stored answer. Runs inside `runInContext(who)`; the caller chose `target`. */
export async function ask(pool: Pool, who: Identity, requestId: string, question: string, target: Target): Promise<Asked> {
  const contract = contractFor('copilot:ask');
  const handler = handlers.get('copilot:ask');
  if (!contract || !handler) return { ok: false, reason: 'failed' };
  const parsed = contract.input.safeParse({
    projectId: target.projectId, context: { kind: '' }, question, ...(target.threadId ? { threadId: target.threadId } : {}), ...(target.agentId ? { agentId: target.agentId } : {}),
  });
  if (!parsed.success) return { ok: false, reason: 'failed' };
  return runInContext(who, requestId, async (): Promise<Asked> => {
    if (!(await mayAsk(pool, who, target.projectId))) return { ok: false, reason: 'denied' };
    const res = (await handler({}, parsed.data)) as { ok?: boolean; notReady?: boolean; threadId?: string | null; turns?: Array<{ role: string; card?: Card }>; agent?: { name?: string } | null };
    if (!res || res.ok !== true) return { ok: false, reason: res?.notReady ? 'not_ready' : 'failed' };
    const threadId = res.threadId;
    if (!threadId) return { ok: false, reason: 'failed' };
    // The stored turn: what it showed (the browser reply strips this).
    const history = await copilot.loadHistory(target.projectId, threadId);
    const turn = [...history].reverse().find((t) => t.role === 'assistant');
    if (!turn) return { ok: false, reason: 'failed' };
    const shown = [...(res.turns ?? [])].reverse().find((t) => t.role === 'assistant');
    return {
      ok: true, text: turn.text, card: shown?.card ?? null, datasetIds: [...new Set(shows(turn))], dashboardIds: [...new Set(turn.dashboardsFrom ?? [])],
      threadId, projectId: target.projectId, agentName: res.agent?.name ?? null,
    };
  });
}
