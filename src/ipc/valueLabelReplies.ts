// Value labels on what a chart door answers — MAIN PROCESS (semantic layer PR 06).
//
// The rules are the pure leaf's (analysis/valueLabels); this file reads what they need: the lists of a
// chart's category and split (ONE catalog read; a dataset's declared types only for a column that has
// labels) and puts the pairs BESIDE the raw values, which every filter, drill and colour still keys by.
// A pair exists only for a value IN the reply, so a row-locked reply pairs only the caller's own values,
// never the stored list; and a chart reply is labelled after the Share policy shaped it, so a masked
// value gets none.

import * as catalog from '../app/catalog';
import * as datasets from '../data/datasets';
import type { DatasetMeta } from '../data/datasets';
import { applyValueLabels, shownChart, shownText } from '../analysis/valueLabels';
import type { DroppedLabel, LabelledAxes, ValueLabel, ValueLabelPairs } from '../analysis/valueLabels';
import { labelNotShown } from '../analysis/valueLabelMessages';
import { OTHER_NOTE } from '../analysis/categoryKey';
import type { CategoryInfo } from '../analysis/categoryKey';
import type { ChartData } from '../analysis/vizData';
import type { VizEncoding } from '../analysis/visuals';
import { tileCaption } from '../analysis/captions';
import type { CaptionInput } from '../analysis/captions';
import { answerFacts } from '../ai/answerFacts';
import type { AnswerFactsInput, Headline } from '../ai/answerFacts';
import type { AnswerFilter } from '../ai/answerSpec';
import { MATCH_OPS } from '../ai/answerValues';
import { exactKey } from '../analysis/valueMatch';
import type { Cell } from '../data/transforms';
import type { VizDataReply } from './visuals';

/**
 * The lists a chart's category and split read, each from its own dataset's column doc, and only for a column
 * declared text. None for a map, a pivot, a cohort, an event funnel, small multiples or key drivers: they keep
 * raw values in part 1 (a map matches regions by name; a drivers chart draws another column than its category).
 */
export async function labelListsFor(projectId: string, datasetId: string, encoding: VizEncoding): Promise<{ category?: ValueLabel[]; series?: ValueLabel[] }> {
  if (!encoding || encoding.geo || encoding.pivot || encoding.cohort || encoding.eventFunnel || encoding.facet || encoding.drivers) return {};
  const docs = (await catalog.load(projectId)).columns; // null-prototype maps: a column named `__proto__` is a column
  const metas = new Map<string, Promise<DatasetMeta | null>>();
  const listOf = async (ds: string, column: string | undefined): Promise<ValueLabel[] | undefined> => {
    const list = column ? docs[ds]?.[column]?.values : undefined;
    if (!list?.length) return undefined;
    if (!metas.has(ds)) metas.set(ds, datasets.getDatasetMeta(projectId, ds));
    return (await metas.get(ds))?.columns.find((c) => c.name === column)?.type === 'text' ? list : undefined;
  };
  const [category, series] = await Promise.all([
    listOf(encoding.categoryDatasetId || datasetId, encoding.category),
    encoding.series ? listOf(encoding.seriesDatasetId || datasetId, encoding.series) : undefined,
  ]);
  return { ...(category ? { category } : {}), ...(series ? { series } : {}) };
}

/**
 * A chart reply (`visual:data`, `visual:preview`) with its pairs: a refusal passes through, the capped axis's
 * "Other" is the app's bucket, and a label that is also a value on its axis is left off and said in `warnings`.
 * With no pair and nothing left off, the reply itself (byte-identical).
 */
export async function withValueLabels<R extends VizDataReply>(projectId: string, datasetId: string, encoding: VizEncoding, reply: R): Promise<R> {
  if (!reply.ok) return reply;
  const { data, dropped } = applyValueLabels(reply.data, await labelListsFor(projectId, datasetId, encoding), { otherBucket: reply.category?.note === OTHER_NOTE });
  if (data === reply.data && !dropped.length) return reply;
  return { ...reply, data, warnings: reply.warnings.concat(droppedNotes(dropped, encoding)) };
}

/** A published chart's lists (read once per visual: a page answers every combination of its bar), and its reply's Other bucket. */
export interface ChartLabelLists { category?: ValueLabel[]; series?: ValueLabel[]; otherBucket?: boolean }

/**
 * A published chart answer (pages, stories, embeds) with its pairs, AFTER the Share policy shaped it: a list goes onto an
 * axis only when the policy left that axis as it came (the very array), so a masked axis never gets a pair beside its tokens.
 */
export function labelShaped<D extends LabelledAxes>(stored: LabelledAxes, shaped: D, lists: ChartLabelLists): D & { valueLabels?: ValueLabelPairs } {
  const open = { category: shaped.labels === stored.labels ? lists.category : undefined, series: shaped.series === stored.series ? lists.series : undefined };
  return applyValueLabels(shaped, open, { otherBucket: lists.otherBucket }).data;
}

/**
 * What a published filter bar's options say for `values` of a text column (ruling F11): each labelled value its label, or
 * `Label (raw)` when the label is also one of `values` (two options would read the same), or the value itself when even
 * that text is taken. So no two options read alike, and each option's state keeps its raw value. None → undefined.
 */
export async function labelPairsForValues(projectId: string, datasetId: string, column: string, values: readonly string[]): Promise<[string, string][] | undefined> {
  const list = (await labelListsFor(projectId, datasetId, { category: column, values: [] })).category;
  if (!list) return undefined;
  const present = new Set(values);
  const said = list.filter((l) => present.has(l.value) && l.label !== l.value).map((l): [string, string] => [l.value, present.has(l.label) ? `${l.label} (${l.value})` : l.label]);
  const count = new Map<string, number>();
  for (const [, text] of said) count.set(text, (count.get(text) ?? 0) + 1);
  const pairs = said.filter(([value, text]) => count.get(text) === 1 && (!present.has(text) || text === value));
  return pairs.length ? pairs : undefined;
}

