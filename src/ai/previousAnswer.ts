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

/** A name or a text value as the block says it. A quote inside is escaped: left bare it would close the name, and what follows would read as fields the answer does not have. */
const quoted = (s: string): string => JSON.stringify(s);

const valuesOf = (f: Exclude<AnswerFilter, { period: unknown }>): Cell[] => (f.values ? f.values : f.value !== undefined ? [f.value] : []);

function filterWords(f: AnswerFilter, withheld: ReadonlySet<string>): string {
  if ('period' in f) return `${quoted(f.column)} in ${f.period}` + (f.yearsBack ? `, yearsBack ${f.yearsBack}` : '');
  const values = valuesOf(f);
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
 * accusation costs more than the guard is worth (./numberAudit). So the
 * numbers the block states enter the ledger; a withheld value is not printed,
 * so it is not entered. Any figure the block does not state is still caught.
 *
 * The settings are entered as the NUMBERS they are, not read back off the
 * text: there a threshold of 2000 passes for a year and is never entered, so
 * "2,000" in a reply would be accused. A negative one is also entered without
 * its sign ("losing more than 50"). Only words are harvested — the dataset's
 * and the columns' own names, and the TEXT filter values, which a person or a
 * model wrote: a digit in one may be said back ("Tier 2"), but none of them
 * vouches for a percentage, the one figure the audit is strict about.
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

  const settings: number[] = spec.top ? [spec.top] : [];
  const words: string[] = [datasetName, spec.category, spec.series ?? '', ...spec.measures.map((m) => m.column)];
  for (const f of spec.filters) {
    words.push(f.column);
    if ('period' in f) {
      if (f.yearsBack) settings.push(f.yearsBack);
    } else if (!withheld.has(f.column)) {
      for (const v of valuesOf(f)) {
        if (typeof v === 'number') settings.push(v, ...(v < 0 ? [-v] : []));
        else if (typeof v === 'string') words.push(v);
      }
    }
  }
  const ledger = [...settings, ...words.flatMap((w) => harvestAppNumbers(w).map((h) => h.value))].map((value): LedgerEntry =>
    ({ label: 'a setting of the previous answer, not a computed figure', value, unit: 'number', source: 'previousAnswer' }));
  return { text, ledger };
}
