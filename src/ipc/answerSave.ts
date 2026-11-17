// "Save as visual" on an answer card — MAIN PROCESS.
//
// A good answer is kept as an ordinary saved Visual. Nothing a browser sent
// decides what is saved: `answer:saveVisual` (./answers) rebuilds the card from
// the spec, and the visual is made HERE from that card — its encoding from the
// spec's names, its filters from the steps the card itself was computed under.
//
// The visual shows what the card showed WHEN IT WAS SAVED:
//   - a relative period ("last quarter") is saved as the dates it resolved to
//     when the card was drawn (the card's steps), not as a moving period — a
//     saved visual's own `period` filter follows today, which moves on from the
//     period the card drew;
//   - a top-N on a text axis is saved as a filter to the N categories the card
//     kept, because a saved visual has no top-N of its own (a number axis's bins
//     cannot be one filter: there every bin is saved, ranked);
//   - a loosely matched filter value is saved as the stored value it matched.
// Ranked largest first, as the card is, unless the axis is a date — the same
// figures, though the Visuals page ranks by the total across a split and does
// not reorder a funnel, a waterfall or a line at all (web/src/charts/build.ts).

import * as datasets from '../data/datasets';
import type { VizEncoding } from '../analysis/visuals';
import type { FilterStep } from '../data/transforms';
import { OTHER_LABEL, OTHER_NOTE } from '../analysis/categoryKey';
import { answerNotSaved } from '../ai/answerMessages';
import { saveNewVisual } from './visuals';
import { columnOwner } from './relationships';
import { isJoined, specEncoding } from '../ai/answerJoin';
import type { AnswerCard } from './answers';

export type SavedAnswer = { ok: true; visual: { id: string; name: string } } | { ok: false; reason: string };

/** What the card saves as: the visual `saveCardAsVisual` makes, before it is made (Add to dashboard finds one already on a board by it). */
export async function visualOfCard(projectId: string, card: AnswerCard): Promise<Parameters<typeof saveNewVisual>[1]> {
  const { spec } = card;
  const encoding: VizEncoding = specEncoding(spec); // the join fields too (../ai/answerJoin): the visual reads what the card read

  // Metadata only: the column's declared type, on the dataset the category is read from. No row is read to save.
  const meta = await datasets.getDatasetMeta(projectId, spec.categoryDatasetId ?? spec.datasetId);
  const axis = meta?.columns.find((c) => c.name === spec.category)?.type;
  const filters: FilterStep[] = card.steps.slice();
  const kept = card.data.labels.map(String);
  // The cut, as a filter. Only where a label IS a cell's text: not a number axis (its labels are
  // bins, so a top-N there saves every bin, ranked) and not when the card kept the bar the tail
  // was FOLDED into (its note says so), which no cell holds — there every category is saved,
  // ranked, rather than a filter that would drop a bar the card drew. A category that is really
  // called "Other" is a cell's text like any other.
  const folded = card.notes.includes(OTHER_NOTE) && kept.includes(OTHER_LABEL);
  const cut = await cutOn(projectId, spec);
  if (spec.top && axis === 'text' && kept.length >= spec.top && !folded && cut) {
    filters.push({ type: 'filter', column: spec.category, op: 'in', values: kept, ...cut });
  }

  return {
    name: card.title,
    datasetId: spec.datasetId,
    chartType: card.chartType,
    encoding,
    overrides: axis === 'date' ? {} : { sort: 'desc' },
    filters,
  };
}

/**
 * How the top-N filter names a related category so the visual's join planner reads THAT table's column: through its
 * relationship, or bare when the related dataset is the column's nearest owner (../analysis/joinPlan resolveColumnOwner),
 * as the builder saves one. Null: neither, so no cut is saved and every category is, ranked.
 */
async function cutOn(projectId: string, spec: AnswerCard['spec']): Promise<{ via?: string } | null> {
  if (!isJoined({ datasetId: spec.datasetId, categoryDatasetId: spec.categoryDatasetId })) return {};
  if (spec.categoryVia) return { via: spec.categoryVia };
  // shortcut: a related category that is not its name's nearest owner saves uncut (ranked); a filter `via` the default path would cut it.
  return (await columnOwner(projectId, spec.datasetId, spec.category)) === spec.categoryDatasetId ? {} : null;
}

/** The card as a saved Visual, through the door every new visual takes (./visuals `saveNewVisual`). A Live dataset saves as any other does. */
export async function saveCardAsVisual(projectId: string, card: AnswerCard): Promise<SavedAnswer> {
  const saved = await saveNewVisual(projectId, await visualOfCard(projectId, card));
  return saved ? { ok: true, visual: { id: saved.id, name: saved.name } } : { ok: false, reason: answerNotSaved() };
}
