// The AGGREGATOR half of Insights, and the shapes both halves speak.
//
// This is the part that is TWINNED: `residentAgg` answers a group-by out of the
// stored Parquet, `jsAgg` folds already-hydrated rows, and everything that
// decides what a finding IS lives in `insights.ts` and is written once against
// whichever of the two it was handed. Splitting them this way is what keeps the
// rules from being a place the two paths can disagree — there is nothing in
// here to rank, round or phrase, and nothing in `insights.ts` that knows
// whether it is reading SQL or JS.
//
// ── What the two must agree on ───────────────────────────────────────────────
//   · GROUPS ARE RAW CELLS, first-seen order. No date bucketing in SQL and no
//     binning — the same "a period is a distinct value of the date column" rule
//     `anomalies.periodChangeAnomaly` already ships. Rolling DAYS UP TO MONTHS
//     (`periodPlan`) happens in TypeScript over the labels both aggregators
//     return, so the roll-up cannot be a place they disagree either.
//   · EMPTY IS null OR '' OR whitespace, and an empty group is DROPPED on both
//     sides (SQL returns it as '', JS never forms it).
//   · SUM over no finite value is `null`, never 0.
//   · Only a column DECLARED `number` is summed. `'007'` is text and stays text.
//
// MAIN PROCESS. No Electron, no DOM, no fs.

import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep } from '../data/transforms';
import type { VizEncoding } from './visuals';
import type * as residentQuery from '../engine/residentQuery';
import { aggregateResident } from '../engine/residentQuery';

export type InsightKind =
  | 'mover'
  | 'trend'
  | 'concentration'
  | 'numeric_outlier'
  | 'dominant_category'
  | 'empty_heavy'
  | 'constant_column'
  | 'period_change';

export interface InsightChart {
  /** A `renderResult.VIZ_LABELS` chart id — 'line' | 'column' | … */
  type: string;
  encoding: VizEncoding;
  /**
   * The rows the chart is ABOUT. Not part of `VizEncoding` (a saved Visual
   * carries filters separately) and load-bearing here: a mover's card claims
   * something about ONE category, so its chart has to be that category.
   */
  filters?: FilterStep[];
}

export interface Insight {
  /**
   * Stable across recomputes: it names WHAT the finding is about (kind, column,
   * period), never the figures. That is what lets a dismissal stick — and what
   * makes a new period, i.e. new data, produce a new id that comes back.
   */
  id: string;
  kind: InsightKind;
  /** One line, app-authored, figures already embedded. No exclamation marks. */
  title: string;
  detail: string;
  severity: 'info' | 'warn';
  datasetId: string;
  column?: string;
  facts: Record<string, string | number>;
  chart?: InsightChart;
  periodKey?: string;
}

/** One group-by, one measure. `null` means "this aggregator has no answer". */
/** One aggregator answer: groups in first-seen order, or null (this reader declined). */
export type AggOut = { labels: string[]; values: (number | null)[] } | null;

/** `jsAgg` answers synchronously, `residentAgg` on the async DuckDB bridge. */
export type Agg = (
  category: string,
  measure: string,
  filters?: FilterStep[],
) => AggOut | Promise<AggOut>;

export interface InsightOptions {
  /** Least-squares total change must exceed this to be reported. */
  trendPct?: number;
  /** A mover at or above this |pct| is a `warn`. */
  moverWarnPct?: number;
  /** Cumulative share the top-k categories must reach to be "concentrated". */
  concentrationShare?: number;
  /** Cards of any ONE kind. Keeps a Home row from being six of the same thing. */
  maxPerKind?: number;
  maxTotal?: number;
}

export const DEFAULTS: Required<InsightOptions> = {
  trendPct: 0.15,
  moverWarnPct: 0.25,
  concentrationShare: 0.6,
  maxPerKind: 6,
  maxTotal: 12,
};

/** Past this many distinct dates, daily periods stop being periods. */
const MAX_RAW_PERIODS = 24;
/** The ISO shape a month prefix is only safe to take from. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
/** `'2024-12-30'.slice(0, MONTH_LEN)` — the year-month bucket. */
const MONTH_LEN = 7;

// ── shared helpers (same spellings as anomalies.ts) ──────────────────────────

function isEmpty(cell: Cell): boolean {
  if (cell == null) return true;
  return typeof cell === 'string' && cell.trim() === '';
}

function keyOf(cell: Cell): string {
  return typeof cell === 'number' ? String(cell) : (cell as string);
}

export function round(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1e6) / 1e6;
}

/** Percent, one decimal — what a card actually prints. */
export function pct1(ratio: number): number {
  return Math.round(ratio * 1000) / 10;
}

/** `anomalies.periodChangeAnomaly`'s ordering rule, verbatim. */
export function orderPeriods(keys: string[]): string[] {
  const out = keys.slice();
  if (keys.every((k) => Number.isFinite(Date.parse(k)))) {
    out.sort((a, b) => Date.parse(a) - Date.parse(b));
  } else {
    out.sort();
  }
  return out;
}

/**
 * How a date column's distinct values become PERIODS.
 *
 * Two years of daily orders is 725 "periods", and a day-over-day mover on four
 * rows is noise wearing a percentage. So past `MAX_RAW_PERIODS` distinct values,
 * ISO dates roll up to their year-month prefix.
 *
 * Both halves of that are deliberate:
 *   · the roll-up runs in TYPESCRIPT, over the labels the aggregator returned,
 *     so SQL and JS cannot bucket differently — there is only one bucketer;
 *   · the FILTER it implies is `contains '2024-12'`, which is exact for
 *     `YYYY-MM-DD` (a year-month appears nowhere else in such a string) and is
 *     already twinned by `residentQuery.filterPredicate` /
 *     `transforms.stepFilter`. Anything not ISO keeps its raw values and an `=`,
 *     because a prefix of an unknown date shape is a guess.
 *
 * ponytail: months only, never weeks or quarters. A quarter label ('2024-Q4')
 * is not a substring of a date, so it would need a real range filter — which is
 * the upgrade path if someone wants one.
 */
