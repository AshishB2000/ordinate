// What a published KPI tile says it measures, under its figure (docs/chart-figures).
//
// Never more than an aggregation and a measure column, in the org's language
// (./publishMessages). A saved metric's description carries its filters' and
// its formula's literals — `email = ana@acme.test` — and a published page, a
// public link, an HTML export and a signed embed reach readers no Share policy
// shapes words for. So a formula metric says nothing here, and neither does a
// measure column the Share policy marks (withheldColumns: masked or not) on the
// table the KPI totals it on — a forward join's or a many side's, not only the card's.

import * as metrics from '../analysis/metrics';
import * as datasets from '../data/datasets';
import { withheldColumns } from '../app/sharePolicy';
import { bareColumnTable } from '../analysis/fanOutPlan';
import { projectModel } from '../ipc/relationships';
import { kpiMeasure } from './publishMessages';

/** The table a KPI's bare column is on, as its door reads it (ipc/metricFanOut): its own, a forward join's, its one many side's; null when two many sides have it. */
export async function tableOf(projectId: string, datasetId: string, column: string): Promise<string | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta || meta.columns.some((c) => c.name === column)) return datasetId;
  const { rels, infos } = await projectModel(projectId, datasetId);
  return bareColumnTable(datasetId, column, rels, infos);
}

/**
 * "Sum of revenue", or '' — for the card's own column, or, when the figure came
 * from its saved metric (`viaMetric`), that metric's. Left out when it only
 * repeats the tile's title.
 */
export async function kpiSubtitle(
  projectId: string,
  card: { metricId?: string; datasetId: string; column: string; aggregation: string },
  title: string,
  viaMetric: boolean,
): Promise<string> {
  let { datasetId, column, aggregation } = card;
  if (viaMetric && card.metricId) {
    const metric = await metrics.getMetric(projectId, card.metricId);
    if (!metric || !metrics.isSimpleDefinition(metric.definition)) return '';
    datasetId = metric.datasetId;
    ({ column, aggregation } = metric.definition);
  }
  const table = column ? await tableOf(projectId, datasetId, column) : null;
  if (!table || (await withheldColumns(projectId, table)).has(column)) return '';
  const sub = kpiMeasure(aggregation, column);
  return sub.toLowerCase() === title.trim().toLowerCase() ? '' : sub;
}
