// Deep research's Postgres rows (0043_research.sql). The pool is wired once by app.ts (`useResearchDb`); without a database
// there is no deep research. The tables are under FORCED row-level security, so every statement runs in a transaction that
// names its scope — `scoped()` — and sees only that scope's rows: `{ org }`, or 'system' (the worker's claim and the sweeps).
//
// THE LEASE AND THE FENCE (the pattern of src/server/jobs/runner.ts): a claim stamps `lease_owner` and `lease_until`, a
// heartbeat pushes the lease on, and every write the worker makes is `WHERE lease_owner = <this claim>`: a pod whose lease
// was retaken (a crash, or an event loop stalled past the lease) finds its late write matching no row and applies nothing.

import type { Pool, PoolClient } from 'pg';
import type { StepRec } from '../../ai/researchLoop';
import type { Report } from '../../ai/researchWrite';
import { CEILING, DEFAULT_LIMITS, type Limits } from '../../ai/researchLoop';

let pool: Pool | null = null;
export function useResearchDb(p: Pool | null): void {
  pool = p;
}
export const dbOrNull = (): Pool | null => pool;
export function db(): Pool {
  if (!pool) throw new Error('Deep research needs a database');
  return pool;
}

export type Scope = { org: string } | 'system';

/** `fn` in ONE transaction that can see `scope`'s rows and nothing else's. */
export async function scoped<T>(scope: Scope, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db().connect();
  let broken: Error | undefined;
  try {
    await c.query('BEGIN');
    const [key, value] = scope === 'system' ? ['ordinate.research_scope', 'system'] : ['ordinate.org', scope.org];
    await c.query('SELECT set_config($1, $2, true)', [key, value]);
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch((e: Error) => { broken = e; });
    throw err;
  } finally {
    c.release(broken);
  }
}
const q = <R extends object = Record<string, unknown>>(scope: Scope, sql: string, params: unknown[] = []) => scoped(scope, (c) => c.query<R>(sql, params));

export type RunState = 'queued' | 'running' | 'writing' | 'done' | 'partial' | 'failed' | 'stopped';
export const ACTIVE: readonly RunState[] = ['queued', 'running', 'writing'];

export interface Run {
  orgId: string; projectId: string; id: string; startedBy: string; agentId: string | null; threadId: string; turnId: string | null; question: string;
  state: RunState; plan: string[]; steps: StepRec[]; report: Report | null; storyId: string | null; stopRequested: boolean;
  stepsUsed: number; queriesUsed: number; attempts: number; startedAt: string; deadlineAt: string | null; finishedAt: string | null; errorCode: string | null;
}
const COLS = `org_id AS "orgId", project_id::text AS "projectId", id::text AS id, started_by AS "startedBy", agent_id::text AS "agentId", thread_id::text AS "threadId",
  turn_id AS "turnId", question, state, plan, steps, report, story_id::text AS "storyId", stop_requested AS "stopRequested", steps_used AS "stepsUsed",
  queries_used AS "queriesUsed", attempts, started_at::text AS "startedAt", deadline_at::text AS "deadlineAt", finished_at::text AS "finishedAt", error_code AS "errorCode"`;

/** The lease a claim holds, and how long it may go unrenewed. */
export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 3;
/** A pod serves at most this many runs at once. */
export const PER_POD = 2;

