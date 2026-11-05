// A KPI tile under the Share policy — MAIN PROCESS.
//
// A KPI's figure is a total of columns, as a chart's measure is, so it leaves the way that chart does: through
// the page's Outgoing hook (./publish policyOutgoing → app/sharePolicy applyToChart), each column judged on the
// table that owns it — the card's own, or the related one a forward join reads it from. Drop hides the tile with
// the house wording; under mask the figure passes, as every aggregate does; include passes.

import type { MetricRead } from '../ipc/metrics';
import { metricColumnOwner } from '../ipc/relationships';
import type { Outgoing } from './dashboardData';

/** What the tile says instead of its figure, or '' when the policy lets the figure out. `reads`: every column it was totalled from. */
export async function kpiHidden(projectId: string, datasetId: string, reads: MetricRead[], outgoing?: Outgoing): Promise<string> {
  if (!outgoing || !reads.length) return '';
  const values = await Promise.all(reads.map(async (r) => ({ column: r.column, aggregation: r.aggregation, datasetId: await metricColumnOwner(projectId, r.datasetId, r.column) })));
  const shaped = await outgoing(datasetId, { category: '', values }, { labels: [], series: [] });
  return 'hidden' in shaped ? shaped.hidden : '';
}
