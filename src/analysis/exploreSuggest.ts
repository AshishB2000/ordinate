// Explore's field list and suggested questions (docs/explore/00-design.md) —
// MAIN PROCESS, PURE.
//
// starterPlan's ranking over a dataset's DECLARED columns and nothing else: no
// column summaries, no sample, no row. What leaves is column names, the
// aggregate a click would use, and chart ENCODINGS — never a figure, never a
// count; the browser draws each suggestion through `visual:data` like any other
// question. With no summaries `categoryColumns` keeps every text column, by its
// own documented rule, so an extract and a Live dataset are answered alike. A semantic dataset's measures are its
// layer's metrics (`layer`, its mirrors by id), never a sum of its fields, which the layer refuses (columnOnLayer).

import type { ParsedColumn } from '../data/parse';
import { aggregationFor, categoryColumns, rankedMeasures } from './starterPlan';
import type { VizEncoding, VizMeasure } from './visuals';

export interface ExploreFields {
  /** Text columns, and the numbers starterPlan says are not measures (ids, codes, years, coordinates); declared order. */
  dimensions: { name: string; type: 'text' | 'number' }[];
  dates: { name: string }[];
  /** starterPlan's order — money, then counts, then the rest — each with the aggregate a click uses; a mirror by its id. */
  measures: { name: string; aggregation: 'sum' | 'avg'; metricId?: string }[];
}

export interface ExploreSuggestion {
  chartType: string;
  encoding: VizEncoding;
}

/** A starting row, not a catalogue. */
const MAX_SUGGESTIONS = 6;

export function exploreSuggest(columns: readonly ParsedColumn[], layer?: readonly { name: string; metricId: string }[]): ExploreFields & { suggestions: ExploreSuggestion[] } {
  const ds = { columns: columns.slice() };
  const ranked = layer ? [] : rankedMeasures(ds);
  const isMeasure = new Set(ranked.map((c) => c.name));
  const axes = categoryColumns(ds);
  const date = columns.find((c) => c.type === 'date');

  const suggestions: ExploreSuggestion[] = [];
  const seen = new Set<string>();
  const push = (chartType: string, encoding: VizEncoding): void => {
    const key = JSON.stringify(encoding);
    if (seen.has(key) || suggestions.length >= MAX_SUGGESTIONS) return;
    seen.add(key);
    suggestions.push({ chartType, encoding });
  };
  const by = (c: ParsedColumn, m: VizMeasure): VizEncoding => ({ category: c.name, values: [m] });
  const monthly = (d: ParsedColumn, m: VizMeasure): VizEncoding => ({ category: d.name, grain: 'month', values: [m] });

  const shown: VizMeasure[] = layer ? layer.map((m) => ({ column: m.name, aggregation: 'sum', metricId: m.metricId })) : ranked.map((c) => ({ column: c.name, aggregation: aggregationFor(c.name) }));
  if (shown.length) {
    const [m0, m1] = shown;
    if (axes[0]) push('column', by(axes[0], m0));
    if (date) push('line', monthly(date, m0));
    if (m1 && axes[0]) push('column', by(axes[0], m1));
    if (axes[1]) push('bar', by(axes[1], m0));
    if (m1 && date) push('area', monthly(date, m1));
    if (axes[2]) push('bar', by(axes[2], m0));
  } else if (!layer) {
    // Nothing to total: how many rows, by what there is.
    const count = (c: ParsedColumn): VizMeasure => ({ column: c.name, aggregation: 'count' });
    if (axes[0]) push('column', by(axes[0], count(axes[0])));
    if (date) push('line', monthly(date, count(date)));
    if (axes[1]) push('bar', by(axes[1], count(axes[1])));
  }

  return {
    dimensions: columns
      .filter((c) => c.type === 'text' || (c.type === 'number' && !isMeasure.has(c.name)))
      .map((c) => ({ name: c.name, type: c.type === 'number' ? 'number' : 'text' })),
    dates: columns.filter((c) => c.type === 'date').map((c) => ({ name: c.name })),
    measures: layer ? layer.map((m) => ({ name: m.name, aggregation: 'sum' as const, metricId: m.metricId })) : ranked.map((c) => ({ name: c.name, aggregation: aggregationFor(c.name) })),
    suggestions,
  };
}
