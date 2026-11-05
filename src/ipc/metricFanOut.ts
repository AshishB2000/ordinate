// A KPI whose measure lives on a MANY side of its dataset's relationships, answered THROUGH the one KPI door —
// MAIN PROCESS (semantic layer part 8, D12 and D14).
//
// "Sum of amount" on Customers, where only Orders has `amount`, cannot join Orders in (every customer would
// repeat per order). It is Orders' own KPI: analysis/fanOutPlan.planFanOutMetric routes the dashboard's filters
// onto Orders by the pinned paths charts use (D11), and the figure is `computeCardMetric` on Orders — so its row
// access rules, the answer cache, fx and the resident-or-JS decision are whatever the door does for a plain KPI
// there. Nothing is summed here. A Live many side refuses, typed, as a fan-out chart's does (D15).
//
// A caller locked on Customers never gets here: rowDoors.reachesOther refuses a many-side measure first, since
// Orders' KPI run inside Customers' lock scope would read Customers as open (D14).

import type { FilterStep } from '../data/transforms';
import type { MetricAggregation } from '../analysis/metricValue';
import type { ParamValues } from '../analysis/params';
import type { VizMeasure } from '../analysis/visuals';
import { measureLabel } from '../analysis/vizData';
import { planFanOutMetric } from '../analysis/fanOutPlan';
import * as msg from '../analysis/fanOutMessages';
import { refuse } from '../engine/live/liveSpec';
import * as datasets from '../data/datasets';
import { metricReads, projectModel } from './relationships';
import { LiveFigureError, liveMetaOf } from './liveRoute';

type Spec = { column: string; aggregation: MetricAggregation };
type Kpi = { ok: boolean; value: number | null; notes?: string[] };
type Ask<R extends Kpi> = (projectId: string, datasetId: string, spec: Spec, filters: FilterStep[], params?: ParamValues) => Promise<R>;

/** The plan, or null for a column the dataset has (every ordinary KPI stops at one metadata read). */
async function planOf(projectId: string, datasetId: string, column: string, filters: FilterStep[]) {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta || meta.columns.some((c) => c.name === column)) return null;
  const { rels, infos } = await projectModel(projectId, datasetId);
  return rels.length ? planFanOutMetric(datasetId, column, filters, rels, infos) : null;
}

/** The KPI on its many side, with the tile's notes; null when its column is no many side's (today's path). */
export async function fanOutMetricFor<R extends Kpi>(projectId: string, datasetId: string, spec: Spec, filters: FilterStep[], params: ParamValues | undefined, ask: Ask<R>): Promise<R | Kpi | null> {
  const planned = await planOf(projectId, datasetId, spec.column, filters);
  if (!planned) return null;
  if (!planned.ok) return { ok: true, value: null, notes: [planned.error] }; // no one table to total it on: no figure, and why
  const { plan } = planned;
  if (await liveMetaOf(projectId, plan.datasetId)) {
    const r = refuse('related');
    throw new LiveFigureError({ ok: false, code: 'live_refused', error: r.message, reason: r.code });
  }
  const res = await ask(projectId, plan.datasetId, spec, plan.filters, params);
  if (!res.ok) return res;
  const name = `“${measureLabel(spec as VizMeasure)}”`;
  const ours = plan.notes.map((n) => (n.kind === 'ownRows' ? msg.fanOutOwnRows(name) : n.measures.length ? msg.fanOutNarrows(n.column, name) : msg.fanOutNarrowsNone(n.column)));
  return { ...res, notes: Array.from(new Set((res.notes ?? []).concat(ours))) };
}

/** What a many-side KPI reads besides `datasetId`: its table and that KPI's own join (row access gates exactly these); null when it is not one. */
export async function fanOutMetricReads(projectId: string, datasetId: string, column: string, filters: FilterStep[]): Promise<string[] | null> {
  const planned = await planOf(projectId, datasetId, column, filters);
  if (!planned || !planned.ok) return null;
  const m = planned.plan.datasetId;
  return [...new Set([m, ...(await metricReads(projectId, m, column, planned.plan.filters))])].filter((id) => id !== datasetId);
}
