// A metric AS TEXT — MAIN PROCESS, PURE logic.
// No Electron, no fs, no DOM: a number and a MetricFormat in, a string out; a
// definition in, a sentence out. Node-testable by a plain `node` self-check.
//
// Two jobs that are one job: everything a reader SEES about a metric that is
// not the figure itself. `formatMetricValue` renders the number,
// `describeDefinition` renders the definition, and both are called from main —
// the IPC reply carries the finished strings.
//
// THE RENDERER DOES NOT FORMAT A METRIC. `renderer/hub/hub.ts`'s `fmtWith` still
// formats everything else (a chart axis, a metric card with no metricId), but it
// cannot express decimals/prefix/suffix, and a second formatter is how "Revenue"
// comes to read as $5.2M on a card and 5194598.73 in a caption. So `metric:value`
// returns `{ value, display }` and the renderer prints `display`.

import type { FilterStep } from '../data/transforms';
import { VALUELESS_OPS, LIST_OPS } from '../data/filterOps';
import type { Metric, MetricFormat, MetricDefinition } from './metrics';
import { describePeriod, getCalendar } from './dateIntel';
import { isFormulaDefinition } from './metrics';

/**
 * A compact number keeps ONE fraction digit at minimum.
 *
 * `compact` with `decimals: 0` renders 5,194,598 as "5M", which throws away the
 * digit the compact form exists to show. The floor applies to the compact
 * branch only — a plain integer metric still renders as an integer.
 */
function compactDigits(decimals: number): number {
  return Math.max(1, decimals);
}

/** Seconds → the two largest non-zero units: `45s`, `12m 30s`, `1h 23m`, `3d 4h`. */
function formatDuration(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? '-' : '';
  const s = Math.floor(Math.abs(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${sign}${d}d${h ? ' ' + h + 'h' : ''}`;
  if (h > 0) return `${sign}${h}h${m ? ' ' + m + 'm' : ''}`;
  if (m > 0) return `${sign}${m}m${sec ? ' ' + sec + 's' : ''}`;
  return `${sign}${sec}s`;
}

/**
 * The ONE rendering of a metric's number.
 *
 * `null` is the app's honest "no figure" (unknown column, no numeric cells, a
 * formula whose operand is missing) and renders as an em dash — never as 0,
 * which is a fact about the data rather than the absence of one.
 *
 * `percent` multiplies by 100: a ratio metric stores 0.132 and shows "13.2%",
 * matching the renderer's existing `fmtWith(v,'percent')` so a card that gains
 * a metricId does not change what it says.
 */
export function formatMetricValue(value: number | null | undefined, format: MetricFormat): string {
  if (value == null || typeof value !== 'number' || !Number.isFinite(value)) return '—';

  const f = format;
  const scaled = f.kind === 'percent' ? value * 100 : value;

  let body: string;
  if (f.kind === 'duration') {
    // Already compact by construction, and a "1.2h 3m" would be nonsense, so
    // `compact`/`decimals` are deliberately not consulted here.
    body = formatDuration(value);
  } else if (f.compact) {
    body = scaled.toLocaleString(undefined, {
      notation: 'compact',
      maximumFractionDigits: compactDigits(f.decimals),
    });
  } else {
    body = scaled.toLocaleString(undefined, {
      minimumFractionDigits: f.decimals,
      maximumFractionDigits: f.decimals,
    });
  }

  // A currency with no prefix of its own gets "$" — the same symbol `fmtWith`
  // already uses. An explicit prefix wins, which is how a non-dollar currency
  // is spelled without a currency-code vocabulary nobody asked for.
  const prefix = f.prefix || (f.kind === 'currency' ? '$' : '');
  const suffix = (f.suffix || '') + (f.kind === 'percent' ? '%' : '');

  // The minus sign leads, always: "-$1,200", never "$-1,200".
  if (prefix && body.startsWith('-')) return '-' + prefix + body.slice(1) + suffix;
  return prefix + body + suffix;
}

const AGG_WORDS: Record<string, string> = {
  sum: 'sum',
  avg: 'average',
  count: 'count',
  min: 'minimum',
  max: 'maximum',
};

// Main's own op vocabulary. `renderer/hub/dashFiltersUi.ts` has a similar list
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
