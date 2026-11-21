// Evaluation suites: what a case expects and how the app checks one answer (docs/eval-suites/00-design.md). PURE: no fs, no model.
// The engine checks every figure. Here only the comparisons live; the server computes the two sides (src/server/evals/check.ts) and
// hands them in. A judge model never reaches this file's verdict except as a score of the words (./evalJudge).

import type { AnswerSpec } from './answerSpec';
import { sanitizeStoredSpec } from './answerSpec';
import { sameChart } from './answerRefine';

export const MAX_CASES = 100;
export const MAX_SAY = 500;
/** A judge score at or above this is a pass. */
export const PASS_SCORE = 4;

/** What a good answer is: what to compute (the engine checks it), or that the app should refuse, and optionally words for the judge. */
export interface Expect { compute?: AnswerSpec; refuse?: true; say?: string }

/** A stored or typed expectation in its one shape, or null when it asks for nothing or for two opposite things. */
export function sanitizeExpect(raw: unknown): Expect | null {
  const e = raw as { compute?: unknown; refuse?: unknown; say?: unknown } | null;
  if (!e || typeof e !== 'object') return null;
  const out: Expect = {};
  if (e.compute !== undefined && e.compute !== null) {
    const spec = sanitizeStoredSpec(e.compute);
    if (!spec) return null;
    out.compute = spec;
  }
  if (e.refuse === true) out.refuse = true;
  const say = typeof e.say === 'string' ? e.say.replace(/\s+/g, ' ').trim().slice(0, MAX_SAY) : '';
  if (say) out.say = say;
  if (out.compute && out.refuse) return null; // a case cannot ask for a figure and a refusal
  return out.compute || out.refuse || out.say ? out : null;
}

export type CheckId = 'answered' | 'question' | 'figure' | 'audit';
/** Why a check failed, as a code the page words (the server sends no prose). */
export type CheckCode = 'no_answer' | 'sql' | 'answered' | 'prose' | 'different' | 'expected_failed' | 'answer_failed' | 'invented';
export interface Check { id: CheckId; ok: boolean; code?: CheckCode }
const pass = (id: CheckId): Check => ({ id, ok: true });
const fail = (id: CheckId, code: CheckCode): Check => ({ id, ok: false, code });

/** The same question: everything `sameChart` compares (dataset, category, measures, split, filters, period, top, grain) but how it is drawn. */
export function sameQuestion(a: AnswerSpec, b: AnswerSpec): boolean {
  return sameChart({ ...a, chartType: b.chartType, title: b.title }, b);
}

/** Two values equal leaf by leaf with `Object.is`: NaN equals NaN, -0 is not 0. Arrays by position, objects by their keys. */
export function sameFigures(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameFigures(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
    const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameFigures((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return Object.is(a, b);
}

/** What the turn the ask stored (and its reply) says happened. */
export interface Answered {
  /** A chart (its spec) or an SQL answer; null: neither. */
  computed: { kind: 'chart'; spec: AnswerSpec } | { kind: 'sql' } | null;
  /** The app refused: a chart it would not draw, `needs`, `outside`, "Did you mean", a checked link. A prose-only reply is not one. */
  refused: boolean;
  /** The ask's number audit found nothing the engine did not compute. */
  auditOk: boolean;
}
/** The chart data of one side, computed now; null when it could not be computed. */
export interface Sides { expected: unknown | null; answer: unknown | null }

/** Every exact check that applies to the case, in a fixed order. `sides`: needed (and read) only for a compute case whose two specs agree on a chart. */
export function exactChecks(expect: Expect, got: Answered, sides: Sides | null): Check[] {
  const out: Check[] = [];
  if (expect.compute) {
    out.push(got.computed ? pass('answered') : fail('answered', 'no_answer'));
    if (got.computed?.kind === 'chart') {
      out.push(sameQuestion(expect.compute, got.computed.spec) ? pass('question') : fail('question', 'different'));
      out.push(!sides || sides.expected === null ? fail('figure', 'expected_failed') : sides.answer === null ? fail('figure', 'answer_failed') : sameFigures(sides.expected, sides.answer) ? pass('figure') : fail('figure', 'different'));
    } else if (got.computed) {
      out.push(fail('question', 'sql'), fail('figure', 'sql')); // an SQL answer is no chart spec: nothing to compare it to
    }
  } else if (expect.refuse) {
    out.push(got.computed ? fail('answered', 'answered') : got.refused ? pass('answered') : fail('answered', 'prose'));
  }
  out.push(got.auditOk ? pass('audit') : fail('audit', 'invented'));
  return out;
}

export type Judged = { state: 'none' } | { state: 'scored'; score: number } | { state: 'not_scored' };
export type Outcome = 'pass' | 'fail' | 'not_scored' | 'error';

/** The verdict: every exact check must pass; with words, the judge's score must reach PASS_SCORE; an unreadable judge reply is never a pass. */
export function verdict(checks: readonly Check[], judged: Judged): Outcome {
  if (checks.some((c) => !c.ok)) return 'fail';
  if (judged.state === 'none') return 'pass';
  if (judged.state === 'not_scored') return 'not_scored';
  return judged.score >= PASS_SCORE ? 'pass' : 'fail';
}

export type Move = 'better' | 'worse' | 'same' | 'new';
const RANK: Record<Outcome, number> = { pass: 2, not_scored: 1, fail: 0, error: 0 };
export interface Line { caseId: string; outcome: Outcome; score: number | null }

/** Each case against the previous run's: by outcome rank, then (both scored) by judge score. A case the previous run did not have is `new`. */
export function compareRuns(prev: readonly Line[], now: readonly Line[]): { moves: Map<string, Move>; better: number; worse: number; same: number; new: number } {
  const before = new Map(prev.map((l) => [l.caseId, l]));
  const moves = new Map<string, Move>();
  const total = { better: 0, worse: 0, same: 0, new: 0 };
  for (const l of now) {
    const p = before.get(l.caseId);
    let m: Move = 'new';
    if (p) {
      const d = RANK[l.outcome] - RANK[p.outcome] || (l.score !== null && p.score !== null ? Math.sign(l.score - p.score) : 0);
      m = d > 0 ? 'better' : d < 0 ? 'worse' : 'same';
    }
    moves.set(l.caseId, m);
    total[m] += 1;
  }
  return { moves, ...total };
}