export function periodPlan(labels: string[]): { of: (label: string) => string; op: '=' | 'contains' } {
  const iso = labels.length > 0 && labels.every((l) => ISO_DATE_RE.test(l));
  if (!iso || new Set(labels).size <= MAX_RAW_PERIODS) return { of: (l) => l, op: '=' };
  return { of: (l) => l.slice(0, MONTH_LEN), op: 'contains' };
}

/** Sum an aggregator's answer into periods. Null measures are dropped, as
 *  everywhere else: a period with nothing to sum is not a period with a 0. */
export function foldPeriods(
  agg: { labels: string[]; values: (number | null)[] },
  plan: { of: (label: string) => string },
): Map<string, number> {
  const by = new Map<string, number>();
  agg.labels.forEach((l, i) => {
    const v = agg.values[i];
    if (typeof v !== 'number') return;
    const k = plan.of(l);
    by.set(k, (by.get(k) ?? 0) + v);
  });
  return by;
}

// ── the two aggregators ──────────────────────────────────────────────────────

/**
 * SQL over the stored Parquet. `{ kind: 'raw' }` is deliberate: it is the ONLY
 * category key whose groups are the stored cells, which is what makes a period
 * filter a plain `=` and keeps this equal to `jsAgg` by construction.
 */
export function residentAgg(src: residentQuery.ResidentSource): Agg {
  return async (category, measure, filters) => {
    if (!isNumberColumn(src.columns, measure)) return null;
    const out = await aggregateResident(
      src,
      category,
      [{ column: measure, aggregation: 'sum' }],
      filters,
      { kind: 'raw' },
    );
    if (!out || out.series.length !== 1) return null;
    return dropEmptyGroups(out.labels.map((l) => String(l)), out.series[0].values);
  };
}

/** The reference: a first-seen-order fold over already-hydrated rows (synchronous). */
export function jsAgg(columns: ParsedColumn[], rows: Cell[][]): (...args: Parameters<Agg>) => AggOut {
  const idx = (name: string): number => columns.findIndex((c) => c && c.name === name);
  return (category, measure, filters) => {
    const gi = idx(category);
    const mi = idx(measure);
    if (gi < 0 || mi < 0 || !isNumberColumn(columns, measure)) return null;

    const labels: string[] = [];
    const sums = new Map<string, number>();
    const hits = new Map<string, number>();
    for (const r of rows) {
      if (!r || !matchesAll(r, columns, filters)) continue;
      const g = r[gi] ?? null;
      if (isEmpty(g)) continue;
      const k = keyOf(g);
      if (!sums.has(k)) {
        labels.push(k);
        sums.set(k, 0);
        hits.set(k, 0);
      }
      const v = r[mi];
      if (typeof v === 'number' && Number.isFinite(v)) {
        sums.set(k, (sums.get(k) as number) + v);
        hits.set(k, (hits.get(k) as number) + 1);
      }
    }
    // SUM over no finite value is NULL in SQL, and must be null here too.
    return { labels, values: labels.map((k) => ((hits.get(k) as number) > 0 ? (sums.get(k) as number) : null)) };
  };
}

/**
 * THE MEASURE GATE, and it is deliberately in TypeScript on BOTH paths.
 *
 * `residentQuery.aggExpr` already refuses to sum a non-number column, but it
 * refuses by returning `CAST(NULL AS DOUBLE)` — a row of nulls, not a failure.
 * `jsAgg` has no such answer to give. Gating here instead of relying on either
 * side's degradation is what makes the two aggregators return the SAME thing
 * ("no answer") for the same input, which is the property the differential test
 * exists to hold.
 */
function isNumberColumn(columns: ParsedColumn[], name: string): boolean {
  const c = columns.find((x) => x && x.name === name);
  return !!c && c.type === 'number';
}

/** Only the two operators this module emits (`=` and `contains`), spelled the
 *  way `transforms.stepFilter` spells them. Anything else is not our business. */
function matchesAll(row: Cell[], columns: ParsedColumn[], filters?: FilterStep[]): boolean {
  if (!filters || filters.length === 0) return true;
  for (const f of filters) {
    const ci = columns.findIndex((c) => c && c.name === f.column);
    if (ci < 0) return false;
    // `cellToString`: a null cell is '', which is what both filter paths compare.
    const text = row[ci] == null ? '' : keyOf(row[ci] as Cell);
    const needle = String(f.value ?? '');
    if (f.op === 'contains' ? !text.includes(needle) : text !== needle) return false;
  }
  return true;
}

function dropEmptyGroups(labels: string[], values: (number | null)[]): { labels: string[]; values: (number | null)[] } {
  const L: string[] = [];
  const V: (number | null)[] = [];
  labels.forEach((l, i) => {
    if (l.trim() === '') return;
    L.push(l);
    V.push(values[i] ?? null);
  });
  return { labels: L, values: V };
}

/** The chart an insight draws: one measure over one category. */
export function measureEncoding(category: string, measure: string): VizEncoding {
  return { category, values: [{ column: measure, aggregation: 'sum' }] };
}
