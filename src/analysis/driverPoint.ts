// "Explain this change" from a point on a chart — MAIN PROCESS, PURE: no fs,
// no DuckDB, no model.
//
// A reader points at a spike on a time-series chart. This file turns that
// point into the drivers QUESTION (./driverScope DriversSpec): the measure the
// chart drew, the clicked date bucket against an earlier bucket OF THE SAME
// CHART, both inside the filters that drew it, narrowed to the clicked series
// when the chart is split. Nothing here reads data or computes a figure — the
// chart's own answer (its labels, how its axis was bucketed, its series names)
// comes in, a question or a refusal sentence goes out.
//
// The periods are the chart's, never derived by a browser: `bucketRange` reads
// each axis label back into the dates it covers, and "before" is decided by
// those dates, not by the order the labels arrived in.

import type { FilterStep } from '../data/transforms';
import type { VizEncoding, VizMeasure } from './visuals';
import type { CategoryInfo, DateGrain } from './categoryKey';
import { civilFromDays, daysFromCivil } from './categoryKey';
import { daysFromIso } from './dateIntel';
import { bucketRange, rangeLabel } from './driverScope';
import type { DriversSpec } from './driverScope';
import { formatNumber } from '../app/format';
import * as msg from './driverPointMessages';

/** What the reader pointed at. Absent `bucket` → the chart's latest period; absent `baseline` → the one before it. */
export interface PointInput {
  bucket?: string;
  series?: string;
  baseline?: string;
}

/** One bucket of the chart: its axis label (the key) and how it reads ("Mar 2026"). */
export interface PointPeriod {
  label: string;
  text: string;
}

export interface PointBaseline extends PointPeriod {
  kind: 'previous' | 'year' | 'earlier';
}

export type PointCode =
  | 'not_time_series' | 'unsupported' | 'no_periods' | 'unknown_bucket' | 'first_bucket' | 'unknown_baseline'
  | 'not_additive' | 'table_calc' | 'unknown_series' | 'as_of' | 'converted';

/** The chart's own answer, as `vizDataFor` gave it. */
export interface PointChart {
  category?: CategoryInfo;
  labels: ReadonlyArray<string | number>;
  series: ReadonlyArray<{ name: string }>;
}

export interface PointRefusal {
  ok: false;
  code: PointCode;
  error: string;
  /** Still sent with a refusal the reader can pick their way out of (the first bucket). */
  bucket?: string;
  periods?: PointPeriod[];
}

export type PointPlan =
  | { ok: true; spec: DriversSpec; bucket: string; baseline: string; periods: PointPeriod[]; baselines: PointBaseline[] }
  | PointRefusal;

export function refusePoint(code: PointCode, error: string, extra: { bucket?: string; periods?: PointPeriod[] } = {}): PointRefusal {
  return { ok: false, code, error, ...extra };
}

interface Bucket extends PointPeriod {
  from: number;
}

/** The chart's date buckets in TIME order (by the dates each label covers), duplicates and unreadable labels dropped. */
export function chartBuckets(labels: ReadonlyArray<string | number>, grain: DateGrain): Bucket[] {
  const seen = new Set<string>();
  const out: Bucket[] = [];
  for (const raw of labels) {
    const label = String(raw);
    if (seen.has(label)) continue;
    seen.add(label);
    const r = bucketRange(label, grain);
    const from = r ? daysFromIso(r.from) : null;
    if (r && from !== null) out.push({ label, text: rangeLabel(r) || label, from });
  }
  return out.sort((x, y) => x.from - y.from || (x.label < y.label ? -1 : x.label > y.label ? 1 : 0));
}

/** The same calendar day one year earlier (Feb 29 → Feb 28). */
function yearBefore(days: number): number {
  const c = civilFromDays(days);
  const d = c.m === 2 && c.d === 29 ? 28 : c.d;
  return daysFromCivil(c.y - 1, c.m, d);
}

/** The measure this point belongs to: the split's one measure, or the measure whose series was clicked. */
function measureAt(enc: VizEncoding, chart: PointChart, series: string | undefined): VizMeasure | null {
  const values = Array.isArray(enc.values) ? enc.values : [];
  if (enc.series || values.length <= 1 || series === undefined) return values[0] ?? null;
  const k = chart.series.findIndex((s) => s.name === series);
  return k >= 0 && k < values.length ? values[k] : null;
}

function measureName(aggregation: 'sum' | 'avg' | 'count', column: string): string {
  return aggregation === 'sum' ? msg.measureSum(column) : aggregation === 'avg' ? msg.measureAvg(column) : msg.measureCount(column);
}

/**
 * The drivers question a point on this chart asks, or the sentence that says
 * why there is none. `filters` are the chart's own, already sanitized and with
 * parameters resolved — both periods stay inside them.
 */
