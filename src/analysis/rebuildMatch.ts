// REBUILD FROM A SCREENSHOT — matching what the model READ to the user's columns.
//
// Pure and deterministic: a field name off a screenshot ("Sales", "Order Date",
// "Sum of Profit") against the chosen dataset's columns, judged by name AND by
// the column's DECLARED type (ParsedColumn.type — never what its values look
// like). A sum, average, min or max needs a `number` column; a count takes any;
// a date range needs a `date`. A column of the wrong type is never matched,
// however well its name fits — it is reported instead, so a tile asking for a
// sum over a text column is refused and never built.
//
// The model only proposed the NAME. Everything here is app code, so the same
// reading maps to another dataset with no second model call.

import type { ParsedColumn } from '../data/parse';
import { CHART_TYPE_IDS } from './analysisPlan';

export type Confidence = 'exact' | 'likely' | 'guess';
export type MatchAgg = 'sum' | 'avg' | 'count' | 'min' | 'max';
/** What a field does on its tile — which decides the column types it may take. */
export type FieldRole = 'category' | 'value' | 'split' | 'filter' | 'date_filter';

export const LIKELY = 0.75;
export const GUESS = 0.5;

// Words that say how a field is aggregated, not which field it is.
const AGG_WORDS: [RegExp, MatchAgg][] = [
  [/^(?:avg|average|mean)\b\.?\s*(?:of\s+)?/i, 'avg'],
  [/^(?:count|number|no|#)\b\.?\s*(?:of\s+)?(?:distinct\s+)?/i, 'count'],
  [/^(?:sum|total)\b\s*(?:of\s+)?/i, 'sum'],
  [/^(?:min|minimum|lowest)\b\s*(?:of\s+)?/i, 'min'],
  [/^(?:max|maximum|highest|peak)\b\s*(?:of\s+)?/i, 'max'],
];

/** "Sum of Profit" → { field: "Profit", aggregation: "sum" }; a plain name keeps no aggregation. */
export function splitAggregation(said: string): { field: string; aggregation: MatchAgg | '' } {
  const s = said.trim().replace(/^#\s*/, 'number of ');
  for (const [re, aggregation] of AGG_WORDS) {
    const field = re.test(s) ? s.replace(re, '').trim() : '';
    if (field) return { field, aggregation }; // "Total" alone is a name, not an aggregation of nothing
  }
  return { field: s, aggregation: '' };
}

// Words a BI tool and a dataset use for the same thing. Small on purpose: a
// synonym is a likely match, never an exact one.
const SYNONYMS: string[][] = [
  ['revenue', 'sale', 'amount', 'turnover', 'income', 'gmv', 'booking'],
  ['quantity', 'qty', 'unit', 'volume'],
  ['customer', 'client', 'account', 'buyer'],
  ['product', 'item', 'sku'],
  ['date', 'day', 'time', 'period', 'month', 'week', 'year'],
  ['profit', 'margin', 'earning'],
  ['cost', 'expense', 'spend'],
  ['region', 'area', 'territory', 'zone', 'market'],
  ['category', 'segment', 'type', 'group', 'class'],
  ['country', 'nation'],
  ['state', 'province'],
  ['order', 'transaction', 'purchase'],
  ['employee', 'staff', 'rep', 'salesperson', 'agent'],
];
const SYN = new Map<string, number>();
SYNONYMS.forEach((group, i) => group.forEach((w) => SYN.set(w, i)));

const singular = (w: string): string => (w.length > 3 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/** Lower case, camelCase and separators split, light singular. */
export function tokens(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singular);
}

function tokenScore(a: string, b: string): number {
  if (a === b) return 1;
  const sa = SYN.get(a);
  if (sa !== undefined && sa === SYN.get(b)) return 0.8;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return 0.7;
  return 0;
}

/** 0–1: how well a name read off a screenshot fits a column name. 1 only for the same name. */
export function scoreName(said: string, column: string): number {
  const a = tokens(said);
  const b = tokens(column);
  if (!a.length || !b.length) return 0;
  if (a.join('') === b.join('')) return 1;
  const best = (xs: string[], ys: string[]): number => xs.reduce((n, x) => n + Math.max(...ys.map((y) => tokenScore(x, y))), 0);
  // Both ways round, so "Order Date" → "date" is not as good as "Order Date" → "order_date".
  return Math.min(0.95, (best(a, b) + best(b, a)) / (a.length + b.length));
}

/** May a column of this declared type play this role with this aggregation? */
export function fits(type: ParsedColumn['type'], role: FieldRole, aggregation?: MatchAgg): boolean {
  if (role === 'value') return aggregation === 'count' || type === 'number';
  if (role === 'date_filter') return type === 'date';
  return true;
}

export const confidenceOf = (score: number): Confidence | null => (score >= 0.999 ? 'exact' : score >= LIKELY ? 'likely' : score >= GUESS ? 'guess' : null);

export type FieldMatch =
  | { column: string; confidence: Confidence; score: number }
  | { column: null; refusedType?: { column: string; type: ParsedColumn['type'] } };

// "Number of Records" (Tableau), "Count", "Rows": a row count, not a field.
const RECORDS_RE = /^(?:number of )?(?:records?|rows?|count|entries)$/i;
export const isRecordCount = (said: string): boolean => RECORDS_RE.test(said.trim());

/**
 * The best column for one field. A tie keeps the dataset's column order, so the
 * answer never depends on anything but the inputs. When nothing that FITS is
 * close enough, the closest column that does not fit is reported, so the tile
 * can say why ("sum needs a number column, but 'Region' is text").
 */
export function matchField(said: string, columns: ParsedColumn[], role: FieldRole, aggregation?: MatchAgg): FieldMatch {
  if (!said.trim() || !columns.length) return { column: null };
  if (role === 'value' && aggregation === 'count' && isRecordCount(said)) {
    return { column: columns[0].name, confidence: 'likely', score: LIKELY };
  }
  let best: { column: string; score: number } | null = null;
  let refused: { column: string; type: ParsedColumn['type']; score: number } | null = null;
  for (const c of columns) {
    let score = scoreName(said, c.name);
    if (score < GUESS) continue;
    if (!fits(c.type, role, aggregation)) {
      if (!refused || score > refused.score) refused = { column: c.name, type: c.type, score };
      continue;
    }
    // A category is usually a word or a date; a number column there is the weaker reading.
    if (role === 'category' && c.type === 'number') score *= 0.9;
    if (!best || score > best.score) best = { column: c.name, score };
  }
  const confidence = best && confidenceOf(best.score);
  if (best && confidence) return { column: best.column, confidence, score: best.score };
  return refused ? { column: null, refusedType: { column: refused.column, type: refused.type } } : { column: null };
}

// ── Chart words → Ordinate's chart types ───────────────────────────────────
// The prompt lists Ordinate's own ids, so most replies need nothing here; this
// catches the words BI tools use for the same charts. Anything else is not
// guessed at: the tile asks the user to pick.
const CHART_WORDS: Record<string, string> = {
  bar_chart: 'bar', horizontal_bar: 'bar', hbar: 'bar', bar: 'bar',
  vertical_bar: 'column', column_chart: 'column', vbar: 'column',
  stacked_bar_chart: 'stacked_bar', stacked_column_chart: 'stacked_column', '100_stacked_bar': 'pct_stacked_bar',
  grouped_bar: 'clustered_bar', grouped_column: 'clustered_column', side_by_side_bar: 'clustered_column',
  line_chart: 'line', trend: 'line', time_series: 'line', sparkline: 'line',
  area_chart: 'area', stacked_area_chart: 'stacked_area',
  pie_chart: 'pie', doughnut: 'donut', donut_chart: 'donut', ring: 'donut',
  scatter_plot: 'scatter', scatterplot: 'scatter', bubble_chart: 'bubble',
  tree_map: 'treemap', heat_map: 'heatmap', highlight_table: 'heatmap',
  map: 'map_choropleth', filled_map: 'map_choropleth', choropleth: 'map_choropleth', region_map: 'map_choropleth',
  symbol_map: 'map_bubble', point_map: 'map_bubble', bubble_map: 'map_bubble',
  crosstab: 'pivot', matrix: 'pivot', pivot_table: 'pivot',
  text_table: 'table', grid: 'table', data_table: 'table',
  box_plot: 'boxplot', box_and_whisker: 'boxplot', bullet_graph: 'bullet', dial: 'gauge', speedometer: 'gauge',
  waterfall_chart: 'waterfall', funnel_chart: 'funnel', radar_chart: 'radar', spider: 'radar', word_cloud: 'word_cloud',
  dual_axis: 'combo', combo_chart: 'combo', bar_and_line: 'combo',
};
const KPI_WORDS = new Set(['kpi', 'card', 'big_number', 'number', 'scorecard', 'single_value', 'metric', 'indicator']);

/** An Ordinate chart id, 'kpi' for a single big number, or null for a chart Ordinate does not draw. */
export function chartTypeOf(word: string): string | null {
  const w = word.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (CHART_TYPE_IDS.has(w)) return w;
  if (KPI_WORDS.has(w)) return 'kpi';
  return CHART_WORDS[w] ?? null;
}
