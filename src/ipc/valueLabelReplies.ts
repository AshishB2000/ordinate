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
import { applyValueLabels, shownChart } from '../analysis/valueLabels';
import type { ValueLabel, ValueLabelPairs } from '../analysis/valueLabels';
import { labelNotShown } from '../analysis/valueLabelMessages';
import { OTHER_NOTE } from '../analysis/categoryKey';
import type { CategoryInfo } from '../analysis/categoryKey';
import type { ChartData } from '../analysis/vizData';
import type { VizEncoding } from '../analysis/visuals';
import { tileCaption } from '../analysis/captions';
import type { CaptionInput } from '../analysis/captions';
import { answerFacts } from '../ai/answerFacts';
import type { AnswerFactsInput, Headline } from '../ai/answerFacts';
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
  const said = dropped.map((d) => labelNotShown(d.label, d.axis === 'category' ? encoding.category : String(encoding.series)));
  return { ...reply, data, warnings: reply.warnings.concat(said) };
}

/** An answer card's chart with its pairs (Explore and the Assistant). `category`: how its axis was bucketed. */
export async function labelCardData(
  projectId: string, datasetId: string, encoding: VizEncoding, data: ChartData, category?: CategoryInfo,
): Promise<ChartData & { valueLabels?: ValueLabelPairs }> {
  return applyValueLabels(data, await labelListsFor(projectId, datasetId, encoding), { otherBucket: category?.note === OTHER_NOTE }).data;
}

interface CardText { caption: string; headline: Headline[]; bullets: string[] }

/**
 * The text a PERSON reads on an answer card (ruling F5): caption, headline and bullets said off the labelled
 * chart. The model's facts were built from the stored values (`facts`) and keep them; with no pair the card's
 * text is `said`, as it was.
 */
export function cardTextAsSeen(data: ChartData & { valueLabels?: ValueLabelPairs }, caption: CaptionInput, facts: AnswerFactsInput, said: CardText): CardText {
  if (!data.valueLabels) return said;
  const { headline, bullets } = answerFacts({ ...facts, data: shownChart(data) });
  return { caption: tileCaption({ ...caption, data }), headline, bullets };
}
