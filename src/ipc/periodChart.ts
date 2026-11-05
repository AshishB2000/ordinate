// A period metric on a chart (semantic layer part 5, step 06, D10) — MAIN PROCESS. Every point equals its tile:
//
//   · along the date its base counts by: one resolution per bucket (./metricBuckets), the bucket's days as the scope,
//     so "Revenue YTD" at March is the YTD tile under March, under any calendar, a month with no rows included;
//   · along anything that is not a date: ONE chart-door question for the base over the rewritten scope, as the tile
//     rewrites it (two for a compare, paired by label: a label the prior lacks has no figure, and neither has "Other",
//     since the two folds hold different members);
//   · along another date: refused, as the window would lie on one date and the axis on another.
//
// Nothing here aggregates: the chart door and the KPI resolver compute; the compare's arithmetic is periodMath's.

import type { Metric } from '../analysis/metrics';
import type { MetricPeriodDefinition } from '../analysis/periodMetric';
import type { VizEncoding } from '../analysis/visuals';
import { resolveFilterParams } from '../analysis/params';
import type { ParamValues } from '../analysis/params';
import { periodValue, windowedScope } from '../analysis/periodMath';
import { compareScope } from '../analysis/periodScope';
import { getCalendar, todayIso } from '../analysis/dateIntel';
import { OTHER_LABEL } from '../analysis/categoryKey';
import { keyOf } from '../analysis/vizData';
import { mergeFx } from '../analysis/fx';
import * as msg from '../analysis/metricCheckMessages';
import * as datasets from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import { bucketSeries } from './metricBuckets';
import { olderAsOf, resolveMetric } from './metrics';
import { baseOf } from './periodMetric';
import type { VizDataReply } from './visuals';

type Ok = Extract<VizDataReply, { ok: true }>;
type Ask = (encoding: VizEncoding, filters: FilterStep[]) => Promise<VizDataReply>;

const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** `metric` (a period metric, charted alone: ./analysis/metricMeasures) on `encoding` under the chart's `filters`; `ask` is the chart door. */
export async function periodChartData(metric: Metric, encoding: VizEncoding, filters: FilterStep[], ask: Ask, params: ParamValues): Promise<VizDataReply> {
  const def = metric.definition as MetricPeriodDefinition;
  const { projectId, datasetId } = metric;
  const found = await baseOf(projectId, datasetId, def);
  if ('error' in found) return { ok: false, error: found.error };
  const date = found.date.name;

  if (encoding.category === date && !encoding.categoryDatasetId) {
    let fx: Ok['fx'];
    let asOf: Ok['asOf'];
    const s = await bucketSeries(projectId, datasetId, date, encoding.grain, filters, async (f) => {
      const r = await resolveMetric(projectId, metric.id, { filters: f, params });
      fx = mergeFx(fx, r?.fx);
      asOf = olderAsOf(asOf, r?.asOf);
      return r?.value ?? null;
    }, { params, name: metric.name });
    if (!s.ok) return s;
    const out: Ok = { ok: true, data: { labels: s.labels, series: [{ name: metric.name, values: s.values }] }, recommendedShape: 'time_series', warnings: [], category: { kind: 'date', grain: s.grain } };
    if (fx) out.fx = fx;
    if (asOf) out.asOf = asOf;
    return out;
  }
  const cat = (await datasets.getDatasetMeta(projectId, encoding.categoryDatasetId ?? datasetId))?.columns.find((c) => c.name === encoding.category); // schema only
  if (cat?.type === 'date') return { ok: false, error: msg.periodOtherDate(metric.name, date, encoding.category) };

  // The base as the measure (the door follows its own filters), under the period's own filters, then the chart's, windowed.
  const windowed = windowedScope(resolveFilterParams(metric.filters, params).steps.concat(filters), found.date, def.window, todayIso(), getCalendar());
  const asBase: VizEncoding = { ...encoding, values: [{ ...encoding.values[0], metricId: found.base.id }] };
  const now = await ask(asBase, windowed.filters);
  if (!now.ok) return now;
  const drawn = (values: (number | null)[], from: Ok[], warnings: string[] = []): Ok => {
    const out: Ok = { ...now, data: { ...now.data, series: [{ ...(now.data.series[0] ?? {}), name: metric.name, values }] }, warnings: Array.from(new Set(from.flatMap((r) => r.warnings).concat(warnings))) };
    // A map's regions come from the first series (vizData.buildVizData): a region with no figure is omitted, never 0.
    if (now.data.geo) out.data.geo = { ...now.data.geo, items: now.data.labels.flatMap((l, i) => (typeof values[i] === 'number' ? [{ name: String(l), value: values[i] }] : [])) };
    const fx = from.reduce<Ok['fx']>((a, r) => mergeFx(a, r.fx), undefined);
    const asOf = from.reduce<Ok['asOf']>((a, r) => olderAsOf(a, r.asOf), undefined);
    if (fx) out.fx = fx;
    if (asOf) out.asOf = asOf;
    return out;
  };
  const current = now.data.series[0]?.values ?? [];
  if (!def.compare) return drawn(current, [now]);
  const moved = compareScope(windowed.filters, [found.date], { mode: def.compare.vs });
  if (!moved) return drawn(current.map(() => null), [now], [msg.pickPeriodToCompare()]);
  const prior = await ask(asBase, moved.filters);
  if (!prior.ok) return prior;
  if (now.category?.binned || prior.category?.binned) return { ok: false, error: msg.measureNeedsOneAxis(metric.name) }; // bins span each scope's own range
  const folded = !!(now.category?.note || prior.category?.note);
  const before = new Map(prior.data.labels.map((l, i) => [keyOf(l), prior.data.series[0]?.values[i] ?? null]));
  const show = def.compare.show;
  return drawn(now.data.labels.map((l, i) => (folded && l === OTHER_LABEL ? null : periodValue(show, num(current[i]), num(before.get(keyOf(l)))))), [now, prior]);
}