export interface NewRun { id: string; orgId: string; projectId: string; startedBy: string; agentId: string | null; threadId: string; question: string }
/** Queues a run; false when the person already has one queued, running or writing (the unique index decides a race). */
export async function insertRun(n: NewRun): Promise<boolean> {
  try {
    await q({ org: n.orgId }, 'INSERT INTO research_runs (org_id, project_id, id, started_by, agent_id, thread_id, question) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [n.orgId, n.projectId, n.id, n.startedBy, n.agentId, n.threadId, n.question]);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return false; // the one-active index (the id is a fresh uuid)
    throw err;
  }
}
export async function setTurn(org: string, id: string, turnId: string): Promise<void> {
  await q({ org }, 'UPDATE research_runs SET turn_id = $3 WHERE org_id = $1 AND id = $2', [org, id, turnId]);
}
export async function getRun(org: string, id: string): Promise<Run | null> {
  return (await q<Run>({ org }, `SELECT ${COLS} FROM research_runs WHERE org_id = $1 AND id = $2`, [org, id])).rows[0] ?? null;
}
/** The person's own runs in a project, newest first. */
export async function listRuns(org: string, projectId: string, by: string, limit = 50): Promise<Run[]> {
  return (await q<Run>({ org }, `SELECT ${COLS} FROM research_runs WHERE org_id = $1 AND project_id = $2 AND started_by = $3 ORDER BY started_at DESC LIMIT $4`, [org, projectId, by, limit])).rows;
}

/** Claims one due run (queued, or running or writing with a lapsed lease) for `owner`; null when none. One statement, SKIP LOCKED. */
export async function claim(owner: string, leaseMs = LEASE_MS): Promise<Run | null> {
  const r = await q<Run>('system',
    `UPDATE research_runs SET state = CASE WHEN state = 'queued' THEN 'running' ELSE state END, lease_owner = $1,
            lease_until = now() + ($2 || ' milliseconds')::interval, attempts = attempts + 1
      WHERE (org_id, id) = (SELECT org_id, id FROM research_runs
                             WHERE (state = 'queued' OR (state IN ('running', 'writing') AND lease_until < now())) AND attempts < ${MAX_ATTEMPTS}
                             ORDER BY started_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING ${COLS}`, [owner, String(leaseMs)]);
  return r.rows[0] ?? null;
}
/** A run that ran out of attempts (its pod kept dying): failed, so a person is not left waiting. Resumable. */
export async function failExhausted(): Promise<Array<{ orgId: string; id: string; startedBy: string }>> {
  return (await q<{ orgId: string; id: string; startedBy: string }>('system',
    `UPDATE research_runs SET state = 'failed', error_code = 'gave_up', finished_at = now(), lease_owner = NULL, lease_until = NULL
      WHERE state IN ('running', 'writing') AND lease_until < now() AND attempts >= ${MAX_ATTEMPTS} RETURNING org_id AS "orgId", id::text AS id, started_by AS "startedBy"`)).rows;
}
/** Pushes the lease on; false when this owner no longer holds it. */
export async function heartbeat(org: string, id: string, owner: string, leaseMs = LEASE_MS): Promise<boolean> {
  return !!(await q('system', `UPDATE research_runs SET lease_until = now() + ($4 || ' milliseconds')::interval
    WHERE org_id = $1 AND id = $2 AND lease_owner = $3 AND state IN ('running', 'writing')`, [org, id, owner, String(leaseMs)])).rowCount;
}
/** The stop flag (read each time), and whether this owner still holds the run. */
export async function flags(org: string, id: string, owner: string): Promise<{ stop: boolean; held: boolean }> {
  const r = (await q<{ stop: boolean; held: boolean }>('system', 'SELECT stop_requested AS stop, lease_owner = $3 AS held FROM research_runs WHERE org_id = $1 AND id = $2', [org, id, owner])).rows[0];
  return { stop: !!r?.stop, held: !!r?.held };
}
/** The deadline, set once (a retake after a crash keeps it); the milliseconds left to it (0 or less: past). */
export async function setDeadline(org: string, id: string, owner: string, ms: number): Promise<number> {
  const r = await q<{ left: string }>('system', `UPDATE research_runs SET deadline_at = COALESCE(deadline_at, now() + ($4 || ' milliseconds')::interval)
    WHERE org_id = $1 AND id = $2 AND lease_owner = $3 RETURNING (extract(epoch FROM (deadline_at - now())) * 1000)::bigint::text AS left`, [org, id, owner, String(ms)]);
  return r.rows[0] ? Number(r.rows[0].left) : 0;
}
export async function savePlan(org: string, id: string, owner: string, plan: string[]): Promise<boolean> {
  return !!(await q('system', 'UPDATE research_runs SET plan = $4::jsonb WHERE org_id = $1 AND id = $2 AND lease_owner = $3', [org, id, owner, JSON.stringify(plan)])).rowCount;
}
/** After each step. Fenced by the owner: false means the lease was lost and nothing was applied. */
export async function saveSteps(org: string, id: string, owner: string, steps: StepRec[], stepsUsed: number, queriesUsed: number): Promise<boolean> {
  return !!(await q('system', 'UPDATE research_runs SET steps = $4::jsonb, steps_used = $5, queries_used = $6 WHERE org_id = $1 AND id = $2 AND lease_owner = $3',
    [org, id, owner, JSON.stringify(steps), stepsUsed, queriesUsed])).rowCount;
}
export async function setWriting(org: string, id: string, owner: string): Promise<boolean> {
  return !!(await q('system', `UPDATE research_runs SET state = 'writing' WHERE org_id = $1 AND id = $2 AND lease_owner = $3`, [org, id, owner])).rowCount;
}
export async function finish(org: string, id: string, owner: string, state: 'done' | 'partial' | 'failed' | 'stopped', code: string | null, report: Report | null): Promise<boolean> {
  return !!(await q('system',
    `UPDATE research_runs SET state = $4, error_code = $5, report = COALESCE($6::jsonb, report), finished_at = now(), lease_owner = NULL, lease_until = NULL
      WHERE org_id = $1 AND id = $2 AND lease_owner = $3`, [org, id, owner, state, code, report ? JSON.stringify(report) : null])).rowCount;
}

/** `research:stop`: a queued run stops at once, a running one gets the flag its worker reads before every call and step. */
export async function requestStop(org: string, id: string): Promise<void> {
  await q({ org }, `UPDATE research_runs SET stop_requested = true,
      state = CASE WHEN state = 'queued' THEN 'stopped' ELSE state END, finished_at = CASE WHEN state = 'queued' THEN now() ELSE finished_at END
    WHERE org_id = $1 AND id = $2 AND state IN ('queued', 'running', 'writing')`, [org, id]);
}
/** `research:resume`: a partial or failed run goes back in the queue (a fresh time allowance; the steps and counts stay). False: not resumable, or the person has another run going. */
export async function requeue(org: string, id: string): Promise<boolean> {
  try {
    return !!(await q({ org }, `UPDATE research_runs SET state = 'queued', stop_requested = false, error_code = NULL, finished_at = NULL, deadline_at = NULL, attempts = 0, report = NULL
      WHERE org_id = $1 AND id = $2 AND state IN ('partial', 'failed') AND error_code IS DISTINCT FROM 'access'`, [org, id])).rowCount;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return false;
    throw err;
  }
}
/** Serializes two presses of "Add to project" for one run: `fn` runs holding the run's row lock, and records the story id through `setStory` on that same transaction (a second press waits, then finds it). */
export async function withRunLocked<T>(org: string, id: string, fn: (run: Run, setStory: (storyId: string) => Promise<void>) => Promise<T>): Promise<T | null> {
  return scoped({ org }, async (c) => {
    const r = (await c.query<Run>(`SELECT ${COLS} FROM research_runs WHERE org_id = $1 AND id = $2 FOR UPDATE`, [org, id])).rows[0];
    return r ? fn(r, async (storyId) => { await c.query('UPDATE research_runs SET story_id = $3 WHERE org_id = $1 AND id = $2', [org, id, storyId]); }) : null;
  });
}

/** Deletes the runs of people no longer in the org, and runs never added to a project in 90 days. Returns how many. */
export async function sweep(org: string, days = 90): Promise<number> {
  return (await q({ org }, `DELETE FROM research_runs r WHERE r.org_id = $1 AND (
      NOT EXISTS (SELECT 1 FROM users u WHERE u.org_id = r.org_id AND u.email = r.started_by)
      OR (r.story_id IS NULL AND r.started_at < now() - ($2 || ' days')::interval AND r.state NOT IN ('queued', 'running', 'writing')))`, [org, String(days)])).rowCount ?? 0;
}

// ── limits ──────────────────────────────────────────────────────────────────

export async function limitsOf(org: string): Promise<Limits> {
  const r = (await q<Limits>({ org }, 'SELECT steps, queries, minutes FROM org_research_limits WHERE org_id = $1', [org])).rows[0];
  return r ? { steps: r.steps, queries: r.queries, minutes: r.minutes } : { ...DEFAULT_LIMITS };
}
/** Saves the limits, each within its ceiling: false (nothing saved) when one is outside 1..ceiling or not a whole number. */
export async function saveLimits(org: string, l: Limits): Promise<boolean> {
  for (const k of ['steps', 'queries', 'minutes'] as const) if (!Number.isInteger(l[k]) || l[k] < 1 || l[k] > CEILING[k]) return false;
  await q({ org }, `INSERT INTO org_research_limits (org_id, steps, queries, minutes) VALUES ($1, $2, $3, $4)
    ON CONFLICT (org_id) DO UPDATE SET steps = $2, queries = $3, minutes = $4, updated_at = now()`, [org, l.steps, l.queries, l.minutes]);
  return true;
}

