// "Save as visual" on an answer card — MAIN PROCESS.
//
// A good answer is kept as an ordinary saved Visual. Nothing a browser sent
// decides what is saved: `answer:saveVisual` (./answers) rebuilds the card from
// the spec, and the visual is made HERE from that card — its encoding from the
// spec's names, its filters from the steps the card itself was computed under.
//
// The visual shows what the card showed WHEN IT WAS SAVED:
//   - a relative period ("last quarter") is saved as the dates it resolved to
//     against the data's own latest date (the card's steps), not as a moving
//     period — a saved visual's own `period` filter follows the calendar's
//     today, which is a different period from the one the card drew;
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
import type { AnswerCard } from './answers';

export type SavedAnswer = { ok: true; visual: { id: string; name: string } } | { ok: false; reason: string };

/** The card as a saved Visual, through the door every new visual takes (./visuals `saveNewVisual`). A Live dataset saves as any other does. */
export async function saveCardAsVisual(projectId: string, card: AnswerCard): Promise<SavedAnswer> {
  const { spec } = card;
  const encoding: VizEncoding = { category: spec.category, values: spec.measures };
  if (spec.series) encoding.series = spec.series;
  if (spec.grain) encoding.grain = spec.grain;

  // Metadata only: the column's declared type. No row is read to save.
  const meta = await datasets.getDatasetMeta(projectId, spec.datasetId);
  const axis = meta?.columns.find((c) => c.name === spec.category)?.type;
  const filters: FilterStep[] = card.steps.slice();
  const kept = card.data.labels.map(String);
  // The cut, as a filter. Only where a label IS a cell's text: not a number axis (its labels are
  // bins, so a top-N there saves every bin, ranked) and not when the card kept the bar the tail
  // was FOLDED into (its note says so), which no cell holds — there every category is saved,
  // ranked, rather than a filter that would drop a bar the card drew. A category that is really
  // called "Other" is a cell's text like any other.
  const folded = card.notes.includes(OTHER_NOTE) && kept.includes(OTHER_LABEL);
  if (spec.top && axis === 'text' && kept.length >= spec.top && !folded) {
    filters.push({ type: 'filter', column: spec.category, op: 'in', values: kept });
  }

  const saved = await saveNewVisual(projectId, {
    name: card.title,
    datasetId: spec.datasetId,
    chartType: card.chartType,
    encoding,
    overrides: axis === 'date' ? {} : { sort: 'desc' },
    filters,
  });
  return saved ? { ok: true, visual: { id: saved.id, name: saved.name } } : { ok: false, reason: answerNotSaved() };
}
