// Every chart id Ordinate draws and its display name (the desktop's
// renderResult.ts `VIZ_LABELS`): 39 ids. Most are Chart.js charts drawn by
// <Chart>; the rest have a renderer of their own, named in VIZ_RENDERER.

import { t } from './strings';

export const VIZ_LABELS = {
  column: 'Column', bar: t('renderResult.bar'), clustered_column: t('renderResult.clustered_column'), clustered_bar: t('renderResult.clustered_bar'),
  stacked_column: t('renderResult.stacked_column'), stacked_bar: t('renderResult.stacked_bar'),
  pct_stacked_column: t('renderResult.100_stacked_column'), pct_stacked_bar: t('renderResult.100_stacked_bar'),
  line: t('renderResult.line'), line_markers: t('renderResult.line_with_markers'), area: t('renderResult.area'), stacked_area: t('renderResult.stacked_area'),
  pie: t('renderResult.pie'), donut: t('renderResult.donut'), scatter: t('renderResult.scatter'), gauge: t('renderResult.gauge'),
  combo: t('renderResult.line_column'), bubble: t('renderResult.bubble'), treemap: t('renderResult.treemap'), heatmap: t('renderResult.heatmap'),
  funnel: t('renderResult.funnel'), histogram: t('renderResult.histogram'),
  sankey: t('renderResult.sankey'), candlestick: t('renderResult.candlestick'), boxplot: t('renderResult.box_plot'),
  waterfall: t('renderResult.waterfall'), bullet: t('renderResult.bullet'), calendar: t('renderResult.calendar_heatmap'), radar: t('renderResult.radar'), pareto: t('renderResult.pareto'),
  pivot: t('renderResult.pivot_table'), cohort: t('common.cohort'), event_funnel: t('renderResult.event_funnel'),
  table: t('common.table'), map_bubble: t('renderResult.bubble_map'), map_choropleth: t('renderResult.region_map'),
  word_cloud: t('renderResult.word_cloud'),
  map_hexbin: t('renderResult.hexbin_map'), map_flow: t('renderResult.flow_map'),
} as const;

export type VizId = keyof typeof VIZ_LABELS;
export const VIZ_IDS = Object.keys(VIZ_LABELS) as VizId[];

/**
 * Who draws an id other than <Chart>. On the desktop renderResult dispatches
 * these BEFORE buildChart: `table` to the data table (DataTable here), the
 * pivot / cohort / event funnel to their grids (T1.2) and the maps to MapLibre
 * (T1.3). buildChart still draws their `{labels, series}` — a column, the
 * retention curve, the step funnel — which is what an export picture or a
 * thumbnail shows, and what /dev/charts shows until those renderers land.
 */
export const VIZ_RENDERER: Partial<Record<VizId, 'table' | 'grid' | 'map'>> = {
  table: 'table',
  pivot: 'grid', cohort: 'grid', event_funnel: 'grid',
  map_bubble: 'map', map_choropleth: 'map', map_hexbin: 'map', map_flow: 'map',
};
