// A snapshot metric's figures (semantic layer D8), composed from the doors that already exist — MAIN PROCESS.
//
// A stock count, a balance or a headcount is the value on the latest (or earliest) day in scope, not a sum over
// every day. No new SQL: the day is a day-grain chart of the snapshot column through the chart door, and the figure
// is the ordinary question restricted to that day by a `period` filter. So the resident paths, the JS fallbacks,
// joins, LOD, parameters, fx, row locks and the answer caches all apply unchanged, and analysis/snapshot.snapshotRows
// is the row-level reference both are held equal to (scripts/test-snapshot.ts, Object.is).

import type { MetricAggregation } from '../analysis/metricValue';
import type { MetricSnapshot } from '../analysis/snapshot';
import { latestDay, onDay, pickPerBucket } from '../analysis/snapshot';
import type { VizEncoding } from '../analysis/visuals';
import type { ParamValues } from '../analysis/params';
import type { FxInfo } from '../analysis/fx';
import type { FilterStep } from '../data/transforms';
import type { AsOf } from '../api/asOf';
import { vizDataFor } from './visuals';
import type { VizDataReply } from './visuals';
import { isCountLike } from '../data/aggregations';
import { perEntityCardMetric, perEntityChart } from './snapshotPer';
import type { PerAt } from './snapshotPer';

type Figure = { ok: boolean; value: number | null; fx?: FxInfo; asOf?: AsOf; notes?: string[] };

/**
 * A snapshot KPI: the figure `figure` gives over the rows on the latest (or earliest) day of `snapshot.column` under
 * `filters`. No day in scope: `count` is 0 and every other aggregation has no value, as over no rows. A snapshot
 * column that is gone, or no longer a date, gives no figure at all.
 * `figure` is the KPI door's own body (./dashboards), passed in so this file does not import it back.
 * Per entity (part 5, D11): each entity's own day, its own path (./snapshotPer).
 *
 * shortcut: the day is read as a date axis reads it, the rows by the period filter; a timestamp with an offset can
 * disagree (scorecards.ts:158 has the same seam) — give `period` the axis's parser to close it.
 */
export async function snapshotCardMetric(
  projectId: string,
  datasetId: string,
  spec: { column: string; aggregation: MetricAggregation; snapshot: MetricSnapshot },
  filters: FilterStep[],
  params: ParamValues | undefined,
  figure: (spec: { column: string; aggregation: MetricAggregation }, filters: FilterStep[]) => Promise<Figure>,
): Promise<Figure> {
  const snap = spec.snapshot;
  if (snap.per) return perEntityCardMetric(projectId, datasetId, { ...spec, snapshot: { ...snap, per: snap.per } }, filters, params);
  const days = await vizDataFor(projectId, datasetId, { category: snap.column, grain: 'day', values: [{ column: snap.column, aggregation: 'count' }] }, filters, { params });
  if (!days.ok) return { ok: false, value: null };
  if (days.category?.kind !== 'date') return { ok: true, value: null }; // the column is gone or no longer a date: no figure, never a count of 0
  const day = latestDay(days.data.labels, snap.take);
  if (day === null) return { ok: true, value: isCountLike(spec.aggregation) ? 0 : null }; // no rows: a count is 0
  return figure({ column: spec.column, aggregation: spec.aggregation }, filters.concat([onDay(snap.column, day)]));
}

/**
 * A chart's snapshot leaves (./vizMetricMeasures), asked through `ask` (the chart door).
 *
 * By the snapshot's own date: the chart at day grain, then each bucket's latest (or earliest) day — a series with no
 * row on that day is null there, never its older value. The grain is the plain chart's (an auto grain is chosen from
 * the same rows first). By anything else: the latest day over the whole scope, then the chart on that day — so a
 * region with no row on it has no bar (D8: never per category). Per entity (part 5, D11): each entity's own day, per
 * bucket by the snapshot's own date, asked at `at` (./snapshotPer).
 */
export async function snapshotAnswer(snap: MetricSnapshot, enc: VizEncoding, filters: FilterStep[], ask: (e: VizEncoding, f: FilterStep[]) => Promise<VizDataReply>, at: PerAt): Promise<VizDataReply> {
  const per = (e: VizEncoding) => perEntityChart(at.projectId, at.datasetId, { ...snap, per: snap.per! }, e, filters, at.opts);
  if (enc.category === snap.column) {
    let grain = enc.grain;
    if (!grain) {
      const axis = await ask({ ...enc, values: [{ column: enc.category, aggregation: 'count' }] }, filters);
      if (!axis.ok) return axis;
      grain = axis.category?.grain;
    }
    if (snap.per) return per(grain ? { ...enc, grain } : enc);
    const day = await ask({ ...enc, grain: 'day' }, filters);
    if (!day.ok) return day;
    if (!grain) return { ...day, data: { ...day.data, labels: [], series: [] } }; // no date axis (the column is no longer a date): no figure
    return { ...day, data: pickPerBucket(day.data, grain, snap.take), category: { kind: 'date', grain } };
  }
  if (snap.per) return per(enc);
  const days = await ask({ category: snap.column, grain: 'day', values: [{ column: snap.column, aggregation: 'count' }] }, filters);
  if (!days.ok) return days;
  const day = days.category?.kind === 'date' ? latestDay(days.data.labels, snap.take) : null;
  if (day === null) return { ok: true, data: { labels: [], series: [] }, recommendedShape: days.recommendedShape, warnings: days.warnings };
  return ask(enc, filters.concat([onDay(snap.column, day)]));
}
