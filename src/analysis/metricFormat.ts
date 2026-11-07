// A metric AS TEXT — MAIN PROCESS, PURE logic.
// No fs, no DOM: a number and a MetricFormat in, a string out; a
// definition in, a sentence out. Node-testable by a plain `node` self-check.
//
// Two jobs that are one job: everything a reader SEES about a metric that is
// not the figure itself. `formatMetricValue` renders the number,
// `describeDefinition` renders the definition, and both are called from main —
// the IPC reply carries the finished strings.
//
// THE RENDERER DOES NOT FORMAT A METRIC: `metric:value` returns `{ value,
// display }` and the renderer prints `display`. Both sides now run the same
// formatter (src/app/format.ts) — the renderer for axes and unformatted cards,
// main for metrics — so the two can no longer disagree.

import type { FilterStep } from '../data/transforms';
import { isKeptStep } from '../data/filterList';
import { VALUELESS_OPS, LIST_OPS } from '../data/filterOps';
import type { Metric, MetricFormat, MetricDefinition } from './metrics';
import { formatMetric } from '../app/format';
import { describePeriod, getCalendar } from './dateIntel';
import { isExternalDefinition, isFormulaDefinition, isPeriodDefinition } from './metrics';
import { isNewerKind } from './pendingKinds';
import { definedElsewhere } from './externalMetricMessages';
import { periodWords } from './periodMetric';

/**
 * The ONE rendering of a metric's number — now `app/format.formatMetric`, the
 * formatter every surface shares, so a metric reads the same on a card, in a
 * caption and in an export, and follows Settings → Formats (locale, separators,
 * the workspace currency) while its own format still decides decimals, compact
 * and any explicit prefix.
 *
 * `null` is the app's honest "no figure" and renders as an em dash — never 0.
 */
export function formatMetricValue(value: number | null | undefined, format: MetricFormat): string {
  return formatMetric(value, format);
}

const AGG_WORDS: Record<string, string> = {
  sum: 'sum',
  avg: 'average',
  count: 'count',
  countd: 'count distinct',
  min: 'minimum',
  max: 'maximum',
};

// Main's own op vocabulary. the desktop's `dashFiltersUi.ts` has a similar list
// for the filter-bar CHIP, and the two are deliberately not shared: main cannot
// import a classic renderer <script>, and these words are a sentence fragment
// ("excluding region = West") where the chip's are a label.
const OP_WORDS: Record<string, string> = {
  '=': '=',
  '!=': '≠',
  '>': '>',
  '<': '<',
  '>=': '≥',
  '<=': '≤',
  contains: 'contains',
  is_empty: 'is empty',
  not_empty: 'is not empty',
  in: 'in',
  'not in': 'not in',
};

/** How many of a list filter's values to name before saying "+3 more". Past
 *  three the sentence stops being a sentence. */
const MAX_LISTED = 3;

export function describeFilter(s: FilterStep): string {
  if (isKeptStep(s)) return String(s.type).replace(/_/g, ' '); // a step this pod cannot read (a glossary term): named by its kind
  if (s.op === 'period') return s.period ? `${s.column} in ${describePeriod(s.period, getCalendar()).toLowerCase()}` : s.column;
  const op = OP_WORDS[s.op] || s.op;
  if (VALUELESS_OPS.has(s.op)) return `${s.column} ${op}`;
  if (LIST_OPS.has(s.op)) {
    const vals = Array.isArray(s.values) ? s.values : [];
    const shown = vals.slice(0, MAX_LISTED).map((v) => String(v)).join(', ');
    const rest = vals.length - MAX_LISTED;
    if (!vals.length) return `${s.column} ${op} (none)`;
    return `${s.column} ${op} ${shown}${rest > 0 ? ` +${rest} more` : ''}`;
  }
  return `${s.column} ${op} ${s.value == null ? '' : String(s.value)}`.trim();
}

/** A filter step without its value — "region in …" — for a reader the values are hidden from (a glossary term, semantic D12). */
export function describeFilterHidden(s: FilterStep): string {
  if (isKeptStep(s) || VALUELESS_OPS.has(s.op) || s.op === 'period') return describeFilter(s); // no row value in these
  return `${s.column} ${OP_WORDS[s.op] || s.op} …`;
}

/** Just the definition, with no filter clause — what a picker row shows under
 *  a name, where the row is already narrow. `base`: a period metric's base's name. */
export function describeDefinitionShort(definition: MetricDefinition, base?: string): string {
  if (isFormulaDefinition(definition)) return definition.formula;
  if (isPeriodDefinition(definition)) return periodWords(definition, base);
  if (isNewerKind(definition)) return 'a newer kind of metric'; // part 5's kinds, kept and not computed here
  if (isExternalDefinition(definition)) return definedElsewhere(); // b2 names the layer
  const agg = AGG_WORDS[definition.aggregation] || definition.aggregation;
  const head = definition.column ? `${agg} of ${definition.column}` : agg;
  const snap = definition.snapshot; // semantic D8: only the rows on that day; part 5's `per`: each entity's own
  return snap ? `${head}, on ${snap.per ? `each ${snap.per}'s` : 'the'} ${snap.take === 'last' ? 'latest' : 'earliest'} ${snap.column}` : head;
}

/**
 * The definition in words — "sum of revenue, excluding status = refunded".
 *
 * ONE function, three readers: the Metrics table's Definition column, the
 * picker's row tooltip, and the captions/facts main hands a model. A second
 * phrasing of the same definition is how a tooltip comes to describe a metric
 * the table describes differently.
 *
 * A formula metric describes itself — `[Profit] / [Revenue]` is already the
 * clearest sentence available for it, and paraphrasing an expression into prose
 * loses the exact thing the reader wants to check.
 *
 * `filterWords`: how one filter reads. A model is told a filter on a column the
 * user marked personal or financial without its value (ipc/copilotMeasures).
 */
export function describeDefinition(metric: Pick<Metric, 'definition' | 'filters'>, filterWords: (s: FilterStep) => string = describeFilter, base?: string): string {
  const head = describeDefinitionShort(metric.definition, base);
  const filters = Array.isArray(metric.filters) ? metric.filters : [];
  if (!filters.length) return head;
  // "where", not "excluding": a filter states what is KEPT. `status ≠ refunded`
  // reads as an exclusion, but `region = West` is the same field and is not one,
  // and one clause cannot be worded for both.
  return `${head}, where ${filters.map(filterWords).join(' and ')}`;
}