/** Why each left-off label shows its value as stored, naming the axis's column. */
function droppedNotes(dropped: DroppedLabel[], encoding: VizEncoding): string[] {
  return dropped.map((d) => labelNotShown(d.label, d.axis === 'category' ? encoding.category : String(encoding.series)));
}

/**
 * An answer card's chart with its pairs (Explore and the Assistant), and a note for each label left off, as a chart
 * reply warns. `category`: how its axis was bucketed.
 */
export async function labelCardData(
  projectId: string, datasetId: string, encoding: VizEncoding, data: ChartData, category?: CategoryInfo,
): Promise<{ data: ChartData & { valueLabels?: ValueLabelPairs }; notes: string[] }> {
  const labelled = applyValueLabels(data, await labelListsFor(projectId, datasetId, encoding), { otherBucket: category?.note === OTHER_NOTE });
  return { data: labelled.data, notes: droppedNotes(labelled.dropped, encoding) };
}

/** What each filtered TEXT column holds under the caller's row lock: stored text by `exactKey` (answerValues.Held, or the Live case fix's lookup). */
export type HeldText = ReadonlyMap<string, ReadonlyMap<string, string>>;

/** Per filtered text column, the pairs its filter text may say, and a note for each label left off. */
export interface FilterText { pairs: ReadonlyMap<string, [string, string][]>; notes: string[] }

/** A filter's value as the steps compare it: the stored text it is in any case or surrounding space, else as given. */
const storedOf = (held: HeldText, column: string, value: string): string => held.get(column)?.get(exactKey(value)) ?? value;

/** The text values the filters of a column say. */
const filterValues = (filters: AnswerFilter[], column: string): string[] =>
  filters.flatMap((f) => ('op' in f && MATCH_OPS.has(f.op) && f.column === column ? [f.value, ...(f.values ?? [])] : [])).filter((v): v is string => typeof v === 'string');

/**
 * The pairs of each filtered column, for values the caller's own rows hold (`held`), so a value outside them has no label
 * to say. A label that is another held value is left off, as on an axis, and when a filter would have said it the card
 * notes why (the sentence a chart reply warns with). The scope is `held`: every value the locked column holds on an
 * extract, the spellings the case fix found on Live. One catalog read, only when some text column is filtered.
 */
export async function filterText(projectId: string, datasetId: string, filters: AnswerFilter[], held: HeldText): Promise<FilterText> {
  const pairs = new Map<string, [string, string][]>();
  const notes: string[] = [];
  if (!held.size) return { pairs, notes };
  const docs = (await catalog.load(projectId)).columns[datasetId];
  for (const [column, values] of held) {
    const list = docs?.[column]?.values;
    if (!list?.length) continue;
    const labelled = applyValueLabels({ labels: [...values.values()], series: [] }, { category: list });
    if (labelled.data.valueLabels?.category) pairs.set(column, labelled.data.valueLabels.category);
    const said = new Set(filterValues(filters, column).map((v) => storedOf(held, column, v)));
    for (const d of labelled.dropped) if (list.some((l) => l.label === d.label && said.has(l.value))) notes.push(labelNotShown(d.label, column));
  }
  return { pairs, notes };
}

/** A stored value as a person reads it: its label, found by the stored text it is (a case-fixed spelling too); else as given. */
export function saidValue<T>(text: FilterText, held: HeldText, column: string, value: T): T | string {
  const p = typeof value === 'string' ? text.pairs.get(column) : undefined;
  if (!p) return value;
  const stored = storedOf(held, column, value as string);
  const label = shownText([stored], p)[0];
  return label === stored ? value : label;
}

/** The filters as a PERSON reads them: each stored value said by its label. Text only: the steps keep the raw value. Nothing said differently → the same array. */
export function saidFilters(filters: AnswerFilter[], text: FilterText, held: HeldText): AnswerFilter[] {
  let changed = false;
  const out = filters.map((f) => {
    if (!('op' in f) || !MATCH_OPS.has(f.op) || !text.pairs.has(f.column)) return f;
    const say = (v: Cell): Cell => saidValue(text, held, f.column, v);
    const g = { ...f, ...(f.value !== undefined ? { value: say(f.value) } : {}), ...(f.values ? { values: f.values.map(say) } : {}) };
    if (g.value === f.value && (g.values ?? []).every((v, i) => v === f.values?.[i])) return f;
    changed = true;
    return g;
  });
  return changed ? out : filters;
}

interface CardText { caption: string; headline: Headline[]; bullets: string[] }

/**
 * The text a PERSON reads on an answer card (ruling F5): caption, headline and bullets said off the labelled
 * chart, the "Filtered to" bullet off `filterLabels` (written from `saidFilters`). The model's facts were built
 * from the stored values (`facts`) and keep them; with no pair and the same filter labels, the text is `said`.
 */
export function cardTextAsSeen(
  data: ChartData & { valueLabels?: ValueLabelPairs }, caption: CaptionInput, facts: AnswerFactsInput, said: CardText, filterLabels: string[],
): CardText {
  if (!data.valueLabels && filterLabels === facts.filterLabels) return said;
  const { headline, bullets } = answerFacts({ ...facts, data: shownChart(data), filterLabels });
  return { caption: tileCaption({ ...caption, data }), headline, bullets };
}
