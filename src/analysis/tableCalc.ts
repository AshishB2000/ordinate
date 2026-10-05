// Table calculations — PURE, MAIN PROCESS, no fs / DOM.
//
// "Calculate as" on a measure: running total, percent of total, difference and
// percent difference from the previous cell, rank (dense or competition),
// percentile, moving average / sum over N, year over year, index to the first.
//
// THE APP DOES THE MATH, and the ORDER is the rule: a table calculation runs
// AFTER aggregation, on the aggregated grid, and never on raw rows. Every input
// here is a figure the app already computed (a chart's `{labels, series}`, a
// pivot's cells, a KPI's period series); every output is arithmetic over those.
// The raw figure is always kept beside the calculated one (`raw`), so a tooltip
// and a caption can say both: "24.1% of total · 1.25M".
//
// ── The shape ────────────────────────────────────────────────────────────────
// Stored on the measure as `calc?: TableCalc`. ADDITIVE: an absent `calc` means
// today's behaviour byte-for-byte — `applyChartCalcs` returns the very object it
// was given, and the pivot fold never touches a grid with no calc on it.
//
// ── The grid, and "compute along" ────────────────────────────────────────────
// A chart's grid is category (labels) × series.
//   across          along the category axis, within each series
//   down            along the series, within each category
//   { dimension }   along whichever axis that dimension IS: the category
//                   column → across, the split column → down
// A pivot's grid is its rows × its column groups (per value field).
//   across          along the column groups, within each grid row
//   down            along the grid rows, within each column group — among
//                   PEERS: leaf rows run with leaf rows, and a subtotal row runs
//                   with the subtotal rows of its own level. A subtotal is never
//                   one step in its children's running total.
//   { dimension }   a row dimension at depth d → down, restarting at depth d−1
//                   (so "along State" in Region › State runs within each
//                   Region); a column dimension → across, likewise.
// `restart` names a dimension; the along-direction is partitioned wherever that
// dimension's value changes. In a pivot a row at or above the restart level is
// partitioned by its parent instead (a Region subtotal restarted "every Region"
// runs with the other Regions, not alone). On a chart the grid has only the
// category and the split, so every restart is either a no-op or one cell per
// partition — which is why the builder offers restart on pivots only.
// A dimension or restart that names no dimension of the grid AT COMPUTE TIME is
// ignored, with a warning — the encoding may have changed under a saved calc.
//
// ── The kinds, precisely ─────────────────────────────────────────────────────
// Within one partition, cells in along-order; a null cell always yields null.
//   running_total     cumulative sum; a null cell is null and the total carries
//                     on from the previous non-null total.
//   pct_of_total      cell ÷ the partition's total, as a FRACTION (0.241).
//                     A chart's total is the sum of the partition's figures; a
//                     pivot's is the SOURCE total of the partition (a column
//                     total, a row total, a subtotal) recomputed from the rows —
//                     so a subtotal row's share is its own source subtotal ÷ the
//                     source total, never the sum of its children's shares.
//                     A zero or missing total → null.
//   diff              cell − previous cell; first cell, or a null neighbour → null.
//   pct_diff          (cell − previous) ÷ |previous|, a fraction; a zero or
//                     null previous → null (never Infinity).
//   rank_dense        largest = 1, ties share, no gaps: 1, 2, 2, 3.
//   rank_competition  largest = 1, ties share, gaps: 1, 2, 2, 4.
//   percentile        percent rank with the top at 1: (n − r) ÷ (n − 1) where r
//                     is the competition rank and n the non-null count; n = 1 → 1.
//   moving_avg/sum    trailing window of N cells ending at this one, within the
//                     partition. Fewer than N cells available (the start of a
//                     partition) → computed over the cells that ARE available;
//                     nulls inside the window are skipped. N defaults to 3.
//   yoy               (cell − same bucket a year earlier) ÷ |that|, a fraction,
//                     for a DATE axis only: each bucket is paired with
//                     `dateIntel.shiftBucketLabel(label)`. A missing, null or
//                     zero prior bucket → null.
//   index             cell ÷ the partition's first non-null cell × 100; a zero
//                     first value → null.
//
// If a pivot value has BOTH the older `showAs` and a `calc`, the calc wins.

import { formatCompact, formatNumber, formatPercent } from '../app/format';
import { shiftBucketLabel } from './dateIntel';
import type { DateGrain } from './categoryKey';

export type TableCalcKind =
  | 'running_total' | 'pct_of_total' | 'diff' | 'pct_diff'
  | 'rank_dense' | 'rank_competition' | 'percentile'
  | 'moving_avg' | 'moving_sum' | 'yoy' | 'index';

export type TableCalcAlong = 'across' | 'down' | { dimension: string };

