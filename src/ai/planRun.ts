// Running an Assistant plan — the state machine, the undo grouping, and the
// log line. MAIN PROCESS ONLY. Pure: every read and write goes through the
// `RunDeps` the caller passes (src/ai/planExec.ts in the app, fakes in
// scripts/test-planRun.ts), which is what lets the failure semantics and the
// undo grouping be tested without a project on disk.
//
// The rules, all enforced here:
//   · IN ORDER. Only the first step that is neither done nor skipped can run.
//   · RE-CHECKED. Right before a step runs it is validated again (planCheck)
//     against the project AS IT NOW IS — which is where a step deferred behind
//     an import is finally checked against real columns.
//   · A FAILURE STOPS THE RUN on that step, with the app's own error. Nothing
//     after it runs. The user then picks Fix (the step is replaced and runs
//     again), Skip (marked skipped; the next step's own check decides whether
//     it can still run without it) or Stop (the run ends; nothing is undone).
//   · ONE UNDO GROUP PER RECORD. Every write a step makes is a Touch. Undo folds
//     them per record: a record the run CREATED goes to the Trash (restorable
//     there for 30 days), a record it CHANGED is written back to what it was
//     before the run's FIRST change to it — however many steps touched it — and
//     records are undone newest-first, so a dashboard goes before the visuals on
//     it and a visual before the dataset under it.

import { checkStep } from './planCheck';
import type { PlanCtx } from './planCheck';
import { describeStep } from './planSteps';
import type { PlanStep } from './planSteps';

export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';
export type RunState = 'ready' | 'running' | 'paused' | 'failed' | 'finished' | 'stopped' | 'undone';
export type LinkType = 'dataset' | 'visual' | 'metric' | 'dashboard' | 'alert';

export interface RecordLink { type: LinkType; id: string; name: string }

/** What a step did, for the line under it. Every figure is app-computed. */
export interface StepResult {
  summary: string;
  rowsBefore?: number;
  rowsAfter?: number;
  link?: RecordLink;
  kpis?: Array<{ name: string; display: string }>;
}

/** One write. `before` is the record's content before THIS write (absent when created). */
export interface Touch {
  type: LinkType;
  id: string;
  name: string;
  created: boolean;
  before?: unknown;
}

export type StepOutcome =
  | { ok: true; result: StepResult; touches: Touch[] }
  | { ok: false; error: string; touches?: Touch[] };

export interface PlanRun {
  id: string;
  projectId: string;
  threadId: string;
  intent: string;
  steps: PlanStep[];
  status: StepStatus[];
  results: Array<StepResult | null>;
  errors: Array<string | null>;
  touches: Touch[];
  state: RunState;
  undo?: UndoReport;
}

export interface RunDeps {
  /** The project as it is now, with this run's own records marked `fromRun`. */
  loadCtx: (run: PlanRun) => Promise<PlanCtx>;
  execute: (run: PlanRun, step: PlanStep, index: number, ctx: PlanCtx) => Promise<StepOutcome>;
}

export interface UndoGroup {
  type: LinkType;
  id: string;
  name: string;
  action: 'trash' | 'restore';
  before?: unknown;
}

export interface UndoReport { undone: number; failed: Array<{ name: string; error: string }> }

export type UndoExec = (group: UndoGroup) => Promise<{ ok: boolean; error?: string }>;

export function newRun(id: string, projectId: string, threadId: string, intent: string, steps: PlanStep[]): PlanRun {
  return {
    id, projectId, threadId, intent,
    steps: steps.slice(),
    status: steps.map(() => 'pending'),
    results: steps.map(() => null),
    errors: steps.map(() => null),
    touches: [],
    state: 'ready',
  };
}

/** The step that runs next: the first not yet done or skipped. -1 when none is left. */
export function nextIndex(run: PlanRun): number {
  return run.status.findIndex((s) => s === 'pending' || s === 'failed' || s === 'running');
}

function settle(run: PlanRun): void {
  run.state = nextIndex(run) < 0 ? 'finished' : 'paused';
}

function isOver(run: PlanRun): boolean {
  return run.state === 'finished' || run.state === 'stopped' || run.state === 'undone';
}

/**
 * Run the next step. Returns the index it ran, or -1 when there was nothing it
 * could run (the run is over, or already running). Never throws: an executor
 * that throws is a failed step with its message.
 */
