// Evaluation suites' Postgres rows (0045_evals.sql). The pool is wired once by app.ts (`useEvalsDb`); without a database there are no
// suites (the thumbs on a turn still work, in copilot.json). The tables are under FORCED row-level security, so every statement runs
// in a transaction that names its scope — `scoped()` — and sees only that scope's rows: `{ org }`, or 'system' (the worker's claim).
//
// THE LEASE AND THE FENCE are deep research's (src/server/research/db.ts): a claim stamps `lease_owner` and `lease_until`, a heartbeat
// pushes the lease on, and every write the worker makes is `WHERE lease_owner = <this claim>`: a pod whose lease was retaken finds
// its late write matching no row and applies nothing.

import type { Pool, PoolClient } from 'pg';
import { MAX_CASES, sanitizeExpect, type Check, type Expect, type Judged, type Outcome } from '../../ai/evalChecks';

let pool: Pool | null = null;
export function useEvalsDb(p: Pool | null): void {
  pool = p;
}
export const dbOrNull = (): Pool | null => pool;
export function db(): Pool {
  if (!pool) throw new Error('Evaluation suites need a database');
  return pool;
}

export type Scope = { org: string } | 'system';

/** `fn` in ONE transaction that can see `scope`'s rows and nothing else's. */
export async function scoped<T>(scope: Scope, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db().connect();
  let broken: Error | undefined;
  try {
    await c.query('BEGIN');
    const [key, value] = scope === 'system' ? ['ordinate.evals_scope', 'system'] : ['ordinate.org', scope.org];
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

export const MAX_SUITES = 50;

// ── suites and cases ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Suite { id: string; projectId: string; name: string; agentId: string | null; createdBy: string; createdAt: string; updatedAt: string }
const SUITE = `id::text AS id, project_id::text AS "projectId", name, agent_id::text AS "agentId", created_by AS "createdBy", created_at::text AS "createdAt", updated_at::text AS "updatedAt"`;

export async function listSuites(org: string, projectId: string): Promise<Suite[]> {
  return (await q<Suite>({ org }, `SELECT ${SUITE} FROM eval_suites WHERE org_id = $1 AND project_id = $2 ORDER BY created_at, id`, [org, projectId])).rows;
}
export async function getSuite(org: string, projectId: string, id: string): Promise<Suite | null> {
  return (await q<Suite>({ org }, `SELECT ${SUITE} FROM eval_suites WHERE org_id = $1 AND project_id = $2 AND id = $3`, [org, projectId, id])).rows[0] ?? null;
}
/** A new suite; null when the project already holds MAX_SUITES. */
export async function createSuite(org: string, n: { id: string; projectId: string; name: string; agentId: string | null; by: string }): Promise<Suite | null> {
  return scoped({ org }, async (c) => {
    const have = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM eval_suites WHERE org_id = $1 AND project_id = $2', [org, n.projectId])).rows[0].n;
    if (have >= MAX_SUITES) return null;
    return (await c.query<Suite>(`INSERT INTO eval_suites (org_id, project_id, id, name, agent_id, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${SUITE}`,
      [org, n.projectId, n.id, n.name, n.agentId, n.by])).rows[0];
  });
}
export async function renameSuite(org: string, projectId: string, id: string, name: string): Promise<boolean> {
  return !!(await q({ org }, 'UPDATE eval_suites SET name = $4, updated_at = now() WHERE org_id = $1 AND project_id = $2 AND id = $3', [org, projectId, id, name])).rowCount;
}
/** False: no such suite, or a run of it is going (its rows would vanish under the worker). */
export async function deleteSuite(org: string, projectId: string, id: string): Promise<boolean> {
  return scoped({ org }, async (c) => {
    const busy = await c.query(`SELECT 1 FROM eval_runs WHERE org_id = $1 AND suite_id = $2 AND state IN ('queued', 'running') FOR UPDATE`, [org, id]);
    if (busy.rowCount) return false;
    return !!(await c.query('DELETE FROM eval_suites WHERE org_id = $1 AND project_id = $2 AND id = $3', [org, projectId, id])).rowCount;
  });
}

export interface Case { id: string; suiteId: string; position: number; question: string; expect: Expect; source: 'verified' | 'answer' | 'inbox' | 'typed' }
type CaseRow = Omit<Case, 'expect'> & { expect: unknown };
const CASE = `id::text AS id, suite_id::text AS "suiteId", position, question, expect, source`;
const readCases = (rows: CaseRow[]): Case[] => rows.flatMap((r) => { const expect = sanitizeExpect(r.expect); return expect ? [{ ...r, expect }] : []; }); // a damaged one is skipped

/** A project's cases (every suite's), in suite then position order; one read for the suites list. */
export async function listCases(org: string, projectId: string, suiteId?: string): Promise<Case[]> {
  const r = await q<CaseRow>({ org }, `SELECT ${CASE} FROM eval_cases WHERE org_id = $1 AND project_id = $2 AND ($3::uuid IS NULL OR suite_id = $3) ORDER BY suite_id, position, id`, [org, projectId, suiteId ?? null]);
  return readCases(r.rows);
}
export async function casesByIds(org: string, ids: readonly string[]): Promise<Case[]> {
  const r = await q<CaseRow>({ org }, `SELECT ${CASE} FROM eval_cases WHERE org_id = $1 AND id = ANY($2::uuid[])`, [org, ids]);
  const by = new Map(readCases(r.rows).map((c) => [c.id, c]));
  return ids.flatMap((id) => (by.has(id) ? [by.get(id)!] : []));
}
/** Adds a case under the suite's row lock, so two at once cannot pass the cap. `full`: MAX_CASES held. `gone`: no such suite. */
export async function addCase(org: string, projectId: string, suiteId: string, n: { id: string; question: string; expect: Expect; source: Case['source']; by: string }): Promise<'full' | 'gone' | 'ok'> {
  return scoped({ org }, async (c) => {
    const lock = await c.query('SELECT 1 FROM eval_suites WHERE org_id = $1 AND project_id = $2 AND id = $3 FOR UPDATE', [org, projectId, suiteId]);
    if (!lock.rowCount) return 'gone';
    const have = (await c.query<{ n: number; top: number }>('SELECT count(*)::int AS n, coalesce(max(position), 0)::int AS top FROM eval_cases WHERE org_id = $1 AND suite_id = $2', [org, suiteId])).rows[0];
    if (have.n >= MAX_CASES) return 'full';
    await c.query('INSERT INTO eval_cases (org_id, project_id, suite_id, id, position, question, expect, source, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)',
      [org, projectId, suiteId, n.id, have.top + 1, n.question, JSON.stringify(n.expect), n.source, n.by]);
    await c.query('UPDATE eval_suites SET updated_at = now() WHERE org_id = $1 AND id = $2', [org, suiteId]);
    return 'ok';
  });
}
export async function updateCase(org: string, projectId: string, suiteId: string, id: string, n: { question: string; expect: Expect }): Promise<boolean> {
  return !!(await q({ org }, 'UPDATE eval_cases SET question = $5, expect = $6::jsonb WHERE org_id = $1 AND project_id = $2 AND suite_id = $3 AND id = $4', [org, projectId, suiteId, id, n.question, JSON.stringify(n.expect)])).rowCount;
}
export async function deleteCase(org: string, projectId: string, suiteId: string, id: string): Promise<boolean> {
  return !!(await q({ org }, 'DELETE FROM eval_cases WHERE org_id = $1 AND project_id = $2 AND suite_id = $3 AND id = $4', [org, projectId, suiteId, id])).rowCount;
}

// ── runs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type RunState = 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'stopped';
export const ACTIVE: readonly RunState[] = ['queued', 'running'];
export interface Run {
  orgId: string; projectId: string; id: string; suiteId: string; agentId: string | null; startedBy: string; state: RunState; caseIds: string[];
  casesTotal: number; casesDone: number; passed: number; failed: number; notScored: number; modelCalls: number; version: Record<string, string>;
  judge: string | null; judgeOwn: boolean; stopRequested: boolean; attempts: number; startedAt: string; deadlineAt: string | null; finishedAt: string | null; errorCode: string | null;
}
const RUN = `org_id AS "orgId", project_id::text AS "projectId", id::text AS id, suite_id::text AS "suiteId", agent_id::text AS "agentId", started_by AS "startedBy", state,
  case_ids AS "caseIds", cases_total AS "casesTotal", cases_done AS "casesDone", passed, failed, not_scored AS "notScored", model_calls AS "modelCalls", version,
  judge, judge_own AS "judgeOwn", stop_requested AS "stopRequested", attempts, started_at::text AS "startedAt", deadline_at::text AS "deadlineAt", finished_at::text AS "finishedAt", error_code AS "errorCode"`;

export const LEASE_MS = 60_000;
export const MAX_ATTEMPTS = 3;
/** A pod serves at most this many runs at once. */
export const PER_POD = 2;

export interface NewRun { id: string; orgId: string; projectId: string; suiteId: string; agentId: string | null; startedBy: string; caseIds: string[]; version: Record<string, string> }
/** Queues a run; false when the project already has one queued or running (the unique index decides a race). */
export async function insertRun(n: NewRun): Promise<boolean> {
  try {
    await q({ org: n.orgId }, 'INSERT INTO eval_runs (org_id, project_id, id, suite_id, agent_id, started_by, case_ids, cases_total, version) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb)',
      [n.orgId, n.projectId, n.id, n.suiteId, n.agentId, n.startedBy, JSON.stringify(n.caseIds), n.caseIds.length, JSON.stringify(n.version)]);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return false;
    throw err;
  }
}
export async function getRun(org: string, id: string): Promise<Run | null> {
  return (await q<Run>({ org }, `SELECT ${RUN} FROM eval_runs WHERE org_id = $1 AND id = $2`, [org, id])).rows[0] ?? null;
}
export async function listRuns(org: string, projectId: string, suiteId?: string, limit = 30): Promise<Run[]> {
  return (await q<Run>({ org }, `SELECT ${RUN} FROM eval_runs WHERE org_id = $1 AND project_id = $2 AND ($3::uuid IS NULL OR suite_id = $3) ORDER BY started_at DESC LIMIT $4`, [org, projectId, suiteId ?? null, limit])).rows;
}
/** The newest run of the suite that finished (any way) before `before`, with its results: what a run is compared to. */
export async function previousRun(org: string, suiteId: string, before: string): Promise<Run | null> {
  return (await q<Run>({ org }, `SELECT ${RUN} FROM eval_runs WHERE org_id = $1 AND suite_id = $2 AND started_at < $3::timestamptz AND state IN ('done', 'partial', 'stopped') AND cases_done > 0 ORDER BY started_at DESC LIMIT 1`, [org, suiteId, before])).rows[0] ?? null;
}
/** The newest finished run of each suite of the project (for "stale": its version against now). */
export async function lastRunPerSuite(org: string, projectId: string): Promise<Run[]> {
  return (await q<Run>({ org }, `SELECT DISTINCT ON (suite_id) ${RUN} FROM eval_runs WHERE org_id = $1 AND project_id = $2 AND state IN ('done', 'partial', 'stopped') AND cases_done > 0 ORDER BY suite_id, started_at DESC`, [org, projectId])).rows;
}

/** Claims one due run (queued, or running with a lapsed lease) for `owner`; null when none. One statement, SKIP LOCKED. */
export async function claim(owner: string, leaseMs = LEASE_MS): Promise<Run | null> {
  const r = await q<Run>('system',
    `UPDATE eval_runs SET state = 'running', lease_owner = $1, lease_until = now() + ($2 || ' milliseconds')::interval, attempts = attempts + 1
      WHERE (org_id, id) = (SELECT org_id, id FROM eval_runs WHERE (state = 'queued' OR (state = 'running' AND lease_until < now())) AND attempts < ${MAX_ATTEMPTS}
                             ORDER BY started_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING ${RUN}`, [owner, String(leaseMs)]);
  return r.rows[0] ?? null;
}
/** A run that ran out of attempts (its pod kept dying): failed, so a person is not left waiting. Resumable. */
export async function failExhausted(): Promise<Array<{ orgId: string; id: string; startedBy: string; projectId: string }>> {
  return (await q<{ orgId: string; id: string; startedBy: string; projectId: string }>('system',
    `UPDATE eval_runs SET state = 'failed', error_code = 'gave_up', finished_at = now(), lease_owner = NULL, lease_until = NULL
      WHERE state = 'running' AND lease_until < now() AND attempts >= ${MAX_ATTEMPTS} RETURNING org_id AS "orgId", id::text AS id, started_by AS "startedBy", project_id::text AS "projectId"`)).rows;
}
export async function heartbeat(org: string, id: string, owner: string, leaseMs = LEASE_MS): Promise<boolean> {
  return !!(await q('system', `UPDATE eval_runs SET lease_until = now() + ($4 || ' milliseconds')::interval WHERE org_id = $1 AND id = $2 AND lease_owner = $3 AND state = 'running'`, [org, id, owner, String(leaseMs)])).rowCount;
}
export async function flags(org: string, id: string, owner: string): Promise<{ stop: boolean; held: boolean }> {
  const r = (await q<{ stop: boolean; held: boolean }>('system', 'SELECT stop_requested AS stop, lease_owner = $3 AS held FROM eval_runs WHERE org_id = $1 AND id = $2', [org, id, owner])).rows[0];
  return { stop: !!r?.stop, held: !!r?.held };
}
/** The deadline, set once (a retake keeps it); the milliseconds left to it. */
export async function setDeadline(org: string, id: string, owner: string, ms: number): Promise<number> {
  const r = await q<{ left: string }>('system', `UPDATE eval_runs SET deadline_at = COALESCE(deadline_at, now() + ($4 || ' milliseconds')::interval)
    WHERE org_id = $1 AND id = $2 AND lease_owner = $3 RETURNING (extract(epoch FROM (deadline_at - now())) * 1000)::bigint::text AS left`, [org, id, owner, String(ms)]);
  return r.rows[0] ? Number(r.rows[0].left) : 0;
}
/** Which model judges this run (what resolved at the start), once. */
export async function setJudge(org: string, id: string, owner: string, label: string | null, own: boolean): Promise<boolean> {
  return !!(await q('system', 'UPDATE eval_runs SET judge = $4, judge_own = $5 WHERE org_id = $1 AND id = $2 AND lease_owner = $3', [org, id, owner, label, own])).rowCount;
}
/** A stopping pod hands its run back: the lease is lapsed at once and the attempt not counted. */
export async function release(org: string, id: string, owner: string): Promise<void> {
  await q('system', `UPDATE eval_runs SET lease_until = now() - interval '1 second', attempts = greatest(attempts - 1, 0) WHERE org_id = $1 AND id = $2 AND lease_owner = $3 AND state = 'running'`, [org, id, owner]);
}
export async function finish(org: string, id: string, owner: string, state: 'done' | 'partial' | 'failed' | 'stopped', code: string | null): Promise<boolean> {
  return !!(await q('system',
    // A stop asked for while the run was ending wins over `done` and `partial`.
    `UPDATE eval_runs SET state = CASE WHEN stop_requested AND $4::text IN ('done', 'partial') THEN 'stopped' ELSE $4::text END,
            error_code = CASE WHEN stop_requested AND $4::text IN ('done', 'partial') THEN NULL ELSE $5::text END, finished_at = now(), lease_owner = NULL, lease_until = NULL
      WHERE org_id = $1 AND id = $2 AND lease_owner = $3`, [org, id, owner, state, code])).rowCount;
}
/** `eval:runStop`: a queued run stops at once; a running one gets the flag its worker reads before every case. */
export async function requestStop(org: string, id: string): Promise<void> {
  await q({ org }, `UPDATE eval_runs SET stop_requested = true, state = CASE WHEN state = 'queued' THEN 'stopped' ELSE state END, finished_at = CASE WHEN state = 'queued' THEN now() ELSE finished_at END
    WHERE org_id = $1 AND id = $2 AND state IN ('queued', 'running')`, [org, id]);
}
/** `eval:runResume`: a partial or failed run goes back in the queue (a fresh time allowance; its results stay). False: not resumable, or the project has another run going. */
export async function requeue(org: string, id: string): Promise<boolean> {
  try {
    return !!(await q({ org }, `UPDATE eval_runs SET state = 'queued', stop_requested = false, error_code = NULL, finished_at = NULL, deadline_at = NULL, attempts = 0
      WHERE org_id = $1 AND id = $2 AND state IN ('partial', 'failed') AND error_code IS DISTINCT FROM 'access'`, [org, id])).rowCount;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return false;
    throw err;
  }
}

// ── results ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface NewResult {
  caseId: string; position: number; question: string; outcome: Outcome; checks: Check[]; judged: Judged; calls: number; errorCode: string | null;
  reply: string | null; why: string | null; datasetIds: string[];
}
/** Stores one case's result and recounts the run, fenced by the lease. False: the lease is no longer this owner's (nothing applied). Once per case: a repeat changes nothing. */
export async function recordResult(org: string, runId: string, owner: string, r: NewResult): Promise<boolean> {
  return scoped('system', async (c) => {
    const held = await c.query('SELECT 1 FROM eval_runs WHERE org_id = $1 AND id = $2 AND lease_owner = $3 FOR UPDATE', [org, runId, owner]);
    if (!held.rowCount) return false;
    await c.query(`INSERT INTO eval_results (org_id, run_id, case_id, position, question, outcome, checks, judged, score, calls, error_code, reply, why, dataset_ids)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14::jsonb) ON CONFLICT DO NOTHING`,
      [org, runId, r.caseId, r.position, r.question, r.outcome, JSON.stringify(r.checks), r.judged.state, r.judged.state === 'scored' ? r.judged.score : null, r.calls, r.errorCode, r.reply, r.why, JSON.stringify(r.datasetIds)]);
    await c.query(`UPDATE eval_runs SET cases_done = s.n, passed = s.p, failed = s.f, not_scored = s.ns, model_calls = s.calls
        FROM (SELECT count(*)::int AS n, (count(*) FILTER (WHERE outcome = 'pass'))::int AS p, (count(*) FILTER (WHERE outcome IN ('fail', 'error')))::int AS f,
                     (count(*) FILTER (WHERE outcome = 'not_scored'))::int AS ns, coalesce(sum(calls), 0)::int AS calls FROM eval_results WHERE org_id = $1 AND run_id = $2) s
       WHERE org_id = $1 AND id = $2`, [org, runId]);
    return true;
  });
}
export interface Result {
  caseId: string; position: number; question: string; outcome: Outcome; checks: Check[]; judged: Judged['state']; score: number | null; calls: number; errorCode: string | null;
  reply: string | null; why: string | null; datasetIds: string[];
}
export async function resultsOf(org: string, runId: string): Promise<Result[]> {
  return (await q<Result>({ org }, `SELECT case_id::text AS "caseId", position, question, outcome, checks, judged, score, calls, error_code AS "errorCode", reply, why, dataset_ids AS "datasetIds"
    FROM eval_results WHERE org_id = $1 AND run_id = $2 ORDER BY position, case_id`, [org, runId])).rows;
}
export async function doneCaseIds(org: string, runId: string): Promise<Set<string>> {
  return new Set((await q<{ id: string }>({ org }, 'SELECT case_id::text AS id FROM eval_results WHERE org_id = $1 AND run_id = $2', [org, runId])).rows.map((r) => r.id));
}

// ── the Judge model setting (Admin -> AI) ────────────────────────────────────────────────────────────────────────────────

export async function judgePick(org: string): Promise<{ provider: string; model: string } | null> {
  return (await q<{ provider: string; model: string }>({ org }, 'SELECT judge_provider AS provider, judge_model AS model FROM org_eval_settings WHERE org_id = $1', [org])).rows[0] ?? null;
}
export async function saveJudge(org: string, pick: { provider: string; model: string } | null): Promise<void> {
  if (!pick) await q({ org }, 'DELETE FROM org_eval_settings WHERE org_id = $1', [org]);
  else await q({ org }, `INSERT INTO org_eval_settings (org_id, judge_provider, judge_model) VALUES ($1, $2, $3) ON CONFLICT (org_id) DO UPDATE SET judge_provider = $2, judge_model = $3, updated_at = now()`, [org, pick.provider, pick.model]);
}

// ── the per-org sweep ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Hidden conversations a crash left (older than an hour), the oldest runs past 30 a suite, and the question text of a thumbs-down whose conversation is gone. */
export async function sweep(org: string): Promise<{ threads: number; runs: number; questions: number }> {
  return scoped({ org }, async (c) => {
    const threads = (await c.query(`DELETE FROM assistant_threads WHERE org_id = $1 AND hidden AND updated_at < now() - interval '1 hour'`, [org])).rowCount ?? 0;
    const runs = (await c.query(`DELETE FROM eval_runs r WHERE r.org_id = $1 AND r.state NOT IN ('queued', 'running') AND r.id IN (
        SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY suite_id ORDER BY started_at DESC) AS n FROM eval_runs WHERE org_id = $1) x WHERE x.n > 30)`, [org])).rowCount ?? 0;
    const questions = (await c.query(`UPDATE assistant_feedback f SET question = NULL WHERE f.org_id = $1 AND f.question IS NOT NULL AND (
        NOT EXISTS (SELECT 1 FROM assistant_turns t WHERE t.org_id = f.org_id AND t.id::text = f.turn_id)
        OR NOT EXISTS (SELECT 1 FROM users u WHERE u.org_id = f.org_id AND u.email = f.owner))`, [org])).rowCount ?? 0;
    return { threads, runs, questions };
  });
}
