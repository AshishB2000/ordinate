// Where a reader of a saved metric refuses a snapshot one (semantic layer part 1, PR 02a) until a later release
// computes snapshots. Its own file because ./snapshot is imported BY ./metrics and so cannot import it back.

import * as metrics from './metrics';
import * as msg from './metricCheckMessages';
import type { VizEncoding } from './visuals';

/**
 * The sentence refusing a chart whose measure IS a saved snapshot metric, or null.
 *
 * A chart stores the metric's `{column, aggregation}` beside its `metricId`, so without this a simple snapshot
 * metric would be drawn as the plain total over every date. A formula measure is planned elsewhere
 * (./metricMeasures); a pivot's values carry `metricId` too and are read here. With a split only the first measure
 * is drawn (vizData.buildPivot), so only it is checked. A chart with no `metricId` reads nothing.
 */
export async function snapshotMeasureRefusal(projectId: string, encoding: VizEncoding | null | undefined): Promise<string | null> {
  if (!encoding || encoding.cohort || encoding.eventFunnel || encoding.drivers) return null;
  const all = encoding.pivot ? encoding.pivot.values : encoding.values;
  const measures = Array.isArray(all) ? (encoding.series && !encoding.pivot ? all.slice(0, 1) : all) : [];
  for (const v of measures) {
    const m = v && typeof v.metricId === 'string' ? await metrics.getMetric(projectId, v.metricId) : null;
    if (m && !metrics.isFormulaDefinition(m.definition) && m.definition.snapshot) return msg.measureSnapshotPending(m.name);
  }
  return null;
}
