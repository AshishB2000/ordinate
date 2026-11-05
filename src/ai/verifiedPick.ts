// Which verified question a question IS, and which to show the model as examples (semantic part 3 D8, D10, D15).
// PURE: no fs, no model. The states come from ../ipc/verifiedState; nothing here reads a row.
//
// A hit is exact: the asked question's key equals a working, visible question's key or one of its phrasings'. A
// near miss ("…last year") is a different question and goes to the model. A question that no longer runs, or
// that the caller's row access rules hide, is neither a hit nor an example.

import type { AnswerFilter, AnswerSpec } from './answerSpec';
import { words } from './answerSuggest';
import { promptJson } from './promptText';
import { hasValueFilter, questionKey, type VerifiedQuestion } from '../analysis/verifiedRules';
import type { VerifiedState } from '../ipc/verifiedState';

export const MAX_EXAMPLES = 5, EXAMPLE_MAX = 600, EXAMPLES_BLOCK_MAX = 3000;

const usable = (s: VerifiedState, exclude?: string): boolean => s.problem === null && !s.hidden && s.q.id !== exclude;

/** The question whose own wording, or one of whose phrasings, is `question` (case, spaces and punctuation aside), or null. */
export function exactHit(states: VerifiedState[], question: string, exclude?: string): VerifiedQuestion | null {
  const key = questionKey(question);
  if (!key) return null; // a punctuation-only question has no key, and an empty key equals every other empty key
  return states.find((s) => usable(s, exclude) && [s.q.question, ...s.q.phrasings].some((t) => questionKey(t) === key))?.q ?? null;
}

export interface Names { dataset: (id: string) => string; term: (id: string) => string }

/** A spec as the action line writes it: by name, never by id (./suggestedAction's "answer" shape). */
export function rawSpec(spec: AnswerSpec, names: Names): Record<string, unknown> {
  const filter = (f: AnswerFilter): Record<string, unknown> => ('term' in f ? { term: names.term(f.term) } : f);
  return {
    dataset: names.dataset(spec.datasetId), category: spec.category, ...(spec.series ? { series: spec.series } : {}),
    measures: spec.measures.map((m) => ({ column: m.column, aggregation: m.aggregation })), filters: spec.filters.map(filter),
    chartType: spec.chartType, ...(spec.top ? { top: spec.top } : {}), ...(spec.grain ? { grain: spec.grain } : {}),
  };
}

export interface PickOptions {
  question: string; datasetId?: string; exclude?: string; names: Names;
  /** Columns whose values never reach this caller's prompt, per dataset. */
  withheld: (datasetId: string) => ReadonlySet<string>;
}

/** Up to 5 example lines: the context's dataset first, then the most words shared with the question, then the newest. */
export function pickExamples(states: VerifiedState[], o: PickOptions): { lines: string[]; ids: string[] } {
  const asked = new Set(words(o.question));
  const shared = (q: VerifiedQuestion): number => words(q.question).filter((w) => asked.has(w)).length;
  const eligible = states.filter((s) => {
    if (!usable(s, o.exclude)) return false;
    const w = o.withheld(s.q.spec.datasetId);
    return !(hasValueFilter(s.q.spec) && s.q.spec.filters.some((f) => 'column' in f && !('period' in f) && w.has(f.column)));
  }).map((s) => s.q);
  const rank = (q: VerifiedQuestion): number => (q.spec.datasetId === o.datasetId ? 0 : 1);
  eligible.sort((a, b) => rank(a) - rank(b) || shared(b) - shared(a)
    || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0) || (a.id < b.id ? -1 : 1));
  const lines: string[] = [], ids: string[] = [];
  let total = 0;
  for (const q of eligible) {
    if (ids.length >= MAX_EXAMPLES) break;
    const line = `- ${promptJson(q.question)} → ${promptJson(rawSpec(q.spec, o.names))}`;
    if (line.length > EXAMPLE_MAX) continue;
    const next = total + line.length + (lines.length ? 1 : 0);
    if (next > EXAMPLES_BLOCK_MAX) break;
    total = next;
    lines.push(line);
    ids.push(q.id);
  }
  return { lines, ids };
}
