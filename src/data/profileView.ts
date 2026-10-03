// What a column profile and the Quality tab's completeness table SHOW, as
// figures — MAIN PROCESS, pure. Every percentage and bar length the desktop
// renderer works out for itself in renderer/hub/dsProfile.ts is computed here
// instead, so the browser only formats (plan §6.4: React never rounds a figure).
//
// The rules are dsProfile.ts's, restated: filled % rounds to a whole percent;
// a histogram bar is its share of the tallest bucket with a 3% floor for any
// non-empty bucket (an empty one keeps its slot at 0); a labelled bar has a 2%
// floor; a text column shows its 10 largest values, a month grain stays in
// axis order (which the desktop assumed and `visual:data` does not give —
// see `inAxisOrder`). The two axis edges are the first and last bucket labels split
// on the en dash `binLabel` joins with.

import type { ColumnSummary } from './datasetStats';
import type { ColumnType } from './parse';
import { binLabel, binPlan } from '../analysis/categoryKey';

/** Buckets a NUMBER column's histogram asks for (dsProfile.ts DS_PROFILE_BINS). */
export const PROFILE_BINS = 20;
/** Bars a TEXT column's top values show (dsProfile.ts DS_PROFILE_TOP). */
export const PROFILE_TOP = 10;

/** `part` of `total` as a whole percent; null with no denominator. */
export function pctOf(part: number, total: number): number | null {
  return total ? Math.round((part / total) * 100) : null;
}

/** Each column's filled % for the completeness table (an empty table reads 100, as on the desktop). */
export function filledPcts(summaries: readonly ColumnSummary[], rowCount: number): number[] {
  return summaries.map((s) => (rowCount ? Math.round((s.nonEmpty / rowCount) * 100) : 100));
}

export interface Bar {
  label: string;
  value: number;
  /** Bar length: a histogram's height or a labelled bar's width, 0–100. */
  pct: number;
}

export interface Distribution {
  kind: 'histogram' | 'bars';
  /** What the chart is: a number column's distribution, a date column by month, a text column's top values. */
  heading: 'distribution' | 'month' | 'top';
  bars: Bar[];
  /** Buckets or distinct values before the top-N cut. */
  of: number;
  /** Histogram only: rows across every bucket, and the axis's two edges. */
  total?: number;
  lo?: string;
  hi?: string;
}

/** One side of a `binLabel` ("1.2K–2.4K"): split on the EN DASH, so "-10–-5" survives. */
function edgeOf(label: string, side: 0 | 1): string {
  const parts = label.split('–');
  return parts.length === 2 ? parts[side] : label;
}

/**
 * A number column's buckets in AXIS order, every bucket present. `visual:data`
 * returns the populated buckets in first-seen order (the chart layer orders
 * its axis itself), so the desktop panel drew a scrambled histogram with its
 * gaps closed; here each of the plan's buckets is looked up by the label
 * `binLabel` gives it, an absent one is a zero. Two buckets that compact to
 * one label cannot be told apart, so then the reply's order stands.
 */
function inAxisOrder(dist: { label: string; value: number }[], range: { min: number; max: number } | null) {
  if (!range) return dist;
  const plan = binPlan(range.min, range.max, PROFILE_BINS);
  const labels = Array.from({ length: plan.bins }, (_, i) => binLabel(i, plan.lo, plan.width, plan.bins, plan.hi));
  const byLabel = new Map(dist.map((r) => [r.label, r.value]));
  if (new Set(labels).size !== labels.length || dist.some((r) => !labels.includes(r.label))) return dist;
  return labels.map((label) => ({ label, value: byLabel.get(label) ?? 0 }));
}

/**
 * The profile's chart from a `visual:data` reply's labels and its count
 * series; null when there is nothing to chart. The empty-cell bucket ('') is
 * left out: it counts no values (the measure is a count of the column itself),
 * and the panel's Empty line already says how many cells are blank.
 * `range` is a number column's min and max, the plan `visual:data` binned on.
 */
export function distribution(
  type: ColumnType,
  labels: readonly unknown[],
  values: readonly unknown[],
  range: { min: number; max: number } | null = null,
): Distribution | null {
  const all = labels.map((l, i) => ({ label: l == null ? '' : String(l), value: typeof values[i] === 'number' ? (values[i] as number) : 0 }));
  let dist = all.filter((r) => r.label !== '');
  if (dist.length === 0) return null;
  if (type === 'number') {
    dist = inAxisOrder(dist, range);
    const max = dist.reduce((m, r) => (r.value > m ? r.value : m), 0);
    return {
      kind: 'histogram',
      heading: 'distribution',
      bars: dist.map((r) => ({ ...r, pct: max > 0 && r.value > 0 ? Math.max(3, Math.round((r.value / max) * 100)) : 0 })),
      of: dist.length,
      total: dist.reduce((sum, r) => sum + r.value, 0),
      lo: edgeOf(dist[0].label, 0),
      hi: edgeOf(dist[dist.length - 1].label, 1),
    };
  }
  // Text: the biggest first. Months: the timeline ('YYYY-MM' sorts as text).
  const rows = type === 'text'
    ? dist.slice().sort((a, b) => b.value - a.value).slice(0, PROFILE_TOP)
    : dist.slice().sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const max = rows.reduce((m, r) => (r.value > m ? r.value : m), 0);
  return {
    kind: 'bars',
    heading: type === 'date' ? 'month' : 'top',
    bars: rows.map((r) => ({ ...r, pct: max > 0 ? Math.max(2, Math.round((r.value / max) * 100)) : 0 })),
    of: dist.length,
  };
}

export interface ColumnProfile {
  name: string;
  type: ColumnType;
  rowCount: number;
  /** Non-empty cells, the same rule as the Quality tab's (null when the summary is missing). */
  filled: number | null;
  filledPct: number | null;
  empty: number | null;
  distinct: number | null;
  /** Number columns only; null elsewhere or with no finite cell. */
  min: number | null;
  median: number | null;
  max: number | null;
  /** The most common value of a text / date column — "Filter rows on this". */
  mostCommon: string | null;
  distribution: Distribution | null;
}

/** The whole panel from the app's own figures: the column's summary, its median and distinct total, and its count series. */
export function columnProfile(
  column: { name: string; type: ColumnType },
  rowCount: number,
  summary: ColumnSummary | undefined,
  extra: { median: number | null; distinct: number | null },
  viz: { labels: readonly unknown[]; values: readonly unknown[] } | null,
): ColumnProfile {
  const filled = summary && typeof summary.nonEmpty === 'number' ? summary.nonEmpty : null;
  const num = column.type === 'number';
  return {
    name: column.name,
    type: column.type,
    rowCount,
    filled,
    filledPct: filled === null ? null : pctOf(filled, rowCount),
    empty: filled === null ? null : Math.max(0, rowCount - filled),
    distinct: summary && typeof summary.distinct === 'number' ? summary.distinct : extra.distinct,
    min: num && summary && typeof summary.min === 'number' ? summary.min : null,
    median: num ? extra.median : null,
    max: num && summary && typeof summary.max === 'number' ? summary.max : null,
    mostCommon: summary && summary.mostCommon ? String(summary.mostCommon.value) : null,
    distribution: viz
      ? distribution(column.type, viz.labels, viz.values,
        num && summary && typeof summary.min === 'number' && typeof summary.max === 'number' ? { min: summary.min, max: summary.max } : null)
      : null,
  };
}
