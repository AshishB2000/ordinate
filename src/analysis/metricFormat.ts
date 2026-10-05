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
import { VALUELESS_OPS, LIST_OPS } from '../data/filterOps';
import type { Metric, MetricFormat, MetricDefinition } from './metrics';
import { formatMetric } from '../app/format';
import { describePeriod, getCalendar } from './dateIntel';
import { isFormulaDefinition } from './metrics';

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

function describeFilter(s: FilterStep): string {
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

/** Just the definition, with no filter clause — what a picker row shows under
 *  a name, where the row is already narrow. */
export function describeDefinitionShort(definition: MetricDefinition): string {
  if (isFormulaDefinition(definition)) return definition.formula;
  const agg = AGG_WORDS[definition.aggregation] || definition.aggregation;
  return definition.column ? `${agg} of ${definition.column}` : agg;
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
 */
export function describeDefinition(metric: Pick<Metric, 'definition' | 'filters'>): string {
  const head = describeDefinitionShort(metric.definition);
  const filters = Array.isArray(metric.filters) ? metric.filters : [];
  if (!filters.length) return head;
  // "where", not "excluding": a filter states what is KEPT. `status ≠ refunded`
  // reads as an exclusion, but `region = West` is the same field and is not one,
  // and one clause cannot be worded for both.
  return `${head}, where ${filters.map(describeFilter).join(' and ')}`;
}
