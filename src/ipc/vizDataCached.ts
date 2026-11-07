// `vizDataFor`'s body behind the doors (./rowDoors, ./columnDoors): a saved metric measure through the door
// again, the Live split, many-side measures (./vizFanOut), then the answer cache over `computeVizData` — MAIN PROCESS. Moved out of
// ./visuals.ts (its size cap) unchanged. The circular import with ./visuals is resolved at call time.

import * as answerKey from '../data/answerKey';
import * as queryCache from '../engine/queryCache';
import { ensureFresh } from '../data/freshOnAsk';
import { planMetricMeasures } from '../analysis/metricMeasures';
import type { VizEncoding } from '../analysis/visuals';
import type { FilterStep } from '../data/transforms';
import { followMetricMeasures } from './vizMetricMeasures';
import { liveChart, liveMetaOf } from './liveRoute';
import { fanOutVizData } from './vizFanOut';
import { fxVizContext } from './fxQuery';
import { computeVizData, vizDataFor, type VizDataReply, type VizOpts } from './visuals';

export async function vizDataForUnlocked(
  projectId: string,
  datasetId: string,
  encoding: VizEncoding,
  filters: FilterStep[],
  opts: VizOpts,
): Promise<VizDataReply> {
  // A measure that IS a saved metric is drawn as the metric defines it now, through this door again (./vizMetricMeasures); a snapshot pivot and part 5's shapes refuse.
  const planned = await planMetricMeasures(projectId, datasetId, encoding, opts.params);
  if (planned) return planned.ok ? followMetricMeasures(planned, encoding, filters, (e, f) => vizDataFor(projectId, datasetId, e, f, opts)) : planned;
  // A Live dataset is asked of its warehouse (L2.4, ./liveRoute) — before the cache below, which would outlive its cache age.
  const live = await liveMetaOf(projectId, datasetId);
  if (live) return liveChart(projectId, live, encoding, filters);
  const fanned = await fanOutVizData(projectId, datasetId, encoding, filters, (d, e, f) => vizDataFor(projectId, d, e, f, opts)); if (fanned) return fanned; // many-side measures: one question per table (./vizFanOut), before the answer cache
  await ensureFresh(projectId, [datasetId]); // L3.1 fresh on ask: before the cache key reads the record
  // The answer cache (engine/queryCache): a dashboard re-open, a type switch in
  // the builder or a tab coming back asks the same question over unchanged
  // data. Only successful answers are kept; an error is recomputed every time.
  const parts = await answerKey.keyParts(projectId, datasetId);
  if (!parts) return computeVizData(projectId, datasetId, encoding, filters, opts);
  const op = encoding && encoding.pivot ? 'pivot' : 'aggregate';
  const fxc = await fxVizContext(projectId, datasetId, encoding, filters);
  const key = queryCache.cacheKey(op, parts, {
    encoding, filters, params: opts.params ?? null, max: opts.maxHydrateRows ?? null, sample: opts.sample === true,
    ...answerKey.ambient(), fx: fxc ? fxc.key : undefined,
  });
  return queryCache.through(op, key, [datasetId, queryCache.projectDep(projectId)],
    () => computeVizData(projectId, datasetId, encoding, filters, opts), (r) => r.ok);
}
