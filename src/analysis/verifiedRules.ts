// Verified questions (semantic layer part 3 D5, D7) — PURE: the record's shape, its caps, the question key and
// what a restricted viewer may see of it. The store is ./verifiedQuestions; whether one still runs is
// ../ipc/verifiedState.
//
// A verified question holds an answer SPEC, never a figure: every figure is drawn by `computeCard` when it is
// asked, so new rows move the answer with them. Periods stay relative and a glossary term stays a reference.
//
// A verified SQL question (the SQL lane, docs/assistant/00-design.md) holds `sql` in place of `spec`: the statement
// and the datasets it reads, by id, run again through the Query tab's gate when it is asked (../ipc/verifiedSql). It is
// a record of the same kind in the same folder and index; `sanitizeVerified` reads it as no chart's question (null),
// as a pod older than this release does, and `sanitizeVerifiedSql` reads only it.

import { squash } from '../app/columnNames';
import { isValidId } from '../app/ids';
import { sanitizeStoredSpec } from '../ai/answerSpec';
import type { AnswerSpec } from '../ai/answerSpec';
import { sanitizeSqlTurn } from '../ai/answerSql';

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

/** The statement of a verified SQL question and the datasets it reads (the gate's deps when it was saved), by id. */
export interface VerifiedSql { text: string; datasetIds: string[] }

/** A verified question answered with SQL: `sql` where a chart's question has `spec`. */
export interface VerifiedSqlQuestion extends Omit<VerifiedQuestion, 'spec'> { sql: VerifiedSql }

/** Either kind, where only the words and the stamps are read (a key check, a row of the list). */
export type AnyVerified = VerifiedQuestion | VerifiedSqlQuestion;
export const isSqlQuestion = (q: AnyVerified): q is VerifiedSqlQuestion => 'sql' in q;

/** A stored or saved record, re-sanitized; null when it is not one (no id, no question, no spec that reads). */
export function sanitizeVerified(raw: unknown): VerifiedQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const stored = sanitizeStoredSpec((raw as Record<string, unknown>).spec);
  const w = stored ? wordsOf(raw as Record<string, unknown>) : null;
  if (!stored || !w) return null;
  const { matched: _m, ...spec } = stored;
  const { id, projectId, question, phrasings, ...stamps } = w;
  return { id, projectId, question, phrasings, spec: { ...spec, title: question }, ...stamps };
}

/** A stored or saved SQL question, re-sanitized; null when it is not one. A record with a `spec` is a chart's question. */
export function sanitizeVerifiedSql(raw: unknown): VerifiedSqlQuestion | null {
  if (!raw || typeof raw !== 'object' || 'spec' in raw) return null;
  const sql = sanitizeSqlTurn({ ...((raw as { sql?: object }).sql ?? {}), title: '' });
  const w = sql ? wordsOf(raw as Record<string, unknown>) : null;
  if (!sql || !w) return null;
  const { id, projectId, question, phrasings, ...stamps } = w;
  return { id, projectId, question, phrasings, sql: { text: sql.text, datasetIds: sql.datasetIds }, ...stamps };
}

/** Everything but the answer, in the stored key order (the answer goes after `phrasings`); null with no id or no question. */
function wordsOf(o: Record<string, unknown>): Omit<VerifiedQuestion, 'spec'> | null {
  const question = line(o.question, MAX_QUESTION);
  if (!isValidId(o.id) || !isValidId(o.projectId) || !question) return null;
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
  const q: Omit<VerifiedQuestion, 'spec'> = {
    id: o.id as string,
    projectId: o.projectId as string,
    question,
    phrasings,
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

/** The first of `texts` whose key another question or phrasing of the project already holds (either kind), or null. */
export function keyClash(list: ReadonlyArray<Pick<AnyVerified, 'id' | 'question' | 'phrasings'>>, texts: readonly string[], exceptId?: string): string | null {
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
