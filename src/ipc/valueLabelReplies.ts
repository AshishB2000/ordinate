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
import type { DroppedLabel, ValueLabel, ValueLabelPairs } from '../analysis/valueLabels';
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

/** Per filtered text column, the pairs a card's filter text may say. */
export type FilterPairs = ReadonlyMap<string, [string, string][]>;

/**
 * The pairs of each filtered column, for values the caller's own rows hold: `held` is what each filtered TEXT column
 * holds under the row lock (answerValues.heldValues, or the Live case fix's lookup), so a value outside the caller's
 * rows has no label to say. A label that is another held value is left off, as on an axis. One catalog read, only
 * when some text column is filtered.
 */
export async function filterPairs(projectId: string, datasetId: string, held: ReadonlyMap<string, ReadonlyMap<string, string>>): Promise<FilterPairs> {
  const out = new Map<string, [string, string][]>();
  if (!held.size) return out;
  const docs = (await catalog.load(projectId)).columns[datasetId];
  for (const [column, values] of held) {
    const list = docs?.[column]?.values;
    const pairs = list?.length ? applyValueLabels({ labels: [...values.values()], series: [] }, { category: list }).data.valueLabels?.category : undefined;
    if (pairs) out.set(column, pairs);
  }
  return out;
}

/** The operators whose values are stored values (answerValues' MATCH_OPS): `contains EU` is not the value EU. */
const SAID_OPS: ReadonlySet<string> = new Set(['=', '!=', 'in', 'not in']);

/** The filters as a PERSON reads them: each stored value said by its label. Text only: the steps keep the raw value. No pairs → the same array. */
export function saidFilters(filters: AnswerFilter[], pairs: FilterPairs): AnswerFilter[] {
  if (!pairs.size) return filters;
  return filters.map((f) => {
    const p = 'op' in f && SAID_OPS.has(f.op) ? pairs.get(f.column) : undefined;
    if (!p || !('op' in f)) return f;
    return { ...f, ...(f.value !== undefined ? { value: shownText([f.value], p)[0] } : {}), ...(f.values ? { values: shownText(f.values, p) } : {}) };
  });
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
