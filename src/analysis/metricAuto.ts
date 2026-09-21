// The metrics a project gets for free — MAIN PROCESS, PURE logic.
// Columns in, metric INPUTS out. No Electron, no fs, no model: node-testable by
// a plain `node` self-check.
//
// A Metrics page that opens empty asks the user to do the naming work before it
// will show them anything, on a project whose columns already say what its
// measures are. So the first open of a project with no metrics proposes one per
// numeric column, using the SAME ranking and the SAME aggregation choice the
// starter layouts use (./starterPlan) — imported, not re-listed, because
// "Revenue" summing on a dashboard and averaging in the Metrics table is
// exactly the disagreement this whole layer exists to end.
//
// These are ORDINARY RECORDS. Nothing marks them as generated, nothing
// re-proposes them after the first time, and editing or deleting one is just
// editing or deleting a metric.

import {
  words,
  aggregationFor,
  measureRank,
  MEASURE_WORDS,
  COUNT_WORDS,
  NOT_A_MEASURE_WORDS,
} from './starterPlan';
import type { ParsedColumn } from '../data/parse';
import type { MetricFormat, MetricInput } from './metrics';

/** Words that mean the number is money, so the metric carries a currency format. */
const MONEY_WORDS = new Set(['revenue', 'sales', 'amount', 'profit', 'cost', 'spend', 'gmv', 'price']);
/** Money you would rather have less of. */
const LOWER_IS_BETTER = new Set(['cost', 'spend', 'discount', 'refund', 'refunds', 'churn', 'latency', 'errors']);

/** `unit_price` → "Unit price". Sentence case, not Title Case: "Avg Order
 *  Value" is a spreadsheet header, "Avg order value" is a label. */
export function labelFor(column: string): string {
  const ws = words(column);
  if (!ws.length) return column;
  return ws[0].charAt(0).toUpperCase() + ws[0].slice(1) + (ws.length > 1 ? ' ' + ws.slice(1).join(' ') : '');
}

/**
 * The format a column's NAME implies.
 *
 * Deliberately conservative about `percent`: a column called `margin` may hold
 * 0.13 or 13, and a wrong guess multiplies someone's figure by a hundred. Only
 * a metric the app DEFINES as a ratio (see `marginMetric`) gets percent; a
 * merely rate-sounding column gets a plain number with decimals.
 */
export function formatFor(column: string, aggregation: string): MetricFormat {
  const ws = words(column);
  if (ws.some((w) => MONEY_WORDS.has(w))) {
    // An average of money is a per-thing figure people read to the cent; a sum
    // of it is a headline, where "$5.2M" beats "$5,194,598.73".
    return aggregation === 'avg'
      ? { kind: 'currency', decimals: 2, compact: false }
      : { kind: 'currency', decimals: 0, compact: true };
  }
  if (aggregation === 'avg') return { kind: 'number', decimals: 2, compact: false };
  return { kind: 'number', decimals: 0, compact: true };
}

function directionFor(column: string): 'up_good' | 'down_good' | undefined {
  const ws = words(column);
  if (ws.some((w) => LOWER_IS_BETTER.has(w))) return 'down_good';
  if (ws.some((w) => MEASURE_WORDS.has(w) || COUNT_WORDS.has(w))) return 'up_good';
  return undefined;
}

/** The first column whose name carries one of `wanted`. Declared order, so the
 *  choice is the same on every machine. */
function columnWith(columns: ParsedColumn[], wanted: Set<string>): ParsedColumn | undefined {
  return columns.find((c) => c.type === 'number' && words(c.name).some((w) => wanted.has(w)));
}

/**
 * Every metric a fresh project should already have.
 *
 * Order is the order the Metrics page will show before the user renames
 * anything: money first, then counts, then the rest — `measureRank`'s order,
 * with declared order inside a rank, which is the same stable sort
 * `kpiColumns` does. Unlike `kpiColumns` there is NO cap: four is the right
 * number of KPI tiles on a sheet and the wrong number of definitions to own.
 */
export function proposeMetrics(datasetId: string, columns: ParsedColumn[]): MetricInput[] {
  const cols = Array.isArray(columns) ? columns : [];
  const numeric = cols
    .filter((c) => c && c.type === 'number')
    // An id, a zip or a year is a number the way a phone number is. Same filter
    // as kpiColumns, same reason: no one wants a metric named "Sum of Zip".
    .filter((c) => !words(c.name).some((w) => NOT_A_MEASURE_WORDS.has(w)))
    .map((c, i) => ({ c, i, rank: measureRank(c.name) }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.c);

  const out: MetricInput[] = [];
  for (const c of numeric) {
    const aggregation = aggregationFor(c.name);
    const input: MetricInput = {
      name: labelFor(c.name),
      datasetId,
      definition: { column: c.name, aggregation },
      format: formatFor(c.name, aggregation),
    };
    const direction = directionFor(c.name);
    if (direction) input.direction = direction;
    out.push(input);
  }

  // "Rows" — the one metric every dataset has, and the only honest count when
  // no column is obviously the thing being counted. `count` over a date column
  // counts non-empty cells, which is what "how many orders" means; with no date
  // column the first column stands in, and with no columns at all there is
  // nothing to count and the metric is not proposed.
  const countable = cols.find((c) => c && c.type === 'date') || cols[0];
  if (countable) {
    out.push({
      name: 'Rows',
      datasetId,
      definition: { column: countable.name, aggregation: 'count' },
      format: { kind: 'number', decimals: 0, compact: true },
      direction: 'up_good',
    });
  }

  const margin = marginMetric(datasetId, cols, out);
  if (margin) out.push(margin);
  return out;
}

/**
 * `Margin %`, when the columns support one.
 *
 * Written as a FORMULA over the metrics just proposed rather than over the
 * columns, so it is a ratio of two app-computed figures and stays correct under
 * a filter: under a West filter it is West's profit over West's revenue, never
 * the whole dataset's ratio and never an average of per-row ratios.
 *
 * Profit is preferred over cost because it is the direct numerator; with only a
 * cost column the margin is spelled out from revenue and cost. Returns null
 * when there is no revenue column to divide by — a margin without a denominator
 * is not a margin.
 */
function marginMetric(
  datasetId: string,
  columns: ParsedColumn[],
  proposed: MetricInput[],
): MetricInput | null {
  const revenueCol = columnWith(columns, new Set(['revenue', 'sales', 'gmv']));
  if (!revenueCol) return null;
  const profitCol = columnWith(columns, new Set(['profit']));
  const costCol = columnWith(columns, new Set(['cost', 'spend']));
  if (!profitCol && !costCol) return null;

  // Reference the metrics BY THE NAME they were proposed under — if `labelFor`
  // ever changes, the formula follows it instead of pointing at a name no
  // record has.
  const nameOf = (col: ParsedColumn): string => {
    const found = proposed.find((m) => {
      const d = m.definition as { column?: string };
      return d && d.column === col.name;
    });
    return found ? found.name : labelFor(col.name);
  };
  const revenue = `[${nameOf(revenueCol)}]`;
  const formula = profitCol
    ? `[${nameOf(profitCol)}] / ${revenue}`
    : `(${revenue} - [${nameOf(costCol as ParsedColumn)}]) / ${revenue}`;

  return {
    name: 'Margin %',
    datasetId,
    definition: { formula },
    format: { kind: 'percent', decimals: 1, compact: false },
    direction: 'up_good',
    description: 'Profit as a share of revenue. Recomputed under whatever filters are in force.',
  };
}
