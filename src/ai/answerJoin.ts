// An answer's category or split from a RELATED dataset (docs/assistant/00-design.md, "Joins, as built") — PURE: no fs,
// no model, and only types from ./answerSpec (no cycle at run time).
//
// The fields are a visual's own (../analysis/visuals VizEncoding): `categoryDatasetId`, `categoryVia` beside it, and
// `seriesDatasetId` beside a split, with the same meaning and the same whitelist (`sanitizeEncoding`). Which datasets a
// spec may reach, and how, is the chart planner's (../analysis/joinPlan): many → one only, the reverse refused in its
// sentence, when the card is drawn through the chart door (../ipc/answerJoined). Measures, filters and glossary terms
// stay the asked dataset's own.

import type { VizEncoding } from '../analysis/visuals';
import type { AnswerSpec } from './answerSpec';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AnswerJoin = Pick<AnswerSpec, 'categoryDatasetId' | 'categoryVia' | 'seriesDatasetId'>;

type Joinable = AnswerJoin & { datasetId?: string };

/** Is `id` another dataset than the spec's own? A field naming its own dataset reads its own column. */
const other = (id: string | undefined, own: string | undefined): id is string => typeof id === 'string' && !!id && id !== own;

/** The related datasets a spec reads, each once, never its own. */
export function relatedIds(s: Joinable | null | undefined): string[] {
  if (!s) return [];
  return [...new Set([s.categoryDatasetId, s.seriesDatasetId])].filter((id): id is string => other(id, s.datasetId));
}

/** Does the spec read a related dataset's column (its category's or its split's)? */
export const isJoined = (s: Joinable | null | undefined): boolean => relatedIds(s).length > 0;

/** What a turn reads beyond its answer's own dataset: the answer's related datasets and every "Did you mean" option's. */
export function turnRelatedIds(answer: AnswerSpec | undefined, options: ReadonlyArray<{ spec: AnswerSpec }> = []): string[] {
  return [...new Set([answer, ...options.map((o) => o.spec)].flatMap(relatedIds))];
}

/** The spec's names on its OWN dataset: its category and split unless a related dataset's, every measure and filter column. */
export function ownNames(spec: Pick<AnswerSpec, 'category' | 'series' | 'measures' | 'filters'> & Joinable): string[] {
  const names = [other(spec.categoryDatasetId, spec.datasetId) ? undefined : spec.category, other(spec.seriesDatasetId, spec.datasetId) ? undefined : spec.series,
    ...(spec.measures || []).map((m) => m && m.column), ...(spec.filters || []).map((f) => f && ('column' in f ? f.column : undefined))];
  return names.filter((n): n is string => typeof n === 'string' && n !== '');
}

/** The chart a spec draws, as a visual's encoding: the join fields beside the category and the split they qualify. */
export function specEncoding(spec: Pick<AnswerSpec, 'category' | 'measures' | 'series' | 'grain'> & AnswerJoin): VizEncoding {
  const encoding: VizEncoding = { category: spec.category, values: spec.measures };
  if (spec.series) encoding.series = spec.series;
  if (spec.grain) encoding.grain = spec.grain;
  if (spec.categoryDatasetId) encoding.categoryDatasetId = spec.categoryDatasetId;
  if (spec.categoryDatasetId && spec.categoryVia) encoding.categoryVia = spec.categoryVia;
  if (spec.series && spec.seriesDatasetId) encoding.seriesDatasetId = spec.seriesDatasetId;
  return encoding;
}

/** A stored spec's join fields, whitelisted as `sanitizeEncoding` whitelists a visual's: ids only, each beside what it qualifies. */
export function storedJoin(o: Record<string, unknown>, split: boolean): AnswerJoin {
  const out: AnswerJoin = {};
  if (typeof o.categoryDatasetId === 'string' && UUID_RE.test(o.categoryDatasetId)) out.categoryDatasetId = o.categoryDatasetId;
  if (out.categoryDatasetId && typeof o.categoryVia === 'string' && UUID_RE.test(o.categoryVia)) out.categoryVia = o.categoryVia;
  if (split && typeof o.seriesDatasetId === 'string' && UUID_RE.test(o.seriesDatasetId)) out.seriesDatasetId = o.seriesDatasetId;
  return out;
}

/** A relationship id a raw spec gives beside its category's dataset: kept only as one (the planner checks it reaches that dataset). */
export const rawVia = (v: unknown): string | undefined => (typeof v === 'string' && UUID_RE.test(v) ? v : undefined);
