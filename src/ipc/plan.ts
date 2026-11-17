import { ipcMain } from './bus';
import { randomUUID } from 'crypto';
import { sanitizePlanStep, sanitizePlanSteps, describeStep, STEP_ICONS } from '../ai/planSteps';
import { checkPlan } from '../ai/planCheck';
import type { StepCheck } from '../ai/planCheck';
import { newRun, skipStep, replaceStep, stopRun, undoRun, canUndo, nextIndex, beginStep, executeStep, addTouches, endStep } from '../ai/planRun';
import type { PlanRun, StepOutcome, UndoReport } from '../ai/planRun';
import { RUN_DEPS, loadProjectCtx, undoGroup, logRun, fixStep } from '../ai/planExec';
import * as store from '../ai/planStore';
import * as copilot from '../ai/copilot';
import { askScope } from './agentAsk';
import { askThread } from './turnsOpen';
import { agentAnswersOnly } from '../ai/agentMessages';

// Assistant plans IPC — check a proposed plan, then run it one click at a time.
// MAIN PROCESS. The model proposed the steps (src/ai/suggestedAction.ts); every
// decision after that is app code:
//
//   plan:check    validate every step (src/ai/planCheck.ts) — before the card shows
//   plan:start    open a run (nothing executes)
//   plan:next     run the next step (each is re-checked against the project as it now is)
//   plan:skip     skip the step that would run next
//   plan:replace  swap a step that has not run (Edit)
//   plan:fix      re-ask the model with the app's error, check its answer, swap it in
//   plan:stop     end the run; what ran stays
//   plan:undo     undo the run, one group per record touched
//
// A run is a RECORD under its project (src/ai/planStore.ts), so every call may
// land on any pod: each names its project (the contracts' scope) and the run is
// read from exactly that project's path. A step runs between a locked claim and
// a locked apply, never under a lock. Finishing, stopping or undoing logs the
// run to the dock conversation it came from. `plan:next` may carry the upload
// (`fileToken`, POST /api/files) an import step reads; it is never stored.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lines(run: PlanRun): Array<{ text: string; icon: string }> {
  return run.steps.map((s) => ({ text: describeStep(s), icon: STEP_ICONS[s.kind] }));
}

/** What the card draws. Never a row; every figure app-computed. Never who started it or the lease. */
function snapshot(run: PlanRun, extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    runId: run.id,
    state: run.state,
    steps: run.steps,
    lines: lines(run),
    status: run.status,
    results: run.results,
    errors: run.errors,
    next: nextIndex(run),
    canUndo: canUndo(run),
    undo: run.undo || null,
    ...extra,
  };
}

/**
 * The run's log, written once per ending (an undo after a finished run logs once more). A repeat, on any pod, finds the
 * mark on the record it read and returns: no write, no log. The first call marks the record under its lock, which
 * decides a race between two such calls.
 */
async function logIfOver(run: PlanRun): Promise<string | undefined> {
  if (run.state !== 'finished' && run.state !== 'stopped' && run.state !== 'undone') return undefined;
  if (run.logged === run.state) return undefined;
  const first = await store.update(run.projectId, run.id, (r) => {
    if (r.state !== run.state || r.logged === r.state) return false;
    r.logged = r.state;
    return true;
  });
  if (!first?.out) return undefined;
  // Into the conversation it came from, as an ask lands: a new one when every turn of that one is hidden from the caller (./turnsOpen).
  const { into } = await askThread(run.projectId, run.threadId || undefined);
  return logRun({ ...run, threadId: into?.id ?? (await copilot.createThread(run.projectId))?.id ?? '' });
}

const GONE = { ok: false, error: 'That plan run has ended. Ask again to start a new one.' };
const BUSY = 'This plan is still working on a step. Try again in a moment.';
const ids = (projectId: unknown, runId: unknown): [string, string] | null =>
  UUID_RE.test(String(projectId || '')) && UUID_RE.test(String(runId || '')) ? [String(projectId), String(runId)] : null;

