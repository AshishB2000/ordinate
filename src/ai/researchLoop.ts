// Deep research: the run's loop — PURE (every dependency and the clock are injected).
//
// One iteration is one model call (a STEP in the limit's sense). Checked before every model call, and again before the
// step it chose is run: the lease (lost: stop, write nothing), the stop flag, the deadline, then the caller's access,
// then the limits. A step the app refuses (the reply did not parse, a gate said no) is recorded with the app's reason
// and counts toward the steps, not the queries; it is never repaired. An accepted step is one engine query, whatever
// the outcome of it. A resumed run continues from its stored steps and counts: nothing finished is run again.
//
//   queued -> running -> writing -> done        partial (a limit, a deadline, or a write that failed)
//                                               failed (a model, budget or access failure; resumable except access)
//                                               stopped (by the user)

import type { LedgerEntry } from './numberAudit';
import type { ResearchAction } from './researchActions';

export interface Limits { steps: number; queries: number; minutes: number }
export const DEFAULT_LIMITS: Limits = { steps: 8, queries: 12, minutes: 10 };
export const CEILING: Limits = { steps: 20, queries: 30, minutes: 30 };

export type StepStatus = 'done' | 'refused' | 'failed';
/** One step as the run keeps it. `facts` and `ledger` NEVER reach a browser (./researchWrite `publicStep`). */
export interface StepRec {
  n: number;
  kind: 'answer' | 'sql' | 'drivers' | 'none';
  title: string;
  status: StepStatus;
  reason?: string;
  /** What draws the chart again: an answer spec, a drivers request, or `{ sql, datasetIds, title }`. */
  spec?: Record<string, unknown>;
  facts?: string;
  ledger?: LedgerEntry[];
  datasetIds?: string[];
}

export interface LoopState { steps: StepRec[]; stepsUsed: number; queriesUsed: number }
export type End = 'done' | 'steps' | 'queries' | 'deadline' | 'stopped' | 'lost' | 'model' | 'access';

export type Decision = { ok: true; action: ResearchAction } | { ok: false; refused: string } | { ok: false; fatal: 'model' | 'limited' };
export type Computed = { status: 'done'; title: string; spec: Record<string, unknown>; facts: string; ledger: LedgerEntry[]; datasetIds: string[] } | { status: 'refused' | 'failed'; reason: string; title?: string };

export interface LoopDeps {
  now(): number;
  /** Epoch ms the run's time allowance ends. */
  deadline: number;
  /** The lease signal: aborted when another pod retook the run. */
  lost(): boolean;
  stopRequested(): Promise<boolean>;
  /** The starter may still write here (re-read each time). */
  allowed(): Promise<boolean>;
  /** One model call and the parse of its reply. */
  decide(steps: readonly StepRec[]): Promise<Decision>;
  /** Runs an accepted action; never throws (an engine failure is a `failed` result). */
  compute(action: Exclude<ResearchAction, { kind: 'done' }>, n: number): Promise<Computed>;
  save(state: LoopState): Promise<void>;
}

export async function runLoop(limits: Limits, from: LoopState, deps: LoopDeps): Promise<{ end: End; state: LoopState; /** Why a `model` end: the provider failed, or the person's AI budget was used. */ fatal?: 'model' | 'limited' }> {
  const state: LoopState = { steps: [...from.steps], stepsUsed: from.stepsUsed, queriesUsed: from.queriesUsed };
  const gate = async (): Promise<End | null> => {
    if (deps.lost()) return 'lost';
    if (await deps.stopRequested()) return 'stopped';
    if (deps.now() >= deps.deadline) return 'deadline';
    if (!(await deps.allowed())) return 'access';
    return null;
  };
  for (;;) {
    const before = await gate();
    if (before) return { end: before, state };
    if (state.stepsUsed >= limits.steps) return { end: 'steps', state };
    if (state.queriesUsed >= limits.queries) return { end: 'queries', state };
    const d = await deps.decide(state.steps);
    state.stepsUsed += 1;
    const n = state.steps.length + 1;
    if (!d.ok) {
      if ('fatal' in d) { await deps.save(state); return { end: 'model', state, fatal: d.fatal }; }
      state.steps.push({ n, kind: 'none', title: '', status: 'refused', reason: d.refused });
      await deps.save(state);
      continue;
    }
    if (d.action.kind === 'done') { await deps.save(state); return { end: 'done', state }; }
    const mid = await gate(); // the step itself: a stop or a lost lease lands before it starts, never in the middle
    if (mid) { await deps.save(state); return { end: mid, state }; }
    const r = await deps.compute(d.action, n);
    if (r.status === 'refused') {
      state.steps.push({ n, kind: d.action.kind, title: r.title ?? '', status: 'refused', reason: r.reason });
    } else {
      state.queriesUsed += 1;
      state.steps.push(r.status === 'done'
        ? { n, kind: d.action.kind, title: r.title, status: 'done', spec: r.spec, facts: r.facts, ledger: r.ledger, datasetIds: r.datasetIds }
        : { n, kind: d.action.kind, title: r.title ?? '', status: 'failed', reason: r.reason });
    }
    await deps.save(state);
    if (deps.lost()) return { end: 'lost', state };
  }
}