export function pointPlan(datasetId: string, enc: VizEncoding, chart: PointChart, filters: FilterStep[], input: PointInput): PointPlan {
  if (!enc || enc.geo || enc.pivot || enc.cohort || enc.eventFunnel || enc.facet || enc.drivers || enc.categoryDatasetId || enc.seriesDatasetId) {
    return refusePoint('unsupported', msg.pointUnsupported());
  }
  const grain = chart.category && chart.category.kind === 'date' ? chart.category.grain : undefined;
  if (!grain || typeof enc.category !== 'string' || !enc.category) return refusePoint('not_time_series', msg.pointNotTimeSeries());

  const buckets = chartBuckets(chart.labels, grain);
  if (!buckets.length) return refusePoint('no_periods', msg.pointNoPeriods());
  const periods: PointPeriod[] = buckets.map((b) => ({ label: b.label, text: b.text }));

  // The measure first: a chart that cannot be explained says so whichever point was clicked.
  const split = typeof enc.series === 'string' && enc.series.length > 0;
  const m = measureAt(enc, chart, input.series);
  if (!m) return refusePoint('unknown_series', msg.pointUnknownSeries(), { periods });
  if (m.datasetId) return refusePoint('unsupported', msg.pointUnsupported());
  if (m.calc) return refusePoint('table_calc', msg.pointTableCalc());
  // A grouped chart SUMS a `none` measure (vizData.buildAggregated), so that is what is explained.
  const aggregation = m.aggregation === 'none' ? 'sum' : m.aggregation;
  if (aggregation === 'min' || aggregation === 'max') return refusePoint('not_additive', msg.pointNotAdditive());

  const bucket = input.bucket === undefined ? buckets[buckets.length - 1].label : input.bucket;
  const at = buckets.findIndex((b) => b.label === bucket);
  if (at < 0) return refusePoint('unknown_bucket', msg.pointUnknownBucket(), { periods });
  if (at === 0) return refusePoint('first_bucket', msg.pointFirstBucket(buckets[0].text), { bucket, periods });

  const lastYear = yearBefore(buckets[at].from);
  const baselines: PointBaseline[] = [];
  for (let i = at - 1; i >= 0; i -= 1) {
    const b = buckets[i];
    if (i === at - 1) baselines.push({ label: b.label, text: msg.baselinePrevious(b.text), kind: 'previous' });
    else if (b.from === lastYear) baselines.push({ label: b.label, text: msg.baselineLastYear(b.text), kind: 'year' });
    else baselines.push({ label: b.label, text: b.text, kind: 'earlier' });
  }
  const baseline = input.baseline === undefined ? baselines[0].label : input.baseline;
  if (!baselines.some((b) => b.label === baseline)) return refusePoint('unknown_baseline', msg.pointUnknownBaseline(), { bucket, periods });

  const spec: DriversSpec = {
    datasetId,
    metric: { column: m.column, aggregation, label: measureName(aggregation, m.column) },
    filters,
    compare: { mode: 'bucket', column: enc.category, label: bucket, prev: baseline, grain },
    // The clicked series is a drill step: both periods narrow to it, and it stops being a dimension.
    path: split && input.series !== undefined ? [{ column: enc.series as string, value: input.series }] : [],
  };
  return { ok: true, spec, bucket, baseline, periods, baselines };
}

// ── The header sentence ──────────────────────────────────────────────────────

export interface ChangeFigures {
  metric: string;
  /** a − b, as the engine computed it. */
  delta: number;
  /** delta / |b| × 100 as the engine computed it, or null when there is none to give. */
  pct: number | null;
  /** |delta| as the metric formats it ("$412K", "1.2 pts"). */
  changeText: string;
  period: string;
  baseline: string;
  /** The baseline's figure and the period's, formatted. */
  from: string;
  to: string;
  /** A one-day bucket reads "on Mar 3, 2026". */
  day: boolean;
}

/** "Revenue fell 18% in Mar 2026 vs Feb 2026 (from $1.2M to $984K)" — figures in, words out; nothing is computed. */
export function changeSentence(c: ChangeFigures): string {
  if (c.delta === 0) return (c.day ? msg.changeFlatDay : msg.changeFlat)(c.metric, c.period, c.baseline, c.to);
  const fell = c.delta < 0;
  const a = c.pct === null || !Number.isFinite(c.pct) ? 0 : Math.abs(c.pct);
  const pct = formatNumber(a, { maxDecimals: a < 10 ? 1 : 0 });
  // A percentage that rounds to nothing says less than the change itself.
  if (c.pct === null || !Number.isFinite(c.pct) || pct === formatNumber(0)) {
    const by = fell ? (c.day ? msg.changeFellByDay : msg.changeFellBy) : (c.day ? msg.changeRoseByDay : msg.changeRoseBy);
    return by(c.metric, c.changeText, c.period, c.baseline, c.from, c.to);
  }
  const say = fell ? (c.day ? msg.changeFellDay : msg.changeFell) : (c.day ? msg.changeRoseDay : msg.changeRose);
  return say(c.metric, pct, c.period, c.baseline, c.from, c.to);
}
