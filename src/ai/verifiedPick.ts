// Which verified question a question IS, and which to show the model as examples (semantic part 3 D8, D10, D15).
// PURE: no fs, no model. The states come from ../ipc/verifiedState; nothing here reads a row.
//
// A hit is exact: the asked question's key equals a working, visible question's key or one of its phrasings'. A
// near miss ("…last year") is a different question and goes to the model. A question that no longer runs, or
// that the caller's row access rules hide, is neither a hit nor an example.

import type { AnswerFilter, AnswerSpec } from './answerSpec';
import { words } from './answerSuggest';
import { promptJson } from './promptText';
import { fuse } from './rankFusion';
import { MEANING_K } from '../app/assistantSearchRank';
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
    measures: spec.measures.map((m) => ({ column: m.column, aggregation: m.aggregation, ...(m.calc ? { calc: m.calc } : {}) })), filters: spec.filters.map(filter),
    chartType: spec.chartType, ...(spec.top ? { top: spec.top } : {}), ...(spec.grain ? { grain: spec.grain } : {}),
  };
}

export interface PickOptions {
  question: string; datasetId?: string; exclude?: string; names: Names;
  /** An Assistant agent's topic datasets: their questions next after the context's dataset (docs/assistant-agents rule 9). */
  first?: ReadonlySet<string>;
  /** Columns whose values never reach this caller's prompt, per dataset. */
  withheld: (datasetId: string) => ReadonlySet<string>;
}

/** Whether `s` may be shown to this caller as an example: it runs, they may see it, and no value filter of it is on a column withheld from them. */
export function eligibleExample(s: VerifiedState, o: Pick<PickOptions, 'exclude' | 'withheld'>): boolean {
  if (!usable(s, o.exclude)) return false;
  const w = o.withheld(s.q.spec.datasetId);
  return !(hasValueFilter(s.q.spec) && s.q.spec.filters.some((f) => 'column' in f && !('period' in f) && w.has(f.column)));
}

/** The examples' order: the context's dataset first, then an agent's topic, then the most words shared with the question, then the newest, then the id. */
export function exampleOrder(o: Pick<PickOptions, 'question' | 'datasetId' | 'first'>): (a: VerifiedQuestion, b: VerifiedQuestion) => number {
  const asked = new Set(words(o.question));
  const shared = (q: VerifiedQuestion): number => words(q.question).filter((w) => asked.has(w)).length;
  const tier = tierOf(o);
  const rank = (q: VerifiedQuestion): number => tier(q.spec.datasetId);
  return (a, b) => rank(a) - rank(b) || shared(b) - shared(a)
    || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0) || (a.id < b.id ? -1 : 1);
}

/** A question's tier in `exampleOrder`, by its chart's dataset: the context's 0, an agent's topic 1, any other 2. */
export const tierOf = (o: Pick<PickOptions, 'datasetId' | 'first'>) => (datasetId: string): number => (datasetId === o.datasetId ? 0 : o.first?.has(datasetId) ? 1 : 2);

// ── With meaning (PR 7c) ───────────────────────────────────────────────────
// The first MEANING_K questions in exampleOrder and the MEANING_K nearest the question by meaning are merged by rank
// (./rankFusion), then put in tier order (stable): the HEAD. The rest of exampleOrder follows, each tier's head
// questions before that tier's others. The examples are then taken from that order as from exampleOrder.

export interface Ranked { id: string; datasetId: string }

/** The head of the examples' order with meaning: `words` (in exampleOrder, its first `k` used) and `near` fused, by tier. */
export function examplesHead<T extends Ranked>(words: readonly T[], near: readonly T[], tier: (datasetId: string) => number, k: number): T[] {
  const by = new Map<string, T>();
  for (const r of [...near, ...words]) by.set(r.id, r);
  const fused = fuse([words.slice(0, k).map((r) => r.id), near.map((r) => r.id)], { k: 60 }).flatMap((f) => by.get(f.key) ?? []);
  return fused.map((r, i) => ({ r, i, t: tier(r.datasetId) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.r);
}

/** THE REFERENCE of the order with meaning (../ipc/verifiedLookup pages it): the head, then the rest of `words` (all of them), merged by tier, the head first within one. */
export function examplesWithMeaning<T extends Ranked>(words: readonly T[], near: readonly T[], tier: (datasetId: string) => number, k: number): T[] {
  const head = examplesHead(words, near, tier, k);
  const inHead = new Set(head.map((r) => r.id));
  const out: T[] = [];
  let i = 0;
  for (const t of words.slice(k)) {
    if (inHead.has(t.id)) continue;
    while (i < head.length && tier(head[i].datasetId) <= tier(t.datasetId)) out.push(head[i++]);
    out.push(t);
  }
  return [...out, ...head.slice(i)];
}

/** The example lines taken so far; `done` once five are taken or the block is full, so no later question could join. */
export interface Taken { lines: string[]; ids: string[]; total: number; done: boolean }
export const NOTHING_TAKEN: Taken = { lines: [], ids: [], total: 0, done: false };

/** `sorted` (eligible, in `exampleOrder`) taken after `acc`, so lines can be taken a batch at a time (../ipc/verifiedLookup). */
export function takeExamples(sorted: readonly VerifiedQuestion[], names: Names, acc: Taken = NOTHING_TAKEN): Taken {
  if (acc.done) return acc;
  const lines = [...acc.lines], ids = [...acc.ids];
  let total = acc.total;
  for (const q of sorted) {
    if (ids.length >= MAX_EXAMPLES) break;
    const line = `- ${promptJson(q.question)} → ${promptJson(rawSpec(q.spec, names))}`;
    if (line.length > EXAMPLE_MAX) continue;
    const next = total + line.length + (lines.length ? 1 : 0);
    if (next > EXAMPLES_BLOCK_MAX) return { lines, ids, total, done: true };
    total = next;
    lines.push(line);
    ids.push(q.id);
  }
  return { lines, ids, total, done: ids.length >= MAX_EXAMPLES };
}

/**
 * Up to 5 example lines: the context's dataset first, then an agent's topic, then the most words shared with the
 * question, then the newest. `near` (ids nearest by meaning, best first; the reference's): merged as above, `k` each.
 */
export function pickExamples(states: VerifiedState[], o: PickOptions & { near?: readonly string[]; k?: number }): { lines: string[]; ids: string[] } {
  let sorted = states.map((s) => s.q).sort(exampleOrder(o));
  if (o.near) {
    const of = new Map(sorted.map((q) => [q.id, q]));
    const ranked = (q: VerifiedQuestion): Ranked & { q: VerifiedQuestion } => ({ id: q.id, datasetId: q.spec.datasetId, q });
    sorted = examplesWithMeaning(sorted.map(ranked), o.near.flatMap((id) => { const q = of.get(id); return q ? [ranked(q)] : []; }), tierOf(o), o.k ?? MEANING_K).map((r) => r.q);
  }
  const ok = new Set(states.filter((s) => eligibleExample(s, o)).map((s) => s.q.id));
  const t = takeExamples(sorted.filter((q) => ok.has(q.id)), o.names);
  return { lines: t.lines, ids: t.ids };
}
