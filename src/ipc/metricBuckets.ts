// One figure per date bucket (semantic layer part 5, step 06, D10's third bullet) — MAIN PROCESS. A period metric on
// a date axis, its sparkline, a funnel metric by entry date (step 08) and a target series (step 10) are each one
// resolution per bucket, so each point IS that bucket's tile: "Revenue YTD" at March is the tile scoped to March.
//
// The axis is asked of the chart door once (its grain, its auto grain, its week-calendar labels, a Live warehouse or
// a typed refusal: whatever the door does), the gaps between its first and last bucket are filled
// (analysis/periodBuckets), and each bucket's scope is the caller's with its range on the date replaced by the
// bucket's days cut to the range in scope. At most SERIES_MAX_POINTS buckets, at most 4 resolutions at a time.

import type { DateGrain } from '../analysis/categoryKey';
import { bucketRange, fillBuckets } from '../analysis/periodBuckets';
import { scopeRange, withRange } from '../analysis/periodScope';
import type { ParamValues } from '../analysis/params';
import * as msg from '../analysis/metricCheckMessages';
import type { FilterStep } from '../data/transforms';
import { vizDataFor } from './visuals';
import type { VizDataReply } from './visuals';

/** A sparkline's cap, and a period chart's (ipc/metrics SERIES_MAX_POINTS). */
const MAX_BUCKETS = 24;
const AT_ONCE = 4;

export interface BucketSeries { ok: true; labels: string[]; values: (number | null)[]; grain: DateGrain }
/** The door's refusal of the axis (typed: Live, row access, a term), or too many buckets. */
export type BucketRefusal = Extract<VizDataReply, { ok: false }>;

const later = (a: string, b: string | undefined): string => (b && b > a ? b : a);
const sooner = (a: string, b: string | undefined): string => (b && b < a ? b : a);

/** Each job's result, in order, with at most `n` running at once. */
async function pooled<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array<T>(jobs.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, lane));
  return out;
}

/**
 * `figure` once per bucket of `dateColumn` at `grain` (undefined: the door's own) under `filters`. `name` is the
 * measure a refusal names; `last` keeps only the latest buckets (a sparkline), before the cap is checked; `tooMany` says the cap
 * in the caller's words (a period metric's, by default).
 */
export async function bucketSeries(
  projectId: string,
  datasetId: string,
  dateColumn: string,
  grain: DateGrain | undefined,
  filters: FilterStep[],
  figure: (bucketScope: FilterStep[], label: string) => Promise<number | null>,
  opts: { params?: ParamValues; name: string; last?: number; tooMany?: (grain: DateGrain, n: number) => string },
): Promise<BucketSeries | BucketRefusal> {
  const axis = await vizDataFor(projectId, datasetId, { category: dateColumn, ...(grain ? { grain } : {}), values: [{ column: dateColumn, aggregation: 'count' }] }, filters, { params: opts.params });
  if (!axis.ok) return axis;
  const g: DateGrain = axis.category?.grain ?? grain ?? 'month';
  let labels = fillBuckets(axis.data.labels.map(String), g);
  if (opts.last) labels = labels.slice(-opts.last);
  if (labels.length > MAX_BUCKETS) return { ok: false, error: opts.tooMany?.(g, labels.length) ?? msg.periodTooManyBuckets(opts.name, g, labels.length) };
  const types = new Map([[dateColumn, 'date']]);
  const scope = scopeRange(filters, [{ name: dateColumn, type: 'date' }])?.range ?? {};
  const values = await pooled(labels.map((label) => () => {
    const b = bucketRange(label, g)!;
    return figure(withRange(filters, dateColumn, { from: later(b.from, scope.from), to: sooner(b.to, scope.to) }, types), label);
  }), AT_ONCE);
  return { ok: true, labels, values, grain: g };
}
