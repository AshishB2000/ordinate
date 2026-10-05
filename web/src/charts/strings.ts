// The words the chart engine prints, in English, under the desktop catalog's
// own keys (src/i18n/en.json) and through its own ICU formatter
// (src/app/i18nCore.ts, no runtime imports) — so a plural or a select renders
// exactly as on the desktop. strings.test.ts pins every message to en.json.
// ponytail: English only until the web app gets its catalog; then `t` here
// becomes that catalog's lookup and this table goes.

import { formatMessage } from '../../../src/app/i18nCore.ts';

export const CHART_STRINGS = {
  'calcMenu.moving_avg_2': ' moving avg',
  'calcMenu.moving_sum_2': ' moving sum',
  'calcMenu.of_total': ' of total',
  'calcMenu.running_total_2': ' running total',
  'calcMenu.vs_previous': ' vs previous',
  'chartRender.of_top': '{v} ({pct}% of top)',
  'chartRender.system_ui_sans_serif': 'system-ui, sans-serif',
  'chartFamiliesExtra.cumulative': 'Cumulative %',
  'chartFamiliesExtra.cumulative_2': 'Cumulative: {p0}%',
  'chartFamiliesExtra.no_data': 'No data',
  'chartFamiliesExtra.of_target': '{value} of {target} target{pct}',
  'chartFamiliesPlugins.80_of': '80% · {count80} of {labelsCount}',
  'common.campaign': 'Campaign',
  'common.cohort': 'Cohort',
  'common.colour': 'Colour',
  'common.count': 'Count',
  'common.distribution': 'Distribution',
  'common.event': 'Event',
  'common.holiday': 'Holiday',
  'common.incident': 'Incident',
  'common.label': 'Label',
  'common.launch': 'Launch',
  'common.table': 'Table',
  'common.total': 'Total',
  'common.value': 'Value',
  'renderResult.100_stacked_bar': '100% stacked bar',
  'renderResult.100_stacked_column': '100% stacked column',
  'renderResult.area': 'Area',
  'renderResult.bar': 'Bar',
  'renderResult.box_plot': 'Box plot',
  'renderResult.bubble': 'Bubble',
  'renderResult.bubble_map': 'Bubble map',
  'renderResult.bullet': 'Bullet',
  'renderResult.calendar_heatmap': 'Calendar heatmap',
  'renderResult.candlestick': 'Candlestick',
  'renderResult.clustered_bar': 'Clustered bar',
  'renderResult.clustered_column': 'Clustered column',
  'renderResult.donut': 'Donut',
  'renderResult.event_funnel': 'Event funnel',
  'renderResult.flow_map': 'Flow map',
  'renderResult.funnel': 'Funnel',
  'renderResult.gauge': 'Gauge',
  'renderResult.heatmap': 'Heatmap',
  'renderResult.hexbin_map': 'Hexbin map',
  'renderResult.histogram': 'Histogram',
  'renderResult.line': 'Line',
  'renderResult.line_column': 'Line + column',
  'renderResult.line_with_markers': 'Line with markers',
  'renderResult.pareto': 'Pareto',
  'renderResult.pie': 'Pie',
  'renderResult.pivot_table': 'Pivot table',
  'renderResult.radar': 'Radar',
  'renderResult.region_map': 'Region map',
  'renderResult.sankey': 'Sankey',
  'renderResult.scatter': 'Scatter',
  'renderResult.stacked_area': 'Stacked area',
  'renderResult.stacked_bar': 'Stacked bar',
  'renderResult.stacked_column': 'Stacked column',
  'renderResult.treemap': 'Treemap',
  'renderResult.waterfall': 'Waterfall',
  'renderResult.word_cloud': 'Word cloud',
  'wordCloudRender.no_words_to_draw_every_value': 'No words to draw — every value is empty or zero',
  'wordCloudRender.not_fit': '{p0}{n, plural, one { smaller word did} other { smaller words did}} not fit',
  'wordCloudRender.word_cloud': 'Word cloud: {p0}{p1, select, true {, …} other {}}',
  'wordCloudRender.word_cloud_no_words_to_draw': 'Word cloud: no words to draw',
} as const;

export type ChartStringKey = keyof typeof CHART_STRINGS;

export function t(key: ChartStringKey, params?: Record<string, unknown>): string {
  return formatMessage(CHART_STRINGS[key], params, 'en');
}
