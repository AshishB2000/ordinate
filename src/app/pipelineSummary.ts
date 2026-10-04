// The Pipelines page's figures (T2.6) — the counts the head strip prints and the
// row change a run's log names, computed with the view instead of in a browser
// (plan §6.4: the browser formats, it never counts). The desktop renderer
// counted these itself (renderer/hub/pipelinesPage.ts pqHead); the rules here
// are that code's, moved.

import type { NodeOutcome } from './pipelines';

interface NodeLike {
  stage: number;
  schedule: { edit: string | null; text: string };
  lastRun: { at: string; status: string } | null;
  runs: Array<{ rows?: number; rowsBefore?: number }>;
}

export interface PipelineSummary {
  /** Distinct stages that hold a step. */
  stages: number;
  /** Steps with a schedule of their own (not Manual / Typed). */
  scheduled: number;
  /** Steps whose last run failed or was blocked. */
  failed: number;
  /** The newest last-run time across the steps, or null when nothing has run. */
  lastActivityAt: string | null;
}

export function summarize(nodes: readonly NodeLike[]): PipelineSummary {
  const stages = new Set<number>();
  let scheduled = 0;
  let failed = 0;
  let last: string | null = null;
  for (const n of nodes) {
    stages.add(n.stage);
    if (n.schedule.edit && !/^(Manual|Typed)/.test(n.schedule.text)) scheduled += 1;
    if (n.lastRun && (n.lastRun.status === 'failed' || n.lastRun.status === 'blocked')) failed += 1;
    if (n.lastRun && n.lastRun.at && (last === null || n.lastRun.at > last)) last = n.lastRun.at;
  }
  return { stages: stages.size, scheduled, failed, lastActivityAt: last };
}

/** The view with its summary, and each run's row change (`rowsDelta`) where both counts exist. */
export function withSummary<V extends { nodes: NodeLike[] }>(view: V): V & { summary: PipelineSummary } {
  const nodes = view.nodes.map((n) => ({
    ...n,
    runs: n.runs.map((r) => (typeof r.rows === 'number' && typeof r.rowsBefore === 'number' ? { ...r, rowsDelta: r.rows - r.rowsBefore } : r)),
  }));
  return { ...view, nodes, summary: summarize(view.nodes) };
}

/** A run's tally for its toast: how many steps ran, failed, and were stopped after a failure. */
export function tally(outcomes: readonly NodeOutcome[]): { done: number; failed: number; blocked: number } {
  let failed = 0;
  let blocked = 0;
  for (const o of outcomes) {
    if (o.status === 'failed') failed += 1;
    else if (o.status === 'blocked') blocked += 1;
  }
  return { done: outcomes.length, failed, blocked };
}
