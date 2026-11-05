// A measure on a retired metric, and the one edit that moves it to the replacement. Never automatic: an editor asks.

import { metricMeasure } from '../../calc/api';
import type { MetricSummary } from '../../analyses/metrics/api';

interface Enc {
  values: { metricId?: string }[];
}

/** Each measure whose metric is retired, by its position. */
export function retiredMeasures(encoding: Enc, metrics: readonly MetricSummary[]): Array<{ index: number; metric: MetricSummary }> {
  const out: Array<{ index: number; metric: MetricSummary }> = [];
  encoding.values.forEach((v, index) => {
    const metric = v.metricId ? metrics.find((m) => m.id === v.metricId) : undefined;
    if (metric?.status?.state === 'retired') out.push({ index, metric });
  });
  return out;
}

/** The encoding with only `values[index]` pointed at the replacement (its column and aggregation come from the metric's definition). */
export function switchTo<E extends { values: object[] }>(encoding: E, index: number, replacement: MetricSummary): E {
  return { ...encoding, values: encoding.values.map((v, i) => (i === index ? metricMeasure(replacement, v as never) : v)) };
}

/** The replacement a retired metric names, when it is in the list and not retired itself. */
export function replacementOf(metric: MetricSummary, metrics: readonly MetricSummary[]): MetricSummary | undefined {
  const id = metric.status?.replacedBy?.ref.replace(/^metric:/, '');
  const r = id ? metrics.find((m) => m.id === id) : undefined;
  return r && r.status?.state !== 'retired' ? r : undefined;
}
