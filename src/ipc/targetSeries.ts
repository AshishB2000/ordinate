// A metric's target as a stepped line on its chart (semantic layer part 5, D14) — MAIN PROCESS. The server works out
// the figure for every bar and React only draws it; this runs after the compare series and before the Share policy, and
// the series is a `role: 'overlay'` one marked `target: true`, which every reader that adds a chart up already skips.
//
//   - A chart whose one measure is a metric with a target, nothing split, faceted or pivoted. Anything else: the reply itself.
//   - On the metric's own date axis: each bar's bucket within the chart's scope is the tile's target for that range.
//   - On any other axis: the plan metric charted by the plan's column of the same name, a resolution for each of
//     `targetPlan`'s asks (at most three), combined per bar by the share of each that counts.

import * as metrics from '../analysis/metrics';
import type { Metric } from '../analysis/metrics';
import { isSimpleDefinition } from '../analysis/metrics';
import { followedEncoding } from '../analysis/metricMeasures';
import { metricDate } from '../analysis/metricTimeScope';
import { bucketRange } from '../analysis/driverScope';
import * as msg from '../analysis/targetMessages';
import { sanitizeEncoding } from '../analysis/visuals';
import type { VizEncoding } from '../analysis/visuals';
import * as datasets from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import { metricTarget, targetPlan } from './targetResolve';
import { vizDataFor } from './visuals';
import type { VizDataReply } from './visuals';

const MAX_DATES = 24;
type Ok = Extract<VizDataReply, { ok: true }>;
type Drawn = { values: (number | null)[] } | { note: string } | null;

const bounds = (column: string, r: { from?: string; to?: string }): FilterStep[] => [
  ...(r.from ? [{ type: 'filter', column, op: '>=', value: r.from } as FilterStep] : []),
  ...(r.to ? [{ type: 'filter', column, op: '<=', value: r.to } as FilterStep] : []),
];

/** One value for each date on the metric's own axis: the tile's target for that bar's range, within the chart's scope. */
async function byDate(projectId: string, m: Metric, reply: Ok, dateCol: string, filters: FilterStep[]): Promise<Drawn> {
  const grain = reply.category?.grain;
  if (!grain) return null;
  if (reply.data.labels.length > MAX_DATES) return { note: msg.targetSeriesTooLong() };
  const values: (number | null)[] = [];
  for (const label of reply.data.labels) {
    const r = bucketRange(String(label), grain);
    values.push(r ? (await metricTarget(projectId, m, [...filters, ...bounds(dateCol, r)], null))?.value ?? null : null);
  }
  return { values };
}

/** One value for each bar of a column the plan also has: the plan metric by it, each ask's share added up. */
async function byColumn(projectId: string, m: Metric, reply: Ok, column: string, filters: FilterStep[]): Promise<Drawn> {
  const p = await targetPlan(projectId, m, filters);
  if ('none' in p) return p.none ? { note: p.none } : null;
  if ('fixed' in p) return { values: reply.data.labels.map(() => p.fixed) };
  if (!(await datasets.getDatasetMeta(projectId, p.planDatasetId))?.columns.some((c) => c.name === column)) return { note: msg.targetPlanNoColumn(column) };
  const d = p.plan.definition;
  const measure = isSimpleDefinition(d) ? { column: d.column, aggregation: d.aggregation, metricId: p.plan.id } : { column: p.plan.name, aggregation: 'sum' as const, metricId: p.plan.id };
  const enc = await followedEncoding(projectId, p.planDatasetId, sanitizeEncoding({ category: column, values: [measure] }));
  const byLabel = new Map<string, number>();
  for (const ask of p.asks) {
    const plan = await vizDataFor(projectId, p.planDatasetId, enc, [...p.filters, ...bounds(p.planDate, ask)]);
    if (!plan.ok) return null; // a refusal is the plan's: no target rather than a half-drawn one
    plan.data.labels.forEach((l, i) => {
      const v = plan.data.series[0]?.values[i];
      if (typeof v === 'number') byLabel.set(String(l), (byLabel.get(String(l)) ?? 0) + v * ask.fraction);
    });
  }
  return { values: reply.data.labels.map((l) => byLabel.get(String(l)) ?? null) };
}

export async function withTargetSeries(reply: VizDataReply, projectId: string, datasetId: string, enc: VizEncoding, filters: FilterStep[]): Promise<VizDataReply> {
  try {
    if (!reply.ok || enc.series || enc.pivot || enc.geo || enc.cohort || enc.eventFunnel || enc.facet || enc.drivers || enc.categoryDatasetId) return reply;
    const v = enc.values.length === 1 ? enc.values[0] : null;
    if (!v?.metricId || v.calc || v.datasetId || v.aggregation === 'none' || !reply.data.series.length) return reply;
    const m = await metrics.getMetric(projectId, v.metricId);
    if (!m?.target || m.datasetId !== datasetId) return reply;
    const cat = reply.category;
    let drawn: Drawn = null;
    if (cat?.kind === 'date') {
      const dateCol = await metricDate(projectId, m);
      drawn = dateCol && dateCol === enc.category ? await byDate(projectId, m, reply, dateCol, filters) : null;
    } else if (!cat || cat.kind === 'text') {
      drawn = await byColumn(projectId, m, reply, enc.category, filters);
    }
    if (!drawn) return reply;
    if ('note' in drawn) return { ...reply, notes: [...(reply.notes ?? []), drawn.note] };
    if (drawn.values.every((x) => x === null)) return reply;
    return { ...reply, data: { ...reply.data, series: [...reply.data.series, { name: 'Target', values: drawn.values, role: 'overlay' as const, target: true as const }] } };
  } catch (_) {
    return reply; // shortcut: a target that can't be worked out is left off, like the compare series; surface the error if one ever needs saying
  }
}
