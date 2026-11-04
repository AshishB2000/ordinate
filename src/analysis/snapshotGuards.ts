// Where a chart of a saved metric refuses what only a later release computes (semantic layer part 1): a snapshot
// metric (PR 02a). Its own file because ./snapshot is imported BY ./metrics and so cannot import it back. (A metric's
// own date under a dashboard date control, refused here in release 1, is counted since PR 04: ./metricTimeScope.)

import * as metrics from './metrics';
import type { Metric } from './metrics';
import * as msg from './metricCheckMessages';
import type { VizEncoding } from './visuals';

/** The saved metric `metricId` names when it is a SIMPLE snapshot one (its stored column and total are not its figure), else null. */
export async function snapshotMetric(projectId: string, metricId: unknown): Promise<Metric | null> {
  const m = typeof metricId === 'string' ? await metrics.getMetric(projectId, metricId) : null;
  return m && !metrics.isFormulaDefinition(m.definition) && m.definition.snapshot ? m : null;
}

/**
 * The sentence refusing a chart whose measure IS a saved snapshot metric, or null.
 *
 * A chart stores the metric's `{column, aggregation}` beside its `metricId`, so without this a simple snapshot
 * metric would be drawn as the plain total over every date. A formula measure is planned elsewhere
 * (./metricMeasures); a pivot's values carry `metricId` too and are read here. With a split only the first measure
 * is drawn (vizData.buildPivot), so only it is checked. A chart with no `metricId` reads nothing.
 */
export async function snapshotMeasureRefusal(projectId: string, encoding: VizEncoding | null | undefined): Promise<string | null> {
  for (const v of snapshotDrawn(encoding)) {
    const m = await snapshotMetric(projectId, v?.metricId);
    if (m) return msg.measureSnapshotPending(m.name);
  }
  return null;
}

/** The measures a chart draws, for the guards here (not metricMeasures.drawnMeasures, which leaves a pivot to its copy): a pivot's values, else its values (only the first under a split, as vizData.buildPivot); none for the grids beside it. */
function snapshotDrawn(encoding: VizEncoding | null | undefined): VizEncoding['values'] {
  if (!encoding || encoding.cohort || encoding.eventFunnel || encoding.drivers) return [];
  const all = encoding.pivot ? encoding.pivot.values : encoding.values;
  return Array.isArray(all) ? (encoding.series && !encoding.pivot ? all.slice(0, 1) : all) : [];
}
