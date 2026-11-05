// Check the Assistant (semantic layer part 3 D13 (3), Q3): an editor asks the project's own model each working
// verified question once, by its own words, and the app scores each reply's SPEC with the one judge (./verifiedJudge).
//
// - The run is a job on the in-process queue (../app/jobs): the Postgres runner only runs recurring schedules (plan
//   index call 1). `startCheck` answers at once with the run id, so no RPC timeout applies.
// - Progress and result are ONE project record, `projects/<id>/assistant-check.json` (recordFs, atomic), written before
//   the job is queued and after every question, so any pod reads them. A pod that died mid-run leaves a stale
//   heartbeat, read as `stopped`; one run per project at a time otherwise (checked and written under one lock).
// - Leave-one-out: `askCopilot` is called directly, never `copilot:ask`, so an exact hit never short-circuits a
//   question, and its own entry is no example. The run is the starting editor's request context: their row lock, model.
// - The record holds outcomes and reasons only: no spec, no figure, no prompt. On Live the judge compares specs only.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as jobs from '../app/jobs';
import * as recordFs from '../app/recordFs';
import * as execConfig from '../app/execConfig';
import * as analyze from '../ai/analyze';
import { projectDir, isValidId } from '../app/recordKinds';
import { osUser } from '../app/catalog';
import type { VerifiedQuestion } from '../analysis/verifiedRules';
import { buildFacts } from './copilot';
import { askGuidance } from './guidance';
import { verifiedStates } from './verifiedState';
import { judgeSpec, type Outcome } from './verifiedJudge';
import * as msg from './assistantCheckMessages';

export const CHECK_MAX = 50, CHECK_STALE_MS = 120_000;
const TEXT_MAX = 300;

export type CheckState = 'running' | 'done' | 'stopped' | 'error';
export interface CheckResult { id: string; outcome: Outcome; reason?: string }
export interface CheckRun {
  runId: string;
  state: CheckState;
  startedBy: string;
  startedAt: string;
  heartbeatAt: string;
  finishedAt?: string;
  total: number;
  asked: number;
  matched: number;
  skipped: number;
  results: CheckResult[];
  error?: string;
}

const STATES: ReadonlySet<string> = new Set(['running', 'done', 'stopped', 'error']);
const OUTCOMES: ReadonlySet<string> = new Set(['match', 'differs', 'refused']);
const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);
const text = (v: unknown, max = TEXT_MAX): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** The record as stored, shape-checked field by field (it is disk input); null when it is not one. Idempotent. */
export function sanitizeCheck(raw: unknown): CheckRun | null {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!o || !isValidId(o.runId) || !STATES.has(o.state as string)) return null;
  const results: CheckResult[] = [];
  for (const r of Array.isArray(o.results) ? o.results.slice(0, CHECK_MAX) : []) {
    const x = r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
    if (!x || !isValidId(x.id) || !OUTCOMES.has(x.outcome as string)) continue;
    results.push({ id: x.id as string, outcome: x.outcome as Outcome, ...(typeof x.reason === 'string' ? { reason: text(x.reason) } : {}) });
  }
  return {
    runId: o.runId as string, state: o.state as CheckState, startedBy: text(o.startedBy, 200), startedAt: text(o.startedAt, 40), heartbeatAt: text(o.heartbeatAt, 40),
    ...(typeof o.finishedAt === 'string' ? { finishedAt: text(o.finishedAt, 40) } : {}),
    total: count(o.total), asked: count(o.asked), matched: count(o.matched), skipped: count(o.skipped), results,
    ...(typeof o.error === 'string' ? { error: text(o.error) } : {}),
  };
}

const fileOf = (projectId: string): string => path.join(projectDir(projectId), 'assistant-check.json');

/** The stored record, or null (none, corrupt, a bad id). */
async function readStored(projectId: string): Promise<CheckRun | null> {
  if (!isValidId(projectId)) return null;
  try {
    return sanitizeCheck(JSON.parse(await recordFs.readFile(fileOf(projectId), 'utf8')));
  } catch (_) {
    return null;
  }
}

/** The project's last check; a `running` one whose heartbeat is stale (its pod died) reads as `stopped`. */
export async function readCheck(projectId: string): Promise<CheckRun | null> {
  const run = await readStored(projectId);
  if (run?.state === 'running' && !(Date.now() - Date.parse(run.heartbeatAt) < CHECK_STALE_MS)) return { ...run, state: 'stopped' };
  return run;
}

