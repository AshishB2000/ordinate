// One encoding per chart id over the bundled sample dataset ("Retail orders",
// assets/samples/retail-orders.csv): the question each chart type is drawn
// for on /dev/charts, and the data legacy.test.ts compares the desktop's
// builder with this one on. The server computes every answer (`visual:data`);
// ids that read the same question share one encoding, so one request.
//
// Columns: order_date, region, state, category, sub_category, customer_segment,
// units, unit_price, discount, revenue, profit, ship_days.

import type { VizId } from './vizLabels';

type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max';
const m = (column: string, aggregation: Agg = 'sum') => ({ column, aggregation });

/** The encoding shape `visual:data` takes (src/analysis/visuals.ts VizEncoding, the fields used here). */
export type SampleEncoding = {
  category: string;
  values: Array<{ column: string; aggregation: Agg }>;
  series?: string;
  grain?: 'day' | 'week' | 'month' | 'quarter' | 'year';
  geo?: { level: 'us_state' };
  pivot?: unknown;
  cohort?: unknown;
  eventFunnel?: unknown;
};

const BY_SUB: SampleEncoding = { category: 'sub_category', values: [m('revenue')] };
const BY_REGION_SEGMENT: SampleEncoding = { category: 'region', series: 'customer_segment', values: [m('revenue')] };
const BY_MONTH: SampleEncoding = { category: 'order_date', grain: 'month', values: [m('revenue')] };
const BY_CATEGORY: SampleEncoding = { category: 'category', values: [m('revenue')] };
const BY_STATE: SampleEncoding = { category: 'state', values: [m('profit')], geo: { level: 'us_state' } };

export const SAMPLE_ENCODINGS: Record<VizId, SampleEncoding> = {
  column: BY_SUB,
  bar: BY_SUB,
  pie: BY_CATEGORY,
  donut: BY_CATEGORY,
  treemap: BY_SUB,
  funnel: BY_CATEGORY,
  histogram: { category: 'state', values: [m('revenue')] },
  sankey: { category: 'region', values: [m('revenue')] },
  pareto: BY_SUB,
  word_cloud: BY_SUB,
  gauge: { category: 'region', values: [m('discount', 'avg')] },
  clustered_column: BY_REGION_SEGMENT,
  clustered_bar: BY_REGION_SEGMENT,
  stacked_column: BY_REGION_SEGMENT,
  stacked_bar: BY_REGION_SEGMENT,
  pct_stacked_column: BY_REGION_SEGMENT,
  pct_stacked_bar: BY_REGION_SEGMENT,
  heatmap: { category: 'sub_category', series: 'region', values: [m('profit')] },
  line: BY_MONTH,
  line_markers: BY_MONTH,
  area: BY_MONTH,
  stacked_area: { category: 'order_date', grain: 'quarter', series: 'category', values: [m('revenue')] },
  combo: { category: 'order_date', grain: 'month', values: [m('revenue'), m('profit')] },
  scatter: { category: 'sub_category', values: [m('revenue'), m('profit')] },
  bubble: { category: 'sub_category', values: [m('revenue'), m('profit'), m('units')] },
  candlestick: {
    category: 'order_date',
    grain: 'month',
    values: [m('unit_price', 'avg'), m('unit_price', 'max'), m('unit_price', 'min'), m('unit_price', 'avg')],
  },
  boxplot: { category: 'state', values: [m('revenue'), m('profit')] },
  waterfall: { category: 'sub_category', values: [m('profit')] },
  bullet: { category: 'region', values: [m('revenue'), m('profit')] },
  calendar: { category: 'order_date', grain: 'day', values: [m('revenue')] },
  radar: { category: 'region', values: [m('revenue'), m('profit'), m('units'), m('discount', 'avg')] },
  table: { category: 'category', values: [m('revenue'), m('profit'), m('units')] },
  pivot: {
    category: 'region',
    series: 'category',
    values: [m('revenue')],
    pivot: {
      rows: [{ column: 'region' }],
      columns: [{ column: 'category' }],
      values: [{ column: 'revenue', aggregation: 'sum' }],
      totals: { rows: true, columns: true, grand: true },
    },
  },
  cohort: {
    category: 'order_date',
    values: [m('revenue')],
    cohort: { entity: 'state', date: 'order_date', grain: 'quarter', show: 'retention', curve: true },
  },
  event_funnel: {
    category: 'category',
    values: [m('units')],
    eventFunnel: {
      entity: 'state',
      event: 'category',
      time: 'order_date',
      steps: ['Office Supplies', 'Furniture', 'Technology'],
      window: { n: 30, unit: 'days' },
    },
  },
  map_bubble: BY_STATE,
  map_choropleth: BY_STATE,
  map_hexbin: BY_STATE,
  map_flow: BY_STATE,
};
