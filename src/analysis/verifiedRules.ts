// Verified questions (semantic layer part 3 D5, D7) — PURE: the record's shape, its caps, the question key and
// what a restricted viewer may see of it. The store is ./verifiedQuestions; whether one still runs is
// ../ipc/verifiedState.
//
// A verified question holds an answer SPEC, never a figure: every figure is drawn by `computeCard` when it is
// asked, so new rows move the answer with them. Periods stay relative and a glossary term stays a reference.

import { squash } from '../app/columnNames';
import { isValidId } from '../app/ids';
import { sanitizeStoredSpec } from '../ai/answerSpec';
import type { AnswerSpec } from '../ai/answerSpec';

export const MAX_QUESTION = 300;
export const MAX_PHRASINGS = 8;
export const MAX_NOTE = 500;
const MAX_BY = 200;
const MAX_AT = 40;

export interface VerifiedQuestion {
  id: string;
  projectId: string;
  /** One line, the card's title. */
  question: string;
  /** Other ways people ask it: one line each, none sharing the question's key. */
  phrasings: string[];
  /** No `matched`; `title` is the question. */
  spec: AnswerSpec;
  /** Why this is the answer ("net of refunds"). */
  note?: string;
  verifiedBy: string;
  verifiedAt: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

// No ellipsis on a cut, so a second pass changes nothing (sanitize twice == once).
const line = (raw: unknown, max: number): string => (typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const stamp = (raw: unknown, max: number): string => (typeof raw === 'string' ? raw.slice(0, max) : '');

/** What makes two questions one: case, spaces and punctuation are not part of it (../app/columnNames `squash`). */
export function questionKey(s: string): string {
  return squash(line(s, MAX_QUESTION));
}

/** A stored or saved record, re-sanitized; null when it is not one (no id, no question, no spec that reads). */
export function sanitizeVerified(raw: unknown): VerifiedQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const question = line(o.question, MAX_QUESTION);
  const stored = sanitizeStoredSpec(o.spec);
  if (!isValidId(o.id) || !isValidId(o.projectId) || !question || !stored) return null;
  const { matched: _m, ...spec } = stored;
  const keys = new Set([questionKey(question)]);
  const phrasings: string[] = [];
  for (const p of Array.isArray(o.phrasings) ? o.phrasings : []) {
    const s = line(p, MAX_QUESTION);
    const k = questionKey(s);
    if (!k || keys.has(k) || phrasings.length >= MAX_PHRASINGS) continue;
    keys.add(k);
    phrasings.push(s);
  }
  const createdAt = stamp(o.createdAt, MAX_AT);
  const q: VerifiedQuestion = {
    id: o.id as string,
    projectId: o.projectId as string,
    question,
    phrasings,
    spec: { ...spec, title: question },
    verifiedBy: stamp(o.verifiedBy, MAX_BY),
    verifiedAt: stamp(o.verifiedAt, MAX_AT),
    createdAt,
    updatedAt: stamp(o.updatedAt, MAX_AT) || createdAt,
    schemaVersion: 1,
  };
  const note = line(o.note, MAX_NOTE);
  if (note) q.note = note;
  return q;
}

/** The first of `texts` whose key another question or phrasing of the project already holds, or null. */
export function keyClash(list: readonly VerifiedQuestion[], texts: readonly string[], exceptId?: string): string | null {
  const taken = new Set(list.filter((q) => q.id !== exceptId).flatMap((q) => [q.question, ...q.phrasings].map(questionKey)));
  return texts.find((s) => {
    const k = questionKey(s);
    return !!k && taken.has(k);
  }) ?? null;
}

/** A comparison that names a row value. A term reference, a period or a valueless op (`not_empty`) names none. */
export function hasValueFilter(spec: Pick<AnswerSpec, 'filters'>): boolean {
  return spec.filters.some((f) => !('term' in f) && !('period' in f) && ('value' in f || 'values' in f));
}