async function write(projectId: string, run: CheckRun): Promise<void> {
  const file = fileOf(projectId);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(run), 'utf8');
  await recordFs.rename(tmp, file);
}

/** Write `run` unless a newer run took the record over (this one's heartbeat went stale meanwhile): false then. */
function writeMine(projectId: string, run: CheckRun): Promise<boolean> {
  return recordFs.locked(fileOf(projectId), async () => {
    if ((await readStored(projectId))?.runId !== run.runId) return false;
    await write(projectId, run);
    return true;
  });
}

/** One question: its guidance without its own entry, one model call, the judge. */
async function askOne(projectId: string, facts: string, q: VerifiedQuestion): Promise<CheckResult> {
  const guided = await askGuidance(projectId, { kind: '' }, 'project', q.question, { exclude: q.id });
  const res = await analyze.askCopilot([], [facts, guided.text].filter(Boolean).join('\n\n'), q.question);
  if (!res.ok) return { id: q.id, outcome: 'refused', reason: text(res.message) };
  if (res.suggestedAction.kind !== 'answer') return { id: q.id, outcome: 'refused', reason: msg.checkNoChart() };
  const j = await judgeSpec(projectId, q, res.suggestedAction.spec);
  return { id: q.id, outcome: j.outcome, ...(j.reason ? { reason: text(j.reason) } : {}) };
}

async function runCheck(projectId: string, run: CheckRun, questions: VerifiedQuestion[], jc: jobs.JobContext): Promise<void> {
  try {
    const facts = (await buildFacts(projectId, {})).text; // the project inventory, once per run
    for (const q of questions) {
      jc.checkCancelled();
      const r = await askOne(projectId, facts, q);
      run.results.push(r);
      run.asked++;
      if (r.outcome === 'match') run.matched++;
      run.heartbeatAt = new Date().toISOString();
      if (!(await writeMine(projectId, run))) throw new jobs.JobCancelled(); // taken over: stop, write nothing
      jc.progress(run.asked / run.total);
    }
    run.state = 'done';
  } catch (err) {
    run.state = err instanceof jobs.JobCancelled || jc.signal.aborted ? 'stopped' : 'error';
    if (run.state === 'error') run.error = text(err instanceof Error ? err.message : String(err)) || 'Something went wrong.';
    run.finishedAt = new Date().toISOString();
    await writeMine(projectId, run).catch(() => false);
    throw err;
  }
  run.finishedAt = new Date().toISOString();
  await writeMine(projectId, run);
}

/** Start a check as the caller: refused with a sentence when there is no model, nothing to ask, or one runs already. */
export async function startCheck(projectId: string): Promise<{ ok: true; runId: string; done: Promise<unknown> } | { ok: false; error: string }> {
  if (!(await execConfig.executionReady())) return { ok: false, error: msg.checkNoModel() };
  const working = (await verifiedStates(projectId)).filter((s) => s.problem === null && !s.hidden); // newest first
  if (!working.length) return { ok: false, error: msg.checkNothing() };
  const questions = working.slice(0, CHECK_MAX).map((s) => s.q);
  const now = new Date().toISOString();
  const run: CheckRun = {
    runId: randomUUID(), state: 'running', startedBy: osUser(), startedAt: now, heartbeatAt: now,
    total: questions.length, asked: 0, matched: 0, skipped: working.length - questions.length, results: [],
  };
  const claimed = await recordFs.locked(fileOf(projectId), async () => {
    if ((await readCheck(projectId))?.state === 'running') return false;
    await write(projectId, run);
    return true;
  });
  if (!claimed) return { ok: false, error: msg.checkRunning() };
  try {
    const job = jobs.submit({ kind: 'assistant-check', label: msg.checkLabel(), projectId, cancellable: true, run: (jc) => runCheck(projectId, run, questions, jc) });
    return { ok: true, runId: run.runId, done: job.done };
  } catch (err) { // a draining pod refuses new jobs: the record must not say running
    const error = text(err instanceof Error ? err.message : String(err));
    await writeMine(projectId, { ...run, state: 'error', error, finishedAt: new Date().toISOString() });
    return { ok: false, error };
  }
}

