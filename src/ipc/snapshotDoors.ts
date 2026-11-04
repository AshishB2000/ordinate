// A snapshot metric's figures (semantic layer D8), composed from the doors that already exist — MAIN PROCESS.
//
// A stock count, a balance or a headcount is the value on the latest (or earliest) day in scope, not a sum over
// every day. No new SQL: the day is a day-grain chart of the snapshot column through the chart door, and the figure
// is the ordinary question restricted to that day by a `period` filter. So the resident paths, the JS fallbacks,
// joins, LOD, parameters, fx, row locks and the answer caches all apply unchanged, and analysis/snapshot.snapshotRows
// is the row-level reference both are held equal to (scripts/test-snapshot.ts, Object.is).

import type { MetricAggregation } from '../analysis/metricValue';
import type { MetricSnapshot } from '../analysis/snapshot';
import { latestDay, onDay } from '../analysis/snapshot';
import type { ParamValues } from '../analysis/params';
import type { FxInfo } from '../analysis/fx';
import type { FilterStep } from '../data/transforms';
import type { AsOf } from '../api/asOf';
import { vizDataFor } from './visuals';

type Figure = { ok: boolean; value: number | null; fx?: FxInfo; asOf?: AsOf };

/**
 * A snapshot KPI: the figure `figure` gives over the rows on the latest (or earliest) day of `snapshot.column` under
 * `filters`. No day in scope: `count` is 0 and every other aggregation has no value, as over no rows. A snapshot
 * column that is gone, or no longer a date, gives no figure at all.
 * `figure` is the KPI door's own body (./dashboards), passed in so this file does not import it back.
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
  const days = await vizDataFor(projectId, datasetId, { category: snap.column, grain: 'day', values: [{ column: snap.column, aggregation: 'count' }] }, filters, { params });
  if (!days.ok) return { ok: false, value: null };
  if (days.category?.kind !== 'date') return { ok: true, value: null }; // the column is gone or no longer a date: no figure, never a count of 0
  const day = latestDay(days.data.labels, snap.take);
  if (day === null) return { ok: true, value: spec.aggregation === 'count' ? 0 : null };
  return figure({ column: spec.column, aggregation: spec.aggregation }, filters.concat([onDay(snap.column, day)]));
}
