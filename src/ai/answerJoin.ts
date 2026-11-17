// An answer's fields from a RELATED dataset (docs/assistant/00-design.md, "Joins in the chart form, as built") — PURE: no
// fs, no model, and only types from ./answerSpec (no cycle at run time).
//
// The fields are a visual's own (../analysis/visuals VizEncoding): `categoryDatasetId`, `categoryVia` beside it, and
// `seriesDatasetId` beside a split; a measure's `datasetId` and `via` (VizMeasure); a filter's `datasetId`, the pinned
// table a filter step reads (../data/transforms FilterStep, the planner's `resolveColumnOwner`), and a glossary term's
// dataset beside its reference, whose steps carry it. Same meaning, same whitelists (`sanitizeEncoding`,
// `sanitizeFilterStep`). Which datasets a spec may reach, and how, is the chart planner's (../analysis/joinPlan): many →
// one, a many-side measure drilled across (../analysis/fanOutPlan), anything else refused in its sentence, when the card
// is drawn through the chart door (../ipc/answerJoined).

import type { VizEncoding } from '../analysis/visuals';
import type { AnswerSpec } from './answerSpec';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AnswerJoin = Pick<AnswerSpec, 'categoryDatasetId' | 'categoryVia' | 'seriesDatasetId'>;

type Joinable = AnswerJoin & { datasetId?: string; measures?: ReadonlyArray<{ datasetId?: string } | null>; filters?: ReadonlyArray<object | null> };

/** A filter's related dataset (a comparison's, or a term's beside its reference), or undefined: the asked dataset's own. */
export const filterOn = (f: object | null | undefined): string | undefined =>
  f && 'datasetId' in f && typeof (f as { datasetId?: unknown }).datasetId === 'string' ? (f as { datasetId: string }).datasetId : undefined;

/** Is `id` another dataset than the spec's own? A field naming its own dataset reads its own column. */
const other = (id: string | undefined, own: string | undefined): id is string => typeof id === 'string' && !!id && id !== own;

/** The related datasets a spec reads, each once, never its own: its category's, split's, measures', filters' and terms'. */
export function relatedIds(s: Joinable | null | undefined): string[] {
  if (!s) return [];
  const ids = [s.categoryDatasetId, s.seriesDatasetId, ...(s.measures || []).map((m) => m?.datasetId), ...(s.filters || []).map(filterOn)];
  return [...new Set(ids)].filter((id): id is string => other(id, s.datasetId));
}

/** Every field a spec may read from another dataset, as [what, its dataset (none: the asked one's), its column (a term's: none)]. */
export function relatedRefs(spec: Pick<AnswerSpec, 'category' | 'series' | 'measures' | 'filters'> & AnswerJoin): Array<readonly ['category' | 'series' | 'measure' | 'filter', string | undefined, string | undefined]> {
  return [['category', spec.categoryDatasetId, spec.category], ['series', spec.seriesDatasetId, spec.series],
    ...spec.measures.map((m) => ['measure', m.datasetId, m.column] as const),
    ...spec.filters.map((f) => ['filter', filterOn(f), 'column' in f ? f.column : undefined] as const)];
}

/** Does the spec read a related dataset's column (its category's, split's, a measure's, a filter's or a term's)? */
export const isJoined = (s: Joinable | null | undefined): boolean => relatedIds(s).length > 0;

/** What a turn reads beyond its answer's own dataset: the answer's related datasets and every "Did you mean" option's. */
export function turnRelatedIds(answer: AnswerSpec | undefined, options: ReadonlyArray<{ spec: AnswerSpec }> = []): string[] {
  return [...new Set([answer, ...options.map((o) => o.spec)].flatMap(relatedIds))];
}

/** The spec's names on its OWN dataset: its category, split, measures and filters, each unless a related dataset's. */
export function ownNames(spec: Pick<AnswerSpec, 'category' | 'series' | 'measures' | 'filters'> & Joinable): string[] {
  const own = (id: string | undefined): boolean => !other(id, spec.datasetId);
  const names = [own(spec.categoryDatasetId) ? spec.category : undefined, own(spec.seriesDatasetId) ? spec.series : undefined,
    ...(spec.measures || []).map((m) => (m && own(m.datasetId) ? m.column : undefined)),
    ...(spec.filters || []).map((f) => (f && own(filterOn(f)) && 'column' in f ? f.column : undefined))];
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

/**
 * A stored measure's or filter's related dataset (and a measure's `via` beside it), whitelisted as `sanitizeEncoding` does a
 * visual's measure. The asked dataset's own id is no related one: dropped, so no step pins its own table.
 */
export function storedOn(o: Record<string, unknown>, own: string, measure: boolean): { datasetId?: string; via?: string } {
  if (typeof o.datasetId !== 'string' || !UUID_RE.test(o.datasetId) || o.datasetId === own) return {};
  return { datasetId: o.datasetId, ...(measure && typeof o.via === 'string' && UUID_RE.test(o.via) ? { via: o.via } : {}) };
}

/** A relationship id a raw spec gives beside its category's dataset: kept only as one (the planner checks it reaches that dataset). */
export const rawVia = (v: unknown): string | undefined => (typeof v === 'string' && UUID_RE.test(v) ? v : undefined);
