// A thumbs up or down kept on the asker's own answer turn (docs/eval-suites/00-design.md, phase 1). Rows with a database, the thread's
// copilot.json without one (as every other turn edit). Only the CALLER's own conversation, an assistant turn, not a research card and
// not a hidden suite-run conversation. With rows, `also` runs in the SAME transaction (the `assistant_feedback` row the editors' inbox
// and the issues board read), so the turn and its row never disagree. Returns the question the turn answered, read here from the
// stored user turn before it: the browser never sends it.

import type { PoolClient } from 'pg';
import { ctx } from '../server/context';
import { inOrg } from '../server/db/inOrg';
import * as copilot from './copilot';
import * as rows from './copilotRows';
import type { Feedback } from './feedback';

export interface Rated { question: string | null; agentId: string | null }

/** `fb` null clears it. Null back: no such answer turn of the caller's (an unknown id, another member's, a research card). */
export async function setFeedback(
  projectId: string, threadId: string, turnId: string, fb: Feedback | null,
  also?: (c: PoolClient, org: string, rated: Rated) => Promise<void>,
): Promise<Rated | null> {
  if (!copilot.isValidId(projectId) || !copilot.isValidId(threadId) || !turnId) return null;
  if (rows.on()) {
    return inOrg(async (c, org) => {
      const r = await c.query<{ role: string; body: string; question: string | null; agent_id: string | null }>(
        `SELECT u.role, u.body, t.agent_id::text, (SELECT p.text FROM assistant_turns p WHERE p.org_id = u.org_id AND p.project_id = u.project_id AND p.thread_id = u.thread_id AND p.seq = u.seq - 1 AND p.role = 'user') AS question
           FROM assistant_turns u JOIN assistant_threads t ON t.org_id = u.org_id AND t.project_id = u.project_id AND t.id = u.thread_id
          WHERE u.org_id = $1 AND u.project_id = $2 AND u.thread_id = $3 AND u.id::text = $4 AND t.owner = $5 AND NOT t.hidden FOR UPDATE OF u`,
        [org, projectId, threadId, turnId, ctx().user.email],
      );
      const row = r.rows[0];
      if (!row || row.role !== 'assistant') return null;
      let body: Record<string, unknown> = {};
      try {
        const b: unknown = JSON.parse(row.body);
        if (b && typeof b === 'object' && !Array.isArray(b)) body = b as Record<string, unknown>;
      } catch { /* a damaged body keeps the turn, without its other fields */ }
      if (body.research) return null;
      if (fb) body.feedback = fb;
      else delete body.feedback;
      await c.query('UPDATE assistant_turns SET body = $5 WHERE org_id = $1 AND project_id = $2 AND thread_id = $3 AND id::text = $4', [org, projectId, threadId, turnId, JSON.stringify(body)]);
      const rated = { question: row.question, agentId: row.agent_id };
      await also?.(c, org, rated);
      return rated;
    });
  }
  return copilot.changeThreads(projectId, async (threads) => {
    const thread = copilot.mine(threads).find((t) => t.id === threadId);
    const at = thread ? thread.turns.findIndex((x) => x.id === turnId) : -1;
    const turn = thread && at >= 0 ? thread.turns[at] : undefined;
    if (!thread || !turn || turn.role !== 'assistant' || turn.research) return null;
    if (fb) turn.feedback = fb;
    else delete turn.feedback;
    await copilot.writeThreads(projectId, threads);
    const before = thread.turns[at - 1];
    return { question: before?.role === 'user' ? before.text : null, agentId: thread.agentId ?? null };
  });
}
