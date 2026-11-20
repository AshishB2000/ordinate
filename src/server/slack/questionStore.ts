// The queue any pod works: `slack_questions` (0041), claimed FOR UPDATE SKIP LOCKED under a lease and a heartbeat (the
// src/server/jobs/runner.ts pattern). A row also remembers HOW FAR its answer got — the ask stored (`answer`), the post
// done (`delivered_at`), the private answer sent (`dm_at`) — so a retaken question repeats nothing already done.

import type { PoolClient } from 'pg';
import { q, scoped } from './db';

export interface NewQuestion {
  id: string; orgId: string; teamId: string; kind?: 'ask' | 'share'; channelId: string; channelType: 'channel' | 'im'; threadTs: string | null; eventTs: string | null;
  slackUserId: string; text: string; ofQuestion?: string | null;
}

async function insertQuestion(c: PoolClient, n: NewQuestion): Promise<void> {
  await c.query(
    `INSERT INTO slack_questions (id, org_id, team_id, kind, channel_id, channel_type, thread_ts, event_ts, slack_user_id, text, of_question)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [n.id, n.orgId, n.teamId, n.kind ?? 'ask', n.channelId, n.channelType, n.threadTs, n.eventTs, n.slackUserId, n.text, n.ofQuestion ?? null]);
}

/** Queues a question. With an event id: the event and its question in ONE transaction, so a failed insert leaves no "seen" mark and Slack's retry is queued. False: a repeat. */
export async function enqueue(n: NewQuestion, eventId?: string): Promise<boolean> {
  return scoped({ org: n.orgId }, async (c) => {
    if (eventId && !(await c.query('INSERT INTO slack_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId])).rowCount) return false;
    await insertQuestion(c, n);
    return true;
  });
}

/** What a stored answer remembers (no card, no figure): where its turn is, what it showed, and the asker's view then. */
export interface StoredAnswer {
  threadId: string; projectId: string; turnId: string; agentName: string | null; datasetIds: string[]; dashboardIds: string[]; datasetNames: string[];
  view: string | null; sourceTable: boolean; outside: boolean;
}

export interface Question {
  id: string; orgId: string; teamId: string; kind: 'ask' | 'share'; channelId: string; channelType: 'channel' | 'im'; threadTs: string | null; eventTs: string | null;
  slackUserId: string; text: string; placeholderTs: string | null; projectId: string | null; agentId: string | null; threadId: string | null;
  ofQuestion: string | null; attempts: number; answer: StoredAnswer | null; deliveredAt: string | null; dmAt: string | null; outcome: string | null;
}
const Q_COLS = `id, org_id AS "orgId", team_id AS "teamId", kind, channel_id AS "channelId", channel_type AS "channelType", thread_ts AS "threadTs",
  event_ts AS "eventTs", slack_user_id AS "slackUserId", text, placeholder_ts AS "placeholderTs", project_id AS "projectId", agent_id AS "agentId",
  thread_id AS "threadId", of_question AS "ofQuestion", attempts, answer, delivered_at::text AS "deliveredAt", dm_at::text AS "dmAt", outcome`;

/** The lease a claim holds; the heartbeat pushes it on. A crashed pod's lease lapses and the next poll retakes the row. */
export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 3;

/** Claims one due question (pending, or running with a lapsed lease) for `owner`; null when none. One statement, SKIP LOCKED. */
export async function claim(owner: string, leaseMs = LEASE_MS): Promise<Question | null> {
  const r = await q<Question>('system',
    `UPDATE slack_questions SET status = 'running', lease_owner = $1, lease_until = now() + ($2 || ' milliseconds')::interval, attempts = attempts + 1
      WHERE id = (SELECT id FROM slack_questions WHERE (status = 'pending' OR (status = 'running' AND lease_until < now()))
                   AND attempts < ${MAX_ATTEMPTS} ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING ${Q_COLS}`,
    [owner, String(leaseMs)]);
  return r.rows[0] ?? null;
}
/** A question that ran out of attempts (its pod kept dying): failed, so the thread is not left waiting forever. */
export async function failExhausted(): Promise<Question[]> {
  return (await q<Question>('system',
    `UPDATE slack_questions SET status = 'failed', outcome = 'gave_up', text = '', finished_at = now()
      WHERE status = 'running' AND lease_until < now() AND attempts >= ${MAX_ATTEMPTS} RETURNING ${Q_COLS}`)).rows;
}
/** Pushes the lease on; false when this owner no longer holds it (it lapsed and another pod retook the row): the caller stops. */
export async function heartbeat(id: string, owner: string, leaseMs = LEASE_MS): Promise<boolean> {
  return !!(await q('system', `UPDATE slack_questions SET lease_until = now() + ($3 || ' milliseconds')::interval WHERE id = $1 AND lease_owner = $2 AND status = 'running'`, [id, owner, String(leaseMs)])).rowCount;
}
/** The placeholder's `ts`, stored in the same step as it is posted (./answer.ts), with where the question goes. Fenced by the owner. */
export async function setPlaceholder(id: string, owner: string, ts: string | null, projectId: string | null, agentId: string | null): Promise<void> {
  await q('system', 'UPDATE slack_questions SET placeholder_ts = COALESCE($3, placeholder_ts), project_id = $4, agent_id = $5 WHERE id = $1 AND lease_owner = $2', [id, owner, ts, projectId, agentId]);
}
export async function saveAnswer(id: string, owner: string, a: StoredAnswer): Promise<void> {
  await q('system', 'UPDATE slack_questions SET answer = $3::jsonb, thread_id = $4 WHERE id = $1 AND lease_owner = $2', [id, owner, JSON.stringify(a), a.threadId]);
}
export async function markDelivered(id: string, owner: string, outcome: string): Promise<void> {
  await q('system', 'UPDATE slack_questions SET delivered_at = now(), outcome = $3 WHERE id = $1 AND lease_owner = $2', [id, owner, outcome]);
}
export async function markDm(id: string, owner: string): Promise<void> {
  await q('system', 'UPDATE slack_questions SET dm_at = now() WHERE id = $1 AND lease_owner = $2', [id, owner]);
}
export async function finish(id: string, owner: string, status: 'done' | 'failed' | 'awaiting_link', outcome: string, threadId?: string | null): Promise<boolean> {
  return !!(await q('system',
    `UPDATE slack_questions SET status = $3, outcome = $4, thread_id = COALESCE($5, thread_id), lease_owner = NULL, lease_until = NULL, finished_at = CASE WHEN $3 = 'awaiting_link' THEN NULL ELSE now() END
      WHERE id = $1 AND lease_owner = $2`, [id, owner, status, outcome, threadId ?? null])).rowCount;
}
export async function questionById(org: string, id: string): Promise<Question | null> {
  return (await q<Question>({ org }, `SELECT ${Q_COLS} FROM slack_questions WHERE id = $1 AND org_id = $2`, [id, org])).rows[0] ?? null;
}
/** A parked question goes back in the queue once its asker has linked. */
export async function resume(org: string, id: string): Promise<void> {
  await q({ org }, `UPDATE slack_questions SET status = 'pending', attempts = 0 WHERE id = $1 AND org_id = $2 AND status = 'awaiting_link'`, [id, org]);
}
export async function setFeedback(org: string, id: string, v: 'helpful' | 'not_helpful'): Promise<boolean> {
  return !!(await q({ org }, 'UPDATE slack_questions SET feedback = $3 WHERE id = $1 AND org_id = $2', [id, org, v])).rowCount;
}
export async function shareExists(org: string, of: string): Promise<boolean> {
  return !!(await q({ org }, `SELECT 1 FROM slack_questions WHERE of_question = $1 AND org_id = $2 AND kind = 'share' AND status IN ('pending', 'running', 'done')`, [of, org])).rowCount;
}
