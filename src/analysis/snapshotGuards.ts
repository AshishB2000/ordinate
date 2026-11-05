// The snapshot checks that read records (semantic layer part 1): the save check, and the answer door's refusal (an
// answer card draws a measure's stored column, so it cannot show a snapshot yet; charts and KPIs compute one since
// step 07, ./snapshotDoors). Its own file because ./snapshot is imported BY ./metrics and so cannot import it back.
// (A metric's own date under a dashboard date control, refused here in release 1, is counted since PR 04.)

import * as metrics from './metrics';
import type { Metric } from './metrics';
import * as msg from './metricCheckMessages';
import { sanitizeSnapshot } from './snapshot';
import { ExternalMetricError } from './externalMetric';
import * as datasets from '../data/datasets';
import type { VizEncoding } from './visuals';

/** The saved metric `metricId` names when it is a SIMPLE snapshot one (its stored column and total are not its figure), else null. */
export async function snapshotMetric(projectId: string, metricId: unknown): Promise<Metric | null> {
  const m = typeof metricId === 'string' ? await metrics.getMetric(projectId, metricId) : null;
  return m && metrics.isSimpleDefinition(m.definition) && m.definition.snapshot ? m : null;
}

/**
 * The sentence refusing an answer card whose measure IS a saved snapshot metric, or null (ipc/answers).
 *
 * A measure stores the metric's `{column, aggregation}` beside its `metricId`, and the answer door draws that copy,
 * so without this a simple snapshot metric would be drawn as the plain total over every date. With a split only the
 * first measure is drawn (vizData.buildPivot), so only it is checked. A measure with no `metricId` reads nothing.
 */
export async function snapshotMeasureRefusal(projectId: string, encoding: VizEncoding | null | undefined): Promise<string | null> {
  for (const v of snapshotDrawn(encoding)) {
    const m = typeof v?.metricId === 'string' ? await metrics.getMetric(projectId, v.metricId) : null;
    if (!m) continue;
    if (metrics.isExternalDefinition(m.definition)) return new ExternalMetricError('pending', m.name).message; // nor a layer's metric (b0): raised, so the route types it
    if (metrics.isSimpleDefinition(m.definition) && m.definition.snapshot) return msg.snapshotInAnswer(m.name);
  }
  return null;
}

/** The measures a chart draws, for the guards here (not metricMeasures.drawnMeasures, which leaves a pivot to its copy): a pivot's values, else its values (only the first under a split, as vizData.buildPivot); none for the grids beside it. */
export function snapshotDrawn(encoding: VizEncoding | null | undefined): VizEncoding['values'] {
  if (!encoding || encoding.cohort || encoding.eventFunnel || encoding.drivers) return [];
  const all = encoding.pivot ? encoding.pivot.values : encoding.values;
  return Array.isArray(all) ? (encoding.series && !encoding.pivot ? all.slice(0, 1) : all) : [];
}

/** The sentence refusing a definition whose snapshot names no date column of `datasetId`, or null (none, a date, or no dataset). */
export async function snapshotProblem(projectId: string, datasetId: string, def: unknown): Promise<string | null> {
  const snap = sanitizeSnapshot(def && typeof def === 'object' ? (def as { snapshot?: unknown }).snapshot : undefined);
  if (!snap) return null;
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  return !meta || meta.columns.some((c) => c.name === snap.column && c.type === 'date') ? null : msg.snapshotNotDate(snap.column);
}