export interface TableCalc {
  kind: TableCalcKind;
  along: TableCalcAlong;
  restart?: string;
  /** moving_avg / moving_sum only: the trailing window N. */
  window?: number;
}

export const TABLE_CALC_KINDS: readonly TableCalcKind[] = [
  'running_total', 'pct_of_total', 'diff', 'pct_diff', 'rank_dense', 'rank_competition',
  'percentile', 'moving_avg', 'moving_sum', 'yoy', 'index',
];
const KINDS: ReadonlySet<string> = new Set(TABLE_CALC_KINDS);
const MOVING: ReadonlySet<string> = new Set(['moving_avg', 'moving_sum']);
const PERCENT: ReadonlySet<string> = new Set(['pct_of_total', 'pct_diff', 'percentile', 'yoy']);

const CALC_WINDOW_MIN = 2;
const CALC_WINDOW_MAX = 366;
export const CALC_WINDOW_DEFAULT = 3;
const NAME_MAX = 500; // a dimension name is a column header, not an essay

/** What each kind is called in prose (the Assistant's facts, a caption). No digits. */
export const CALC_KIND_NAMES: Record<TableCalcKind, string> = {
  running_total: 'a running total', pct_of_total: 'percent of total', diff: 'the difference from the previous',
  pct_diff: 'the percent difference from the previous', rank_dense: 'a rank (dense)',
  rank_competition: 'a rank (competition)', percentile: 'a percentile', moving_avg: 'a moving average',
  moving_sum: 'a moving sum', yoy: 'the change year over year', index: 'an index to the first period',
};

export const isPercentKind = (kind: string): boolean => PERCENT.has(kind);
export const isMovingKind = (kind: string): boolean => MOVING.has(kind);

/**
 * Whitelist an untrusted (renderer / stored / model) calc. Unknown kind → the
 * whole calc is dropped; an unknown `along` → 'across'; a window only on a
 * moving kind, rounded and clamped to 2..366 (a non-number is dropped and the
 * default applies). Dimension names are kept as strings here and checked
 * against the grid when the calc runs — a saved chart's columns can change.
 */
export function sanitizeTableCalc(raw: unknown): TableCalc | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.kind !== 'string' || !KINDS.has(o.kind)) return undefined;
  const kind = o.kind as TableCalcKind;
  let along: TableCalcAlong = 'across';
  if (o.along === 'down') along = 'down';
  else if (o.along && typeof o.along === 'object') {
    const d = (o.along as Record<string, unknown>).dimension;
    if (typeof d === 'string' && d && d.length <= NAME_MAX) along = { dimension: d };
  }
  const out: TableCalc = { kind, along };
  if (typeof o.restart === 'string' && o.restart && o.restart.length <= NAME_MAX) out.restart = o.restart;
  if (MOVING.has(kind) && typeof o.window === 'number' && Number.isFinite(o.window)) {
    out.window = Math.min(CALC_WINDOW_MAX, Math.max(CALC_WINDOW_MIN, Math.round(o.window)));
  }
  return out;
}

// ── The kernel: one partition, in along-order ────────────────────────────────

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Rank the non-null values, largest first. `dense`: 1,2,2,3; else competition:
 * 1,2,2,4. Nulls stay null — a missing figure has no position.
 */
function ranks(values: (number | null)[], dense: boolean): (number | null)[] {
  const order = values.map((v, i) => ({ v, i })).filter((e): e is { v: number; i: number } => e.v !== null);
  order.sort((a, b) => b.v - a.v || a.i - b.i);
  const out: (number | null)[] = values.map(() => null);
  let rank = 0;
  order.forEach((e, k) => {
    if (k === 0 || e.v !== order[k - 1].v) rank = dense ? rank + 1 : k + 1;
    out[e.i] = rank;
  });
  return out;
}

export interface SequenceOpts {
  window?: number;
  /** pct_of_total: the partition's denominator. Absent → the sum of `values`. */
  total?: number | null;
  /** yoy: the figure one year earlier, aligned to `values`. */
  prior?: (number | null)[];
}

