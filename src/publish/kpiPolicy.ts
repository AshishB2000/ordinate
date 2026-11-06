// A KPI-like figure under the Share policy — MAIN PROCESS.
//
// A KPI's figure is a total of columns, as a chart's measure is, so it leaves the way that chart does: through
// app/sharePolicy applyToChart — a page's Outgoing hook (./publish policyOutgoing) or a share path directly (a
// report, a send) — each column judged on the table that owns it: the card's own, the related one a forward
// join reads it from, or the one many side a fan-out KPI totals it on (./kpiSubtitle tableOf, as the KPI door
// reads it). Drop hides the figure with the house wording; under mask it passes, as every aggregate does;
// include passes. Dashboard KPIs, story metrics, scorecard rows and metric trees all leave through here.

import { applyToChart } from '../app/sharePolicy';
import type { SharePath } from '../app/privacyStore';
import type { MetricRead } from '../ipc/metrics';
import { tableOf } from './kpiSubtitle';
import type { Outgoing } from './dashboardData';

/**
 * What the figure says instead of itself, or '' when the policy lets it out. `reads`: every column it was
 * totalled from (resolveMetric's `reads`). `via`: a page's Outgoing hook, or the share path the figure leaves by.
 */
export async function kpiHidden(projectId: string, reads: MetricRead[], via?: Outgoing | SharePath): Promise<string> {
  if (!via || !reads.length) return '';
  const values = await Promise.all(reads.map(async (r) => ({ column: r.column, aggregation: r.aggregation, datasetId: (await tableOf(projectId, r.datasetId, r.column)) ?? r.datasetId })));
  const encoding = { category: '', values };
  const data = { labels: [], series: [] };
  if (typeof via === 'string') {
    const r = await applyToChart(projectId, reads[0].datasetId, encoding, { ok: true, data }, via);
    return r.ok ? '' : r.error;
  }
  const shaped = await via(reads[0].datasetId, encoding, data);
  return 'hidden' in shaped ? shaped.hidden : '';
}
