// A funnel metric on a chart (semantic layer part 5, step 08, D7) — MAIN PROCESS. It charts alone
// (analysis/metricMeasures), and every point is a tile or the engine's own breakdown:
//
//   · along a date: one resolution per bucket (./metricBuckets), the bucket's days as the scope, so it picks the
//     entries on those days, as the tile under that bucket does;
//   · along any other column of its dataset: ONE chart-door question, the funnel broken down by that column — an
//     entity counts under its entry event's value, once, so entered and converted add up across the bars. A tile
//     filtered to Germany admits an entity at its first GERMAN step-1 event; the two differ only for an entity whose
//     step-1 events carry different values (the documented edge, scripts/test-funnelMetrics.ts);
//   · a column of another dataset: refused (the breakdown is the entry event's own value).
//
// Nothing here counts: the door and the KPI resolver compute; ./funnelMetric turns counts into the figure.

import type { Metric } from '../analysis/metrics';
import type { MetricFunnelDefinition } from '../analysis/funnelMetric';
import { FUNNEL_BREAKDOWN_CAP } from '../analysis/funnelEvents';
import type { VizEncoding } from '../analysis/visuals';
import { resolveFilterParams } from '../analysis/params';
import type { ParamValues } from '../analysis/params';
import * as msg from '../analysis/metricCheckMessages';
import * as datasets from '../data/datasets';
import { isLive } from '../data/liveDataset';
import type { FilterStep } from '../data/transforms';
import { liveFunnelRefused } from '../engine/liveRefusals';
import { bucketSeries } from './metricBuckets';
import { olderAsOf, resolveMetric } from './metrics';
import { entryOf, entryRefusal, funnelFigure } from './funnelMetric';
import type { VizDataReply } from './visuals';

type Ok = Extract<VizDataReply, { ok: true }>;
type Ask = (encoding: VizEncoding, filters: FilterStep[]) => Promise<VizDataReply>;

/** `metric` (a funnel metric, charted alone) on `encoding` under the chart's `filters`; `ask` is the chart door. */
export async function funnelChartData(metric: Metric, encoding: VizEncoding, filters: FilterStep[], ask: Ask, params: ParamValues): Promise<VizDataReply> {
  const def = metric.definition as MetricFunnelDefinition;
  const { projectId, datasetId } = metric;
  const meta = await datasets.getDatasetMeta(projectId, datasetId); // schema only
  if (isLive(meta)) return { ok: false, code: 'live_refused', reason: 'funnel', error: liveFunnelRefused() }; // the door's own refusal, before any statement
  const cat = encoding.categoryDatasetId ? undefined : meta?.columns.find((c) => c.name === encoding.category);
  if (!cat) return { ok: false, error: msg.funnelOwnColumn(metric.name, encoding.category) };

  if (cat.type === 'date') {
    let asOf: Ok['asOf'];
    const notes = new Set<string>();
    const s = await bucketSeries(projectId, datasetId, cat.name, encoding.grain, filters, async (f) => {
      const r = await resolveMetric(projectId, metric.id, { filters: f, params });
      asOf = olderAsOf(asOf, r?.asOf);
      for (const n of r?.notes ?? []) notes.add(n); // a refusal or a caveat, said once on the chart
      return r?.value ?? null;
    }, { params, name: metric.name, tooMany: (g, n) => msg.funnelTooManyBuckets(metric.name, g, n) });
    if (!s.ok) return s;
    const out: Ok = { ok: true, data: { labels: s.labels, series: [{ name: metric.name, values: s.values }] }, recommendedShape: 'time_series', warnings: [...notes], category: { kind: 'date', grain: s.grain } };
    if (asOf) out.asOf = asOf;
    return out;
  }

  const { entry, lock } = entryOf(filters);
  const refused = await entryRefusal(projectId, datasetId, entry);
  if (refused) return { ok: false, error: refused };
  const own = resolveFilterParams(metric.filters, params).steps;
  const r = await ask({ category: '', values: [], eventFunnel: { ...def.funnel, breakdown: cat.name, entry } }, [...lock, ...own]);
  if (!r.ok) return r;
  const bd = r.data.eventFunnel?.breakdown;
  if (!bd) return { ok: false, error: msg.snapshotPerNotColumn(cat.name) }; // a funnel column gone since the save
  const isNumber = cat.type === 'number';
  const labels = bd.groups.map((g) => (isNumber && g.label !== '' ? Number(g.label) : g.label)); // the door's labels: a number column's are numbers
  const values = bd.groups.map((g) => funnelFigure(g, def.show));
  const warnings = bd.truncated ? r.warnings.concat(msg.funnelTopGroups(FUNNEL_BREAKDOWN_CAP, cat.name)) : r.warnings;
  const out: Ok = { ok: true, data: { labels, series: [{ name: metric.name, values }] }, recommendedShape: 'categorical', warnings, category: { kind: isNumber ? 'number' : 'text' } };
  // A map's regions come from the first series (vizData.buildVizData): a region with no figure is omitted, never 0.
  if (encoding.geo) out.data.geo = { level: encoding.geo.level, items: labels.flatMap((l, i) => (typeof values[i] === 'number' ? [{ name: String(l), value: values[i] }] : [])) };
  if (r.asOf) out.asOf = r.asOf;
  if (r.notes) out.notes = r.notes;
  return out;
}
