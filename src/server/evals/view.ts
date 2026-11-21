// What each caller of the evaluation channels may see (docs/eval-suites/00-design.md, "Phase 4", "Folders"). PURE over what the stores
// return, plus the one folder lookup. Every editor sees each case's outcome, score and checks; the answer's words and the judge's line
// only the person who ran it, and only while no dataset the answer used is closed to them. A case whose spec reads a dataset closed to the
// caller is gone from their view, as a verified question on it is (src/analysis/verifiedQuestions.ts `listBoth`).

import { compareRuns, type Check, type Outcome } from '../../ai/evalChecks';
import { relatedIds } from '../../ai/answerJoin';
import { levelsOf } from '../authz/folderGate';
import { changedParts } from './version';
import type { Case, Result, Run } from './db';

type Level = ((id: string) => string) | null;

/** The caller's folder levels on the project's datasets (one lookup), as a test for a case. */
export async function caseGate(projectId: string): Promise<{ level: Level; visible: (c: Pick<Case, 'expect'>) => boolean }> {
  const level = await levelsOf(projectId, 'dataset');
  return { level, visible: (c) => !level || !c.expect.compute || [c.expect.compute.datasetId, ...relatedIds(c.expect.compute)].every((id) => level(id) !== 'none') };
}

export interface CaseLine {
  caseId: string; position: number; question: string;
  /** 'pending' until the case has a result. */
  outcome: Outcome | 'pending';
  score: number | null; judged: 'none' | 'scored' | 'not_scored'; checks: Check[]; errorCode: string | null; calls: number;
  move: 'better' | 'worse' | 'same' | 'new' | null;
  /** The runner's alone (and only while the data is open to them). */
  reply?: string; why?: string;
}

export interface RunView {
  run: {
    id: string; projectId: string; suiteId: string; agentId: string | null; state: Run['state']; errorCode: string | null; mine: boolean; resumable: boolean;
    casesTotal: number; casesDone: number; passed: number; failed: number; notScored: number; modelCalls: number;
    judge: string | null; judgeOwn: boolean; version: Record<string, string>; startedAt: string; finishedAt: string | null; elapsedSec: number;
  };
  cases: CaseLine[];
  compare: { runId: string; better: number; worse: number; same: number; new: number; changed: string[]; judgeDiffers: boolean } | null;
}

/**
 * The run as `me` sees it. `cases`: the suite's cases still there (for the questions of the pending ones). `prev`: the previous finished run of
 * the suite and its results, or null. The counts are recounted from the cases `me` may see.
 */
export function runView(me: string, run: Run, results: readonly Result[], cases: ReadonlyMap<string, Case>, level: Level, visible: (c: Pick<Case, 'expect'>) => boolean, prev: { run: Run; results: readonly Result[] } | null): RunView {
  const mine = run.startedBy === me;
  const shown = new Set(run.caseIds.filter((id) => { const c = cases.get(id); return !c || visible(c); })); // a case deleted since is not hidden by a folder
  const done = new Map(results.filter((r) => shown.has(r.caseId)).map((r) => [r.caseId, r]));
  const mineOpen = (r: Result): boolean => mine && !(level && r.datasetIds.some((d) => level(d) === 'none'));
  const nowLines = [...done.values()].map((r) => ({ caseId: r.caseId, outcome: r.outcome, score: r.score }));
  const cmp = prev ? compareRuns(prev.results.map((r) => ({ caseId: r.caseId, outcome: r.outcome, score: r.score })), nowLines) : null;
  const lines: CaseLine[] = run.caseIds.flatMap((id, at): CaseLine[] => {
    if (!shown.has(id)) return [];
    const r = done.get(id);
    if (!r) return [{ caseId: id, position: at + 1, question: cases.get(id)?.question ?? '', outcome: 'pending', score: null, judged: 'none', checks: [], errorCode: null, calls: 0, move: null }];
    return [{
      caseId: id, position: r.position, question: r.question, outcome: r.outcome, score: r.score, judged: r.judged, checks: r.checks, errorCode: r.errorCode, calls: r.calls,
      move: cmp?.moves.get(id) ?? null, ...(mineOpen(r) ? { ...(r.reply ? { reply: r.reply } : {}), ...(r.why ? { why: r.why } : {}) } : {}),
    }];
  });
  const count = (o: Outcome | 'fail+error'): number => [...done.values()].filter((r) => (o === 'fail+error' ? r.outcome === 'fail' || r.outcome === 'error' : r.outcome === o)).length;
  const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  return {
    run: {
      id: run.id, projectId: run.projectId, suiteId: run.suiteId, agentId: run.agentId, state: run.state, errorCode: run.errorCode, mine,
      resumable: mine && (run.state === 'partial' || run.state === 'failed') && run.errorCode !== 'access',
      casesTotal: shown.size, casesDone: done.size, passed: count('pass'), failed: count('fail+error'), notScored: count('not_scored'), modelCalls: results.filter((r) => shown.has(r.caseId)).reduce((n, r) => n + r.calls, 0),
      judge: run.judge, judgeOwn: run.judgeOwn, version: run.version, startedAt: run.startedAt, finishedAt: run.finishedAt, elapsedSec: Math.max(0, Math.round((end - Date.parse(run.startedAt)) / 1000)),
    },
    cases: lines,
    compare: prev && cmp ? { runId: prev.run.id, better: cmp.better, worse: cmp.worse, same: cmp.same, new: cmp.new, changed: changedParts(prev.run.version, run.version), judgeDiffers: prev.run.judge !== run.judge } : null,
  };
}