export function register(): void {
  ipcMain.handle('plan:check', async (_e, { projectId, steps }: any = {}) => {
    try {
      if (!UUID_RE.test(String(projectId || ''))) return { ok: false, error: 'No project.' };
      const clean = sanitizePlanSteps(steps);
      const checks: StepCheck[] = checkPlan(clean.steps, await loadProjectCtx(String(projectId)));
      return {
        ok: true,
        steps: clean.steps,
        dropped: clean.dropped,
        lines: clean.steps.map((s) => ({ text: describeStep(s), icon: STEP_ICONS[s.kind] })),
        checks,
      };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not check the plan.' };
    }
  });

  ipcMain.handle('plan:start', async (_e, { projectId, threadId, intent, steps }: any = {}) => {
    if (!UUID_RE.test(String(projectId || ''))) return { ok: false, error: 'No project.' };
    const clean = sanitizePlanSteps(steps);
    if (!clean.steps.length) return { ok: false, error: 'The plan has no steps.' };
    // A plan from a conversation with an Assistant agent that may only answer is refused (docs/assistant-agents rule 8).
    // Not the agent of a conversation whose every turn is hidden from the caller: to them it is none (./turnsOpen).
    const tid = typeof threadId === 'string' && threadId ? threadId : undefined;
    const into = tid ? (await askThread(String(projectId), tid)).into : null;
    const convAgent = tid && into?.id === tid ? into.agentId : undefined;
    const { agent } = await askScope(String(projectId), convAgent); // a personal API token keeps the Project assistant (rule 13)
    if (agent && !agent.build) return { ok: false, error: agentAnswersOnly(agent.name) };
    const run = newRun(randomUUID(), String(projectId), typeof threadId === 'string' ? threadId : '',
      typeof intent === 'string' ? intent.slice(0, 400) : '', clean.steps);
    return snapshot(await store.create(run));
  });

  ipcMain.handle('plan:next', async (_e, { projectId, runId, fileToken }: any = {}) => {
    const at = ids(projectId, runId);
    if (!at) return GONE;
    const c = await store.claim(at[0], at[1], 'step', beginStep);
    if (!c) return GONE;
    if (c.busy) return { ...snapshot(c.run), ok: false, error: BUSY };
    if (c.index < 0) return snapshot(c.run, { ran: -1, log: await logIfOver(c.run) });
    // The step runs on this copy, outside any lock; the upload token rides on it for this request only.
    const work: PlanRun = { ...structuredClone(c.run), ...(typeof fileToken === 'string' ? { fileToken } : {}) };
    const beat = store.heartbeat(at[0], at[1], c.claim);
    let outcome: StepOutcome;
    try {
      outcome = await executeStep(work, c.index, RUN_DEPS);
    } finally {
      beat.stop();
    }
    const run = await store.apply(at[0], at[1], c.claim, (r) => addTouches(r, outcome), (r) => endStep(r, c.index, outcome));
    if (!run) return GONE;
    return snapshot(run, { ran: c.index, log: await logIfOver(run) });
  });

  ipcMain.handle('plan:skip', async (_e, { projectId, runId, index }: any = {}) => {
    const at = ids(projectId, runId);
    const r = at && (await store.update(at[0], at[1], (run) => !run.lease && skipStep(run, Number(index))));
    if (!r) return GONE;
    return snapshot(r.run, { skipped: r.out, log: r.out ? await logIfOver(r.run) : undefined });
  });

  // No contract (unreachable over HTTP); kept in step with the others.
  ipcMain.handle('plan:replace', async (_e, { projectId, runId, index, step }: any = {}) => {
    const at = ids(projectId, runId);
    const clean = sanitizePlanStep(step);
    const r = at && (await store.update(at[0], at[1], (run) => !!clean && !run.lease && replaceStep(run, Number(index), clean)));
    if (!r) return GONE;
    if (!clean) return { ...snapshot(r.run), ok: false, error: 'That is not a step.' };
    return snapshot(r.run, { replaced: r.out });
  });

  ipcMain.handle('plan:fix', async (_e, { projectId, runId, index }: any = {}) => {
    const at = ids(projectId, runId);
    const before = at && (await store.read(at[0], at[1]));
    if (!at || !before) return GONE;
    const i = Number(index);
    if (before.status[i] !== 'failed') return { ...snapshot(before), ok: false, error: 'Only a failed step can be fixed.' };
    // The model is asked with no lock held; its answer is applied only if the step is still the failed one.
    const res = await fixStep(before, i).catch((err: any) => ({ ok: false as const, error: err?.message || 'Fix failed.' }));
    if (!res.ok) return { ...snapshot(before), ok: false, error: res.error };
    const r = await store.update(at[0], at[1], (run) => !run.lease && run.status[i] === 'failed' && replaceStep(run, i, res.step));
    if (!r) return GONE;
    return r.out ? snapshot(r.run, { fixed: i }) : { ...snapshot(r.run), ok: false, error: BUSY };
  });

  ipcMain.handle('plan:stop', async (_e, { projectId, runId }: any = {}) => {
    const at = ids(projectId, runId);
    const r = at && (await store.update(at[0], at[1], (run) => !run.lease && stopRun(run)));
    if (!r) return GONE;
    return snapshot(r.run, { log: r.out ? await logIfOver(r.run) : undefined });
  });

  ipcMain.handle('plan:undo', async (_e, { projectId, runId }: any = {}) => {
    const at = ids(projectId, runId);
    if (!at) return GONE;
    const c = await store.claim(at[0], at[1], 'undo', (run) => {
      if (!canUndo(run)) return -1;
      run.state = 'running';
      return 0;
    });
    if (!c) return GONE;
    if (c.busy) return { ...snapshot(c.run), ok: false, error: BUSY };
    if (c.index < 0) return { ...snapshot(c.run), ok: false, error: 'Nothing to undo.' };
    const beat = store.heartbeat(at[0], at[1], c.claim);
    let report: UndoReport;
    try {
      report = await undoRun(c.before, (g) => undoGroup(at[0], g));
    } finally {
      beat.stop();
    }
    // The records are back whatever happened to the lease: the report and `undone` are facts, applied either way.
    const done = (r: PlanRun): void => { r.state = 'undone'; r.undo = report; };
    const run = await store.apply(at[0], at[1], c.claim, done, () => undefined);
    if (!run) return GONE;
    return snapshot(run, { log: await logIfOver(run) });
  });
}
