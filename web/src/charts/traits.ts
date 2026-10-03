// Chart-type traits — what a chart id IS, decided by lookup, not by branching
// (renderer/hub/chartTraits.ts): which ids can be period-filtered, which become
// small multiples when grouped, which draw one dataset per series, which print
// their own values, which get a legend. A vocabulary; no Chart.js, no canvas.

import type { ChartSeriesShape } from './types';

export const PERIOD_DROPDOWN_TYPES = new Set([
  'line', 'area', 'stacked_area', 'line_markers',
  'column', 'bar', 'clustered_column', 'clustered_bar',
  'stacked_column', 'stacked_bar', 'pct_stacked_column', 'pct_stacked_bar', 'combo',
  'heatmap', 'boxplot',
]);
export function chartHasPeriodDropdown(type: string, seriesCount: number): boolean {
  return seriesCount >= 2 && PERIOD_DROPDOWN_TYPES.has(type);
}

// Share/magnitude types that can't stack several series into one chart. When the
// data is grouped (>=2 series) we render a small-multiples grid — one mini chart
// per period (series) — instead of silently dropping all but series[0]. The
// Periods dropdown filters which minis show; Values/Customize apply to all.
export const SMALL_MULTIPLE_TYPES = new Set(['pie', 'donut', 'gauge', 'treemap', 'funnel', 'histogram']);
export function chartIsSmallMultiple(type: string, seriesCount: number): boolean {
  return seriesCount >= 2 && SMALL_MULTIPLE_TYPES.has(type);
}

// Chart types that draw one Chart.js dataset per series, so the period filter can
// hide them live via setDatasetVisibility. Others (heatmap) rebuild instead.
export const PER_SERIES_DATASET_TYPES = new Set([
  'line', 'area', 'stacked_area', 'line_markers',
  'column', 'bar', 'clustered_column', 'clustered_bar',
  'stacked_column', 'stacked_bar', 'pct_stacked_column', 'pct_stacked_bar', 'combo',
]);

// Types whose renderers don't draw value labels (gauge prints its own center value;
// treemap/funnel already print values in place; a calendar's cells are too small
// and a radar's points are normalised).
export const NO_VALUE_LABEL_TYPES = new Set([
  'treemap', 'funnel', 'sankey', 'candlestick', 'boxplot', 'gauge',
  'calendar', 'radar',
  'word_cloud', // the word IS the label; its figure is in the tooltip
]);

// Legend on by default for every chart except plugin/synthetic types whose Chart.js
// legend would be a single meaningless entry. A single-series chart only gets one if
// the series is named (otherwise the legend swatch would be blank).
export const NO_LEGEND_TYPES = new Set([
  'gauge', 'bubble', 'treemap', 'heatmap', 'funnel', 'histogram',
  'sankey', 'candlestick', 'boxplot',
  // Colour carries the meaning (up/down, bands, a ramp with its own legend).
  'waterfall', 'bullet', 'calendar',
  'word_cloud',
]);
export function legendOnByDefault(type: string, ser: ChartSeriesShape[]): boolean {
  if (NO_LEGEND_TYPES.has(type)) return false;
  if (type === 'pie' || type === 'donut') return true;
  return (ser || []).length > 1 || (ser || []).some((s: ChartSeriesShape) => s && !!s.name);
}
