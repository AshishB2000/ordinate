// The doors a Live dataset leaves through (docs/live-data/00-plan.md L2.4, §4)
// — MAIN PROCESS ONLY.
//
// Three functions draw every figure the app shows, and each asks `liveMetaOf`
// FIRST — before the extract's answer cache, which would pin a figure past the
// dataset's cache age and hide `stale` (the executor caches by its own rules):
//
//   ./visuals    vizDataFor         charts: visual:data / dataBatch / preview /
//                                   thumbs, dashboard tiles, publish, export,
//                                   stories, scorecards, copilot facts
//   ./dashboards computeCardMetric  KPI tiles: dashboard:metric, metric:value(s),
//                                   compare deltas, alerts, the Summary card
//   ./answers    computeCard        AI answers, Explain, follow-up chips
//                                   (./liveAnswers)
//
// A Live dataset goes to the executor (src/engine/live/liveQuery.ts) and
// `datasets.getDataset` is never called on its way (scripts/test-liveRoute.ts
// spies on it). The figure keeps the WAREHOUSE's time (`asOf.mode: 'live'`),
// which data/figureAsOf.stampAsOf leaves as it came.
//
// What the IR does not carry is refused HERE, typed, before the adapter — never
// answered without it:
//   - an "as of" read: the warehouse answers now, and a Live dataset keeps no
//     snapshots to read the past from;
//   - currency conversion (./fxQuery): the warehouse would sum unconverted amounts;
//   - a column or filter reached through a relationship: joins are L4.
// LOD and parameter replay cannot arise — both live in prepare steps, and a
// Live dataset has none — and pivots, cohorts, funnels, drivers, maps, facets
// and raw points are the adapter's own refusals (engine/live/liveSpec.ts).

import * as datasets from '../data/datasets';
import type { DatasetMeta } from '../data/datasets';
import { isLive } from '../data/liveDataset';
import { asOfIso } from '../data/asOf';
import type { FilterStep } from '../data/transforms';
import type { VizEncoding } from '../analysis/visuals';
import type { MetricAggregation } from '../analysis/metricValue';
import type { AsOf } from '../api/asOf';
import { liveMetric, liveVizData } from '../engine/live/liveQuery';
import type { LiveFailure } from '../engine/live/liveQuery';
import { refuse } from '../engine/live/liveSpec';
import { LiveFigureError } from '../engine/live/liveFigureError';
import * as msg from '../engine/liveQueryMessages';
import { relatedColumnNames } from './relationships';
import { fxContext, fxVizContext } from './fxQuery';
import type { VizDataReply } from './visuals';

/** The dataset's metadata when it is Live, else null — one metadata read, no rows. */
export async function liveMetaOf(projectId: string, datasetId: string): Promise<DatasetMeta | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  return meta && isLive(meta) ? meta : null;
}

// A KPI the warehouse could not give is THROWN (engine/live/liveFigureError):
// every caller of `computeCardMetric` reads `ok: false` as "the dataset is
// gone". Re-exported here, beside the doors that throw it.
export { LiveFigureError, isLiveFigureError, liveCodeOf } from '../engine/live/liveFigureError';

function refusal(error: string, reason: LiveFailure['reason']): LiveFailure {
  return { ok: false, code: 'live_refused', error, reason };
}

/**
 * Why this question cannot go to the warehouse at all, or null. `names` are the
 * columns it reads (the extract's join path resolves any the dataset lacks
 * through a relationship); `converted` whether ./fxQuery would convert it.
 */
async function preRefusal(projectId: string, meta: DatasetMeta, names: string[], converted: () => Promise<boolean>): Promise<LiveFailure | null> {
  if (asOfIso()) return refusal(msg.liveAsOfRefused(), 'asOf');
  const own = new Set(meta.columns.map((c) => c.name));
  // A column the warehouse dropped (L2.5) is not "foreign": the executor refuses it `columnMissing`.
  const gone = new Set(meta.live?.missingColumns ?? []);
  const foreign = names.filter((n) => typeof n === 'string' && n !== '' && !own.has(n) && !gone.has(n));
  if (foreign.length) {
    const related = new Set(await relatedColumnNames(projectId, meta.id));
    if (foreign.some((n) => related.has(n))) {
      const r = refuse('related');
      return refusal(r.message, r.code);
    }
  }
  if (await converted()) return refusal(msg.liveFxRefused(), 'fx');
  return null;
}

/** `vizDataFor`'s question on a Live dataset: the chart, dated by the warehouse — or a typed failure, never an empty chart. */
export async function liveChart(projectId: string, meta: DatasetMeta, encoding: VizEncoding, filters: FilterStep[]): Promise<VizDataReply> {
  const enc = encoding || ({} as VizEncoding);
  const names = [enc.category, enc.series, ...(enc.values || []).map((v) => v && v.column), ...(filters || []).map((f) => f && f.column)];
  const pre = await preRefusal(projectId, meta, names.filter((n): n is string => typeof n === 'string'),
    async () => !!(await fxVizContext(projectId, meta.id, encoding, filters)));
  if (pre) return pre;
  const r = await liveVizData(projectId, meta.id, encoding, filters);
  if (!r.ok) return r;
  return { ok: true, data: r.data, recommendedShape: r.recommendedShape, warnings: r.warnings, category: r.category, asOf: r.asOf };
}

/** `computeCardMetric`'s number on a Live dataset, dated. Throws `LiveFigureError` when there is none to give. */
export async function liveCardMetric(
  projectId: string,
  meta: DatasetMeta,
  spec: { column: string; aggregation: MetricAggregation },
  filters: FilterStep[],
): Promise<{ ok: true; value: number | null; asOf: AsOf }> {
  const touched = [spec.column, ...(filters || []).map((f) => f && f.column)].filter((n): n is string => typeof n === 'string');
  const pre = await preRefusal(projectId, meta, touched,
    async () => spec.aggregation !== 'count' && !!(await fxContext(projectId, meta.id, [spec.column], touched)));
  if (pre) throw new LiveFigureError(pre);
  const r = await liveMetric(projectId, meta.id, spec, filters);
  if (!r.ok) throw new LiveFigureError(r);
  return { ok: true, value: r.value, asOf: r.asOf };
}
