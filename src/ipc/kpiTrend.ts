// A KPI's small TREND (CardMetric.trend) — its measure per month along the
// dataset's date column, and the change in the latest month. MAIN PROCESS.
//
// Through the chart door (`vizDataFor`), so it is exactly the line a chart of
// the same measure by month draws — an extract read in place, a Live dataset
// asked of its warehouse — and scripts/test-kpiTrend.ts holds the two equal
// with Object.is. The change is arithmetic on those two figures, done here so
// no browser does it; nothing is stored.

import * as datasets from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import type { MetricAggregation } from '../analysis/metricValue';
import type { ParamValues } from '../analysis/params';
import { asMonthLabels, formatValue } from '../app/format';
import { vizDataFor } from './visuals';

/** A sparkline is a sparkline: past a year it is a chart. */
export const TREND_POINTS = 12;

export interface KpiTrend {
  /** The months, oldest first, as a reader reads them ("Jan 2024"). */
  labels: string[];
  values: Array<number | null>;
  /** The latest month against the one before; absent when either has no figure. */
  change?: { delta: number; pct: number | null; deltaDisplay: string; tone: 'good' | 'bad' | 'flat'; label: string };
}

/** The months a KPI's figure ran through, or null when its dataset has no date column or the chart door says no. */
export async function kpiTrend(
  projectId: string,
  card: { datasetId: string; column: string; aggregation: MetricAggregation; format?: string },
  filters: FilterStep[],
  params?: ParamValues,
): Promise<KpiTrend | null> {
  const meta = await datasets.getDatasetMeta(projectId, card.datasetId);
  const date = meta?.columns.find((c) => c.type === 'date');
  // shortcut: a formula metric (no column) has no trend, until metric:series gains a card door.
  if (!date || !card.column) return null;
  const res = await vizDataFor(projectId, card.datasetId, {
    category: date.name, grain: 'month', values: [{ column: card.column, aggregation: card.aggregation }],
  }, filters, { params });
  if (!res.ok || !res.data.series[0]) return null;
  const values = res.data.series[0].values.slice(-TREND_POINTS).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null));
  // A month bucket's key is "2024-03"; asMonthLabels reads a first-of-month date.
  const labels = asMonthLabels(res.data.labels.slice(-TREND_POINTS).map((l) => (/^\d{4}-\d{2}$/.test(String(l)) ? `${l}-01` : l))).map(String);
  if (values.length < 2) return { labels, values };
  const [prev, last] = values.slice(-2);
  if (prev === null || last === null) return { labels, values };
  const delta = last - prev;
  return {
    labels,
    values,
    change: {
      delta,
      pct: prev !== 0 ? (delta / Math.abs(prev)) * 100 : null,
      deltaDisplay: formatValue(Math.abs(delta), card.format || 'auto'),
      tone: delta > 0 ? 'good' : delta < 0 ? 'bad' : 'flat',
      label: `${labels[labels.length - 1]} vs ${labels[labels.length - 2]}`,
    },
  };
}