export async function runNext(run: PlanRun, deps: RunDeps): Promise<number> {
  if (isOver(run) || run.state === 'running') return -1;
  const i = nextIndex(run);
  if (i < 0) { run.state = 'finished'; return -1; }
  run.state = 'running';
  run.status[i] = 'running';
  run.errors[i] = null;

  let outcome: StepOutcome;
  try {
    const ctx = await deps.loadCtx(run);
    const { check } = checkStep(run.steps[i], ctx, i);
    outcome = check.ok
      ? await deps.execute(run, run.steps[i], i, ctx)
      : { ok: false, error: check.error || 'This step is not valid any more.' };
  } catch (err: unknown) {
    outcome = { ok: false, error: err instanceof Error && err.message ? err.message : 'The step failed.' };
  }

  // A step that failed PART-WAY still made its writes; they belong to the undo.
  if (outcome.touches) run.touches.push(...outcome.touches);
  if (outcome.ok) {
    run.status[i] = 'done';
    run.results[i] = outcome.result;
    settle(run);
  } else {
    run.status[i] = 'failed';
    run.errors[i] = outcome.error;
    run.state = 'failed';
  }
  return i;
}

/** Skip the step that would run next (the failed one, or a pending one while stepping through). */
export function skipStep(run: PlanRun, index: number): boolean {
  if (isOver(run) || run.state === 'running' || index !== nextIndex(run)) return false;
  run.status[index] = 'skipped';
  run.errors[index] = null;
  settle(run);
  return true;
}

/** Replace a step that has not run (Edit, or Fix after a failure). */
export function replaceStep(run: PlanRun, index: number, step: PlanStep): boolean {
  if (isOver(run) || run.state === 'running') return false;
  const st = run.status[index];
  if (st !== 'pending' && st !== 'failed') return false;
  run.steps[index] = step;
  run.status[index] = 'pending';
  run.errors[index] = null;
  if (run.state === 'failed') run.state = 'paused';
  return true;
}

export function stopRun(run: PlanRun): boolean {
  if (isOver(run) || run.state === 'running') return false;
  run.state = 'stopped';
  return true;
}

/** Fold the run's writes into one group per record, newest record first. */
export function undoGroups(touches: readonly Touch[]): UndoGroup[] {
  const byKey = new Map<string, UndoGroup>();
  for (const t of touches) {
    const key = t.type + ':' + t.id;
    const g = byKey.get(key);
    if (!g) {
      byKey.set(key, t.created
        ? { type: t.type, id: t.id, name: t.name, action: 'trash' }
        : { type: t.type, id: t.id, name: t.name, action: 'restore', before: t.before });
    } else if (t.created) {
      // Created by the run after all (a later touch says so): nothing to restore.
      g.action = 'trash';
      delete g.before;
    }
  }
  return Array.from(byKey.values()).reverse();
}

export function canUndo(run: PlanRun): boolean {
  return run.state !== 'running' && run.state !== 'undone' && run.touches.length > 0;
}

/** Undo everything the run wrote. A group that fails is reported, and the rest still run. */
export async function undoRun(run: PlanRun, exec: UndoExec): Promise<UndoReport> {
  const report: UndoReport = { undone: 0, failed: [] };
  if (!canUndo(run)) return report;
  for (const g of undoGroups(run.touches)) {
    let res: { ok: boolean; error?: string };
    try { res = await exec(g); } catch (err: unknown) {
      res = { ok: false, error: err instanceof Error ? err.message : 'Undo failed.' };
    }
    if (res.ok) report.undone += 1;
    else report.failed.push({ name: g.name, error: res.error || 'Undo failed.' });
  }
  run.state = 'undone';
  run.undo = report;
  return report;
}

const MARK: Record<StepStatus, string> = { pending: '·', running: '…', done: '✓', skipped: '–', failed: '✗' };

/** The run as one assistant turn in the dock's conversation. App-written; every figure app-computed. */
export function runLogText(run: PlanRun): string {
  const done = run.status.filter((s) => s === 'done').length;
  const head = run.state === 'undone'
    ? `Plan run undone — ${run.undo ? run.undo.undone : 0} record${run.undo && run.undo.undone === 1 ? '' : 's'} put back.`
    : run.state === 'stopped'
      ? `Plan run stopped — ${done} of ${run.steps.length} steps done.`
      : `Plan run finished — ${done} of ${run.steps.length} steps done.`;
  const lines = run.steps.map((s, i) => {
    const r = run.results[i];
    let tail = '';
    if (run.status[i] === 'failed') tail = ` — failed: ${run.errors[i] || 'error'}`;
    else if (run.status[i] === 'skipped') tail = ' — skipped';
    else if (run.status[i] === 'pending') tail = ' — not run';
    else if (r) tail = ` — ${r.summary}`;
    return `${i + 1}. ${MARK[run.status[i]]} ${describeStep(s)}${tail}`;
  });
  const failed = run.undo && run.undo.failed.length
    ? ['Could not undo: ' + run.undo.failed.map((f) => `${f.name} (${f.error})`).join('; ')]
    : [];
  return [head, ...lines, ...failed].join('\n');
}
