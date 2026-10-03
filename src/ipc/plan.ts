import { ipcMain } from './bus';
import { randomUUID } from 'crypto';
import { sanitizePlanStep, sanitizePlanSteps, describeStep, STEP_ICONS } from '../ai/planSteps';
import { checkPlan } from '../ai/planCheck';
import type { StepCheck } from '../ai/planCheck';
import { newRun, runNext, skipStep, replaceStep, stopRun, undoRun, canUndo, nextIndex } from '../ai/planRun';
import type { PlanRun } from '../ai/planRun';
import { RUN_DEPS, loadProjectCtx, undoGroup, logRun, fixStep } from '../ai/planExec';

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
// A run lives in memory for the session: its undo needs the before-images it
// captured, and a restart ends it (every write is still in version history and
// the Trash). Finishing, stopping or undoing logs the run to the dock
// conversation it came from.

const MAX_RUNS = 20;
const runs = new Map<string, PlanRun>();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function keep(run: PlanRun): void {
  runs.set(run.id, run);
  while (runs.size > MAX_RUNS) {
    const oldest = runs.keys().next().value;
    if (oldest === undefined) break;
    runs.delete(oldest);
  }
}

function lines(run: PlanRun): Array<{ text: string; icon: string }> {
  return run.steps.map((s) => ({ text: describeStep(s), icon: STEP_ICONS[s.kind] }));
}

/** What the card draws. Never a row; every figure app-computed. */
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

async function logIfOver(run: PlanRun): Promise<string | undefined> {
  if (run.state === 'finished' || run.state === 'stopped' || run.state === 'undone') return logRun(run);
  return undefined;
}

function runOf(runId: unknown): PlanRun | null {
  return typeof runId === 'string' ? runs.get(runId) || null : null;
}

const GONE = { ok: false, error: 'That plan run has ended — ask again to start a new one.' };

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
    const run = newRun(randomUUID(), String(projectId), typeof threadId === 'string' ? threadId : '',
      typeof intent === 'string' ? intent.slice(0, 400) : '', clean.steps);
    keep(run);
    return snapshot(run);
  });

  ipcMain.handle('plan:next', async (_e, { runId }: any = {}) => {
    const run = runOf(runId);
    if (!run) return GONE;
    const ran = await runNext(run, RUN_DEPS);
    return snapshot(run, { ran, log: await logIfOver(run) });
  });

  ipcMain.handle('plan:skip', async (_e, { runId, index }: any = {}) => {
    const run = runOf(runId);
    if (!run) return GONE;
    const done = skipStep(run, Number(index));
    return snapshot(run, { skipped: done, log: done ? await logIfOver(run) : undefined });
  });

  ipcMain.handle('plan:replace', async (_e, { runId, index, step }: any = {}) => {
    const run = runOf(runId);
    if (!run) return GONE;
    const clean = sanitizePlanStep(step);
    if (!clean) return { ...snapshot(run), ok: false, error: 'That is not a step.' };
    return snapshot(run, { replaced: replaceStep(run, Number(index), clean) });
  });

  ipcMain.handle('plan:fix', async (_e, { runId, index }: any = {}) => {
    const run = runOf(runId);
    if (!run) return GONE;
    const i = Number(index);
    if (run.status[i] !== 'failed') return { ...snapshot(run), ok: false, error: 'Only a failed step can be fixed.' };
    const res = await fixStep(run, i).catch((err: any) => ({ ok: false as const, error: err?.message || 'Fix failed.' }));
    if (!res.ok) return { ...snapshot(run), ok: false, error: res.error };
    replaceStep(run, i, res.step);
    return snapshot(run, { fixed: i });
  });

  ipcMain.handle('plan:stop', async (_e, { runId }: any = {}) => {
    const run = runOf(runId);
    if (!run) return GONE;
    const done = stopRun(run);
    return snapshot(run, { log: done ? await logIfOver(run) : undefined });
  });

  ipcMain.handle('plan:undo', async (_e, { runId }: any = {}) => {
    const run = runOf(runId);
    if (!run) return GONE;
    if (!canUndo(run)) return { ...snapshot(run), ok: false, error: 'Nothing to undo.' };
    await undoRun(run, (g) => undoGroup(run.projectId, g));
    return snapshot(run, { log: await logIfOver(run) });
  });
}
