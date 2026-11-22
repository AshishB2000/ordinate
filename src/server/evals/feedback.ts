// Thumbs up and down (docs/eval-suites/00-design.md, phase 1). The turn keeps the value (src/ai/copilotFeedback.ts); with a database
// the SAME transaction writes `assistant_feedback`, the row the editors' inbox and the issues board read. A thumbs-down row holds the
// QUESTION text (the owner's answer to Q1); a thumbs-up row holds none; neither ever holds a word of the answer or a figure.

import type { PoolClient } from 'pg';
import { ctx } from '../context';
import { setFeedback } from '../../ai/copilotFeedback';
import * as copilot from '../../ai/copilot';
import { agentNames } from '../../ai/agentAccess';
import { sanitizeFeedback, type Feedback } from '../../ai/feedback';
import { openTurns, shows } from '../../ipc/turnsOpen';
import { levelsOf } from '../authz/folderGate';
import * as store from './db';
import * as say from '../evalMessages';

const MAX_QUESTION = 4000;

async function writeRow(c: PoolClient, org: string, p: { projectId: string; threadId: string; turnId: string; fb: Feedback | null; question: string | null; agentId: string | null; datasets: string[]; boards: string[] }): Promise<void> {
  if (!p.fb) {
    await c.query('DELETE FROM assistant_feedback WHERE org_id = $1 AND turn_id = $2', [org, p.turnId]);
    return;
  }
  const question = p.fb.value === 'down' && p.question ? p.question.slice(0, MAX_QUESTION).replaceAll('\0', '�') : null;
  await c.query(
    `INSERT INTO assistant_feedback (org_id, project_id, turn_id, thread_id, owner, agent_id, value, reason, question, dataset_ids, dashboard_ids) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)
     ON CONFLICT (org_id, turn_id) DO UPDATE SET value = $7, reason = $8, question = $9, dataset_ids = $10::jsonb, dashboard_ids = $11::jsonb, updated_at = now(),
       handled_at = CASE WHEN assistant_feedback.value = $7 THEN assistant_feedback.handled_at ELSE NULL END, handled_by = CASE WHEN assistant_feedback.value = $7 THEN assistant_feedback.handled_by ELSE NULL END`,
    [org, p.projectId, p.turnId, p.threadId, ctx().user.email, p.agentId, p.fb.value, p.fb.reason ?? null, question, JSON.stringify(p.datasets), JSON.stringify(p.boards)],
  );
}

/** Rates the caller's own answer turn. `value` 'none' clears it. */
export async function rate(p: { projectId: string; threadId: string; turnId: string; value: 'up' | 'down' | 'none'; reason?: string }): Promise<{ ok: true; feedback: Feedback | null } | { ok: false; error: string }> {
  const fb = p.value === 'none' ? null : sanitizeFeedback({ value: p.value, reason: p.reason }) ?? null;
  if (p.value !== 'none' && !fb) return { ok: false, error: say.couldNotRate() };
  const turn = await copilot.findTurn(p.projectId, p.threadId, p.turnId); // the caller's own conversation only
  if (!turn || turn.research || (await openTurns(p.projectId, [turn])).length !== 1) return { ok: false, error: say.couldNotRate() };
  const rated = await setFeedback(p.projectId, p.threadId, p.turnId, fb, store.dbOrNull() ? (c, org, r) => writeRow(c, org, { ...p, fb, question: r.question, agentId: r.agentId, datasets: [...new Set(shows(turn))], boards: turn.dashboardsFrom ?? [] }) : undefined);
  return rated ? { ok: true, feedback: fb } : { ok: false, error: say.couldNotRate() };
}

interface Row { turnId: string; question: string; agentId: string | null; reason: string | null; createdAt: string; datasetIds: string[]; dashboardIds: string[] }

/** The rows whose answer showed nothing in a folder closed to the caller: a question before such an answer is hidden as it is in History (turnsOpen). */
async function openRows<T extends { datasetIds: string[]; dashboardIds: string[] }>(projectId: string, rows: T[]): Promise<T[]> {
  const ds = await levelsOf(projectId, 'dataset');
  const bd = rows.some((x) => x.dashboardIds.length) ? await levelsOf(projectId, 'dashboard') : null;
  return rows.filter((x) => !x.datasetIds.some((d) => ds?.(d) === 'none') && !x.dashboardIds.some((d) => bd?.(d) === 'none'));
}

export interface InboxItem { turnId: string; question: string; agentId: string | null; agentName: string | null; reason: string | null; createdAt: string }

/** The thumbs-down questions of the project nobody has handled, newest first. Never the asker, never an answer. */
export async function inbox(projectId: string): Promise<InboxItem[]> {
  const org = ctx().org.id;
  const r = await store.scoped({ org }, (c) => c.query<Row>(
    `SELECT turn_id AS "turnId", question, agent_id::text AS "agentId", reason, created_at::text AS "createdAt", dataset_ids AS "datasetIds", dashboard_ids AS "dashboardIds" FROM assistant_feedback
      WHERE org_id = $1 AND project_id = $2 AND value = 'down' AND question IS NOT NULL AND handled_at IS NULL ORDER BY created_at DESC, turn_id LIMIT 100`, [org, projectId]));
  const open = await openRows(projectId, r.rows);
  // Every agent is usable by an editor (agentAccess.mayUse), and only editors read the inbox: naming one gives away nothing.
  const names = await agentNames(projectId, open.flatMap((x) => (x.agentId ? [x.agentId] : [])));
  return open.map(({ datasetIds: _d, dashboardIds: _b, ...x }) => ({ ...x, agentName: x.agentId ? names.get(x.agentId)?.name ?? null : null }));
}

/** The question of one unhandled inbox item (for a case), or null. */
export async function inboxQuestion(projectId: string, turnId: string): Promise<string | null> {
  const org = ctx().org.id;
  const r = await store.scoped({ org }, (c) => c.query<{ question: string; datasetIds: string[]; dashboardIds: string[] }>(
    `SELECT question, dataset_ids AS "datasetIds", dashboard_ids AS "dashboardIds" FROM assistant_feedback WHERE org_id = $1 AND project_id = $2 AND turn_id = $3 AND value = 'down' AND question IS NOT NULL AND handled_at IS NULL`, [org, projectId, turnId]));
  return (await openRows(projectId, r.rows))[0]?.question ?? null;
}

/** An editor added it to a suite or dismissed it. False: no such unhandled item. */
export async function handle(projectId: string, turnId: string): Promise<boolean> {
  if ((await inboxQuestion(projectId, turnId)) === null) return false; // as missing for an item closed to the caller
  const org = ctx().org.id;
  return !!(await store.scoped({ org }, (c) => c.query(
    `UPDATE assistant_feedback SET handled_at = now(), handled_by = $4 WHERE org_id = $1 AND project_id = $2 AND turn_id = $3 AND handled_at IS NULL`, [org, projectId, turnId, ctx().user.email]))).rowCount;
}