/** One partition's cells, in along-order → calculated cells. Pure and total. */
export function calcSequence(kind: TableCalcKind, raw: (number | null)[], opts: SequenceOpts = {}): (number | null)[] {
  const values = raw.map(num);
  const n = values.length;
  switch (kind) {
    case 'running_total': {
      let acc = 0;
      return values.map((v) => (v === null ? null : (acc += v)));
    }
    case 'pct_of_total': {
      let total: number | null = opts.total !== undefined ? num(opts.total) : null;
      if (opts.total === undefined) for (const v of values) if (v !== null) total = (total ?? 0) + v;
      return values.map((v) => (v === null || total === null || total === 0 ? null : v / total));
    }
    case 'diff':
    case 'pct_diff':
      return values.map((v, i) => {
        const p = i > 0 ? values[i - 1] : null;
        if (v === null || p === null) return null;
        if (kind === 'diff') return v - p;
        return p === 0 ? null : (v - p) / Math.abs(p);
      });
    case 'rank_dense':
    case 'rank_competition':
      return ranks(values, kind === 'rank_dense');
    case 'percentile': {
      const r = ranks(values, false);
      const count = values.filter((v) => v !== null).length;
      return r.map((k) => (k === null ? null : count === 1 ? 1 : (count - k) / (count - 1)));
    }
    case 'moving_avg':
    case 'moving_sum': {
      const w = opts.window ?? CALC_WINDOW_DEFAULT;
      return values.map((v, i) => {
        if (v === null) return null;
        let sum = 0;
        let seen = 0;
        for (let k = Math.max(0, i - w + 1); k <= i; k += 1) {
          const x = values[k];
          if (x !== null) { sum += x; seen += 1; }
        }
        return kind === 'moving_sum' ? sum : sum / seen;
      });
    }
    case 'yoy': {
      const prior = opts.prior || [];
      return values.map((v, i) => {
        const p = i < prior.length ? num(prior[i]) : null;
        return v === null || p === null || p === 0 ? null : (v - p) / Math.abs(p);
      });
    }
    case 'index': {
      const first = values.find((v) => v !== null) ?? null;
      return values.map((v) => (v === null || first === null || first === 0 ? null : (v / first) * 100));
    }
    default:
      return new Array<number | null>(n).fill(null);
  }
}

// ── Charts: `{labels, series}` ───────────────────────────────────────────────

/** A chart series after a calc: `values` calculated, `raw` the figures behind them. */
export interface CalcSeries {
  name: string;
  values: (number | null)[];
  role?: 'overlay';
  raw?: (number | null)[];
  calc?: TableCalc;
}

interface CalcEncoding {
  category: string;
  series?: string;
  values: Array<{ column?: string; calc?: TableCalc; aggregation?: string }>;
  geo?: unknown;
}

const dimNote = (what: string, name: string): string =>
  `The table calculation's ${what} "${name}" is not a dimension of this chart, so it was ignored.`;

/**
 * Apply each measure's calc to the chart grid. `category` is vizData's
 * `CategoryInfo` — a DATE category with a grain is what year-over-year needs.
 * Returns `data` ITSELF when no measure has a calc, so an old visual is
 * untouched down to object identity.
 */
export function applyChartCalcs<T extends { labels: (string | number)[]; series: CalcSeries[] }>(
  data: T,
  enc: CalcEncoding,
  category?: { kind?: string; grain?: DateGrain } | null,
  warnings: string[] = [],
): T {
  const measures = enc && Array.isArray(enc.values) ? enc.values : [];
  if (!data || !Array.isArray(data.series) || !measures.some((m) => m && m.calc)) return data;
  const split = typeof enc.series === 'string' && enc.series !== '';
  const note = (w: string): void => { if (!warnings.includes(w)) warnings.push(w); };
  // Never on raw rows: an all-'none' chart plots one point per ROW, and a map's
  // regions are matched by name from figures computed before this runs.
  if (enc.geo) return data;
  if (!split && measures.every((m) => m && m.aggregation === 'none')) {
    note('Table calculations run on aggregated figures, and this chart plots one point per row.');
    return data;
  }
  const labels = Array.isArray(data.labels) ? data.labels : [];
  const plotted = data.series.filter((s) => s.role !== 'overlay');
  const raw = plotted.map((s) => labels.map((_, i) => num(s.values[i])));
  const axisOf = (dim: string): 'across' | 'down' | null =>
    dim === enc.category ? 'across' : split && dim === enc.series ? 'down' : null;

  const out = plotted.map((s, j) => {
    // A split chart plots ONE measure as many series; otherwise series j IS measure j.
    const calc = sanitizeTableCalc(split ? measures[0]?.calc : measures[j]?.calc);
    if (!calc) return s;
    let along: 'across' | 'down' = calc.along === 'down' ? 'down' : 'across';
    if (typeof calc.along === 'object') {
      const a = axisOf(calc.along.dimension);
      if (a) along = a;
      else note(dimNote('dimension', calc.along.dimension));
    }
    const restartAxis = calc.restart ? axisOf(calc.restart) : null;
    if (calc.restart && !restartAxis) note(dimNote('restart', calc.restart));
    // Restarting on the along axis puts every cell in a partition of its own;
    // restarting on the other axis is what the partitions already are.
    const alone = restartAxis === along;
    const one = (v: number | null, prior?: number | null): number | null =>
      calcSequence(calc.kind, [v], { window: calc.window, prior: prior === undefined ? undefined : [prior] })[0];
    let values: (number | null)[];
    if (along === 'across') {
      const prior = calc.kind === 'yoy' ? yoyPrior(labels, raw[j], category, note) : undefined;
      values = alone
        ? raw[j].map((v, i) => one(v, prior ? prior[i] : undefined))
        : calcSequence(calc.kind, raw[j], { window: calc.window, prior });
    } else {
      if (calc.kind === 'yoy') note('Year over year runs along a date category, not down the series.');
      // Down: this series' position in each category's column of cells.
      values = labels.map((_, i) => {
        if (calc.kind === 'yoy') return null;
        const column = raw.map((r) => r[i]);
        return alone ? one(column[j]) : calcSequence(calc.kind, column, { window: calc.window })[j];
      });
    }
    return { ...s, values, raw: raw[j], calc };
  });
  const series = data.series.map((s) => {
    const j = plotted.indexOf(s);
    return j < 0 ? s : out[j];
  });
  return { ...data, series };
}

