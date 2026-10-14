// The PREVIOUS ANSWER as the model reads it — MAIN PROCESS, PURE: no fs, no model.
//
// A follow-up ("now only enterprise") continues the chart on screen. Replaying
// the earlier turns as prose left the model to rebuild that chart from memory,
// and it could drop a filter or pick another dataset. So the model is told what
// the chart IS — by NAME: its dataset, columns, filters, chart type — and says
// only what changes; ./answerRefine merges that onto the stored spec.
//
// NAMES ONLY. No figure of the chart is here: the card's numbers stay in the
// card. A filter VALUE on a column marked personal or financial prints as
// "(withheld)" — the merge keeps the real value on the server, so the model
// never needs it back.

import type { Cell } from '../data/transforms';
import type { AnswerFilter, AnswerSpec } from './answerSpec';
import { WITHHELD } from './columnNotes';
import { harvestAppNumbers } from './numberAudit';
import type { LedgerEntry } from './numberAudit';

/** The block's first words — what ./suggestedAction's prompt calls it. */
export const PREVIOUS_ANSWER = 'PREVIOUS ANSWER';

const quoted = (s: string): string => `"${s}"`;

function filterWords(f: AnswerFilter, withheld: ReadonlySet<string>): string {
  if ('period' in f) return `${quoted(f.column)} in ${f.period}` + (f.yearsBack ? `, yearsBack ${f.yearsBack}` : '');
  const values: Cell[] = f.values ? f.values : f.value !== undefined ? [f.value] : [];
  if (!values.length) return `${quoted(f.column)} ${f.op}`;
  const said = withheld.has(f.column)
    ? WITHHELD
    : values.map((v) => (v === null ? 'empty' : typeof v === 'number' ? String(v) : quoted(v))).join(', ');
  return `${quoted(f.column)} ${f.op} ${said}`;
}

/**
 * The block, and what its own digits add to the turn's number ledger.
 *
 * A top-N, a numeric filter value or a digit in a name is a SETTING the block
 * states, not a figure the app computed — but a reply that repeats it ("still
 * the top 5, above 100") must not be accused of inventing one, and a false
 * accusation costs more than the guard is worth (./numberAudit). So every
 * number the block PRINTS enters the ledger, the way a card's "Filtered to"
 * line already does; a withheld value is not printed, so it is not entered.
 * Any figure the block does not print is still caught.
 */
export function previousAnswerBlock(
  spec: AnswerSpec,
  datasetName: string,
  withheld: ReadonlySet<string>,
): { text: string; ledger: LedgerEntry[] } {
  const parts = [
    `dataset ${quoted(datasetName)}`,
    `category ${quoted(spec.category)}` + (spec.grain ? ` by ${spec.grain}` : ''),
    `measures ${spec.measures.map((m) => `${m.aggregation}(${m.column})`).join(', ')}`,
  ];
  if (spec.series) parts.push(`split by ${quoted(spec.series)}`);
  if (spec.filters.length) parts.push(`filters: ${spec.filters.map((f) => filterWords(f, withheld)).join(', ')}`);
  if (spec.top) parts.push(`top ${spec.top}`);
  parts.push(`chart ${spec.chartType}`);
  const text = `${PREVIOUS_ANSWER} (the chart the user is looking at; names only):\n${parts.join('; ')}.`;

  const entry = (value: number, unit: LedgerEntry['unit']): LedgerEntry =>
    ({ label: 'a setting of the previous answer, not a computed figure', value, unit, source: 'previousAnswer' });
  const ledger = harvestAppNumbers(text).map((h) => entry(h.value, h.unit));
  // "top 5" reads as a list position to the harvest, so the cut is entered by hand.
  if (spec.top) ledger.push(entry(spec.top, 'count'));
  return { text, ledger };
}
