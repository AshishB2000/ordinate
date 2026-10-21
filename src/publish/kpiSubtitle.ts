// What a published KPI tile says it measures, under its figure (docs/chart-figures).
//
// Never more than an aggregation and a measure column, in the org's language
// (./publishMessages). A saved metric's description carries its filters' and
// its formula's literals — `email = ana@acme.test` — and a published page, a
// public link, an HTML export and a signed embed reach readers no Share policy
// shapes words for. So a formula metric says nothing here, and neither does a
// measure column the Share policy marks (withheldColumns: masked or not).

import * as metrics from '../analysis/metrics';
import { isFormulaDefinition } from '../analysis/metrics';
import { withheldColumns } from '../app/sharePolicy';
import { kpiMeasure } from './publishMessages';

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
    if (!metric || isFormulaDefinition(metric.definition)) return '';
    datasetId = metric.datasetId;
    ({ column, aggregation } = metric.definition);
  }
  if (!column || (await withheldColumns(projectId, datasetId)).has(column)) return '';
  const sub = kpiMeasure(aggregation, column);
  return sub.toLowerCase() === title.trim().toLowerCase() ? '' : sub;
}