/** The figure a year before each bucket, or all-null with a warning off a date axis. */
function yoyPrior(
  labels: (string | number)[],
  values: (number | null)[],
  category: { kind?: string; grain?: DateGrain } | null | undefined,
  note: (w: string) => void,
): (number | null)[] {
  if (!category || category.kind !== 'date' || !category.grain) {
    note('Year over year needs a date category.');
    return labels.map(() => null);
  }
  const grain = category.grain;
  const at = new Map<string, number | null>();
  labels.forEach((l, i) => at.set(String(l), num(values[i])));
  return labels.map((l) => {
    const key = shiftBucketLabel(String(l), grain);
    return key !== null && at.has(key) ? (at.get(key) as number | null) : null;
  });
}

/** `withPeriodOverlay`'s sibling: a `visual:data` reply with its calcs applied. */
export function withTableCalcs<R extends { ok: boolean }>(reply: R, enc: CalcEncoding): R {
  if (!reply || !reply.ok) return reply;
  type Data = { labels: (string | number)[]; series: CalcSeries[]; pivot?: { calcWarnings?: string[] } };
  const r = reply as R & { data: Data; warnings?: string[]; category?: { kind?: string; grain?: DateGrain } };
  if (!r.data) return reply;
  const warnings = Array.isArray(r.warnings) ? r.warnings.slice() : [];
  // A pivot computed its calcs in the fold (pivotCalc.ts), on the grid; only
  // what it ignored is left to say.
  if (r.data.pivot) {
    const notes = r.data.pivot.calcWarnings || [];
    return notes.length ? { ...r, warnings: warnings.concat(notes.filter((w) => !warnings.includes(w))) } : reply;
  }
  const data = applyChartCalcs(r.data, enc, r.category, warnings);
  return data === r.data ? reply : { ...r, data, warnings };
}

// ── Display: "24.1% of total · 1.25M" ────────────────────────────────────────
//
// Mirrored in the desktop's calcMenu.ts (`tcCalcParts`) for tooltips, both built
// on src/app/format — scripts/test-tableCalc.ts runs the two side by side.

const SUFFIX: Record<TableCalcKind, string> = {
  running_total: ' running total', pct_of_total: ' of total', diff: ' vs previous', pct_diff: ' vs previous',
  rank_dense: '', rank_competition: '', percentile: ' percentile', moving_avg: ' moving avg',
  moving_sum: ' moving sum', yoy: ' YoY', index: ' index',
};

const signed = (v: number, text: string): string => (v > 0 ? '+' + text : text);

/** The calculated figure alone, formatted for its kind: 24.1%, #3, 112.4, +1.2K. */
export function calcValueText(kind: string, value: number | null | undefined): string {
  const v = num(value);
  if (v === null) return '—';
  if (kind === 'pct_diff' || kind === 'yoy') return signed(v, formatPercent(v, 1));
  if (kind === 'pct_of_total' || kind === 'percentile') return formatPercent(v, 1);
  if (kind === 'rank_dense' || kind === 'rank_competition') return '#' + formatNumber(v, { maxDecimals: 0 });
  if (kind === 'index') return formatNumber(v, { decimals: 1 });
  if (kind === 'diff') return signed(v, formatCompact(v));
  return formatCompact(v);
}

/** The three pieces a surface lays out: figure, what it is, and the raw figure. */
export function calcParts(kind: string, value: number | null | undefined, raw?: number | null): { value: string; suffix: string; raw: string } {
  const r = num(raw);
  return { value: calcValueText(kind, value), suffix: SUFFIX[kind as TableCalcKind] ?? '', raw: r === null ? '' : formatCompact(r) };
}

/** "24.1% of total · 1.25M" — the calculated figure, then the raw one. */
export function calcLabel(kind: string, value: number | null | undefined, raw?: number | null): string {
  const p = calcParts(kind, value, raw);
  return p.value + p.suffix + (p.raw ? ' · ' + p.raw : '');
}
