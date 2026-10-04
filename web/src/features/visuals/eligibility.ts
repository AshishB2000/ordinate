// Which chart types a reply can draw, best first — renderer/hub/renderResult.ts
// (SHAPE_CHARTS, eligibleChartTypes, chartCanRender, countNumericSeries, the
// picker's needs text), ported as pure functions. CODE decides the chips from
// the server's `recommendedShape` and the reply's real structure. Counting the
// series that carry a number is a property of the reply, not a figure shown.

import { geoMapFits, geoNeedsText, isMapChartType, MAP_CHART_TYPES } from '../../charts/maps/mapKinds';
import type { MapGeo } from '../../charts/maps/types';
import type { ChartDataShape } from '../../charts/types';

/** Every chart id the picker pools from, in click-through order (ALL_CHART_TYPE_IDS). */
export const ALL_CHART_TYPE_IDS = [
  'column', 'bar', 'clustered_column', 'clustered_bar',
  'stacked_column', 'stacked_bar', 'pct_stacked_column', 'pct_stacked_bar',
  'line', 'line_markers', 'area', 'stacked_area',
  'pie', 'donut', 'scatter', 'gauge', 'combo', 'bubble',
  'treemap', 'heatmap', 'funnel', 'histogram',
  'sankey', 'candlestick', 'boxplot',
  'waterfall', 'bullet', 'calendar', 'radar', 'pareto',
  'pivot', 'cohort', 'event_funnel',
  'word_cloud',
];

/** The builder's "+ More" pool: every chart, the table, every map. */
export const PICKER_POOL: readonly string[] = [...ALL_CHART_TYPE_IDS, 'table', ...MAP_CHART_TYPES];

/** Drawn as grids by T1.2's renderers (charts/grids/GridViz), with their own shelves (analytics/grids). */
export const GRID_TYPES: ReadonlySet<string> = new Set(['pivot', 'cohort', 'event_funnel']);

const SHAPE_CHARTS: Record<string, string[]> = {
  time_series: ['line', 'line_markers', 'area', 'stacked_area', 'column', 'clustered_column', 'combo', 'heatmap', 'calendar', 'pivot', 'table'],
  part_to_whole: ['pie', 'donut', 'treemap', 'pct_stacked_column', 'pct_stacked_bar', 'stacked_column', 'funnel', 'pareto', 'pivot', 'table'],
  categorical: ['column', 'bar', 'clustered_column', 'clustered_bar', 'heatmap', 'pareto', 'waterfall', 'bullet', 'radar', 'pivot', 'table', 'word_cloud'],
  single_metric: ['gauge', 'table'],
  matrix: ['heatmap', 'pivot', 'table'],
  unstructured: ['table'],
};

const SERIES_MIN: Record<string, number> = {
  clustered_column: 2, clustered_bar: 2, stacked_column: 2, stacked_bar: 2,
  pct_stacked_column: 2, pct_stacked_bar: 2, stacked_area: 2, combo: 2,
  scatter: 2, bubble: 3, heatmap: 2, radar: 3,
};
const SERIES_MAX: Record<string, number> = { column: 1, bar: 1, pareto: 1, calendar: 1, waterfall: 2, bullet: 2, radar: 6, word_cloud: 2 };
const LABELS_MIN: Record<string, number> = {
  pie: 2, donut: 2, treemap: 2, heatmap: 2, funnel: 3,
  pareto: 2, waterfall: 2, radar: 2, calendar: 7, word_cloud: 3,
};

/** Series that carry at least one number. */
export function countNumericSeries(data: ChartDataShape | null | undefined): number {
  if (!data || !Array.isArray(data.series)) return 0;
  return data.series.filter((s) => Array.isArray(s.values) && s.values.some((v: unknown) => typeof v === 'number')).length;
}

/** A shape's chart ids that this many series and labels support, best first. */
export function eligibleChartTypes(dataShape: string, seriesCount: number, labelCount: number): string[] {
  const base = SHAPE_CHARTS[dataShape] || SHAPE_CHARTS.unstructured;
  return base.filter((type) => {
    if (type === 'table' || type === 'pivot') return true;
    if (seriesCount < (SERIES_MIN[type] || 1)) return false;
    if (seriesCount > (SERIES_MAX[type] || Infinity)) return false;
    return labelCount >= (LABELS_MIN[type] || 1);
  });
}

type WithGeo = ChartDataShape & { geo?: MapGeo | null };

/**
 * Can `type` physically draw THIS data? Asked of every chip and of a reopened
 * visual's saved type — a saved gauge stays a gauge even where it is not
 * recommended. Deliberately ignores SERIES_MAX (that only decides suggestions).
 */
export function chartCanRender(type: string, data: WithGeo | null | undefined, hasGeo: boolean): boolean {
  if (type === 'table' || GRID_TYPES.has(type)) return true;
  if (isMapChartType(type)) return hasGeo && geoMapFits(type, data?.geo ?? ({} as MapGeo));
  const d = data || {};
  if (countNumericSeries(d) < (SERIES_MIN[type] || 1)) return false;
  return (d.labels || []).length >= (LABELS_MIN[type] || 1);
}

/** "at least 2 numeric series and at least 3 categories" — why a chip cannot draw. */
export function needsText(type: string, data: WithGeo | null | undefined, hasGeo: boolean): string {
  const parts: string[] = [];
  const ns = SERIES_MIN[type] || 1;
  const nl = LABELS_MIN[type] || 1;
  if (isMapChartType(type) && !chartCanRender(type, data, hasGeo)) parts.push(geoNeedsText(type, hasGeo));
  if (countNumericSeries(data) < ns) parts.push(`at least ${ns} numeric series`);
  if ((data?.labels || []).length < nl) parts.push(`at least ${nl} categories`);
  return parts.join(' and ') || 'different data';
}
