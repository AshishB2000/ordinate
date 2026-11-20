// Slack's `data_visualization` block, used ONLY when the result fits exactly (docs/slack/00-design.md, "Charts"; the block's
// reference page read 2026-11-14 and again 2026-11-19). No forced fits: no stacking Slack cannot draw, no "Other" bucket the
// engine never computed. Anything else is a table plus Open in Ordinate (./render.ts). Every number is the card's own: this
// only arranges them. The block has no alt-text field, so the sentence always stays beside it.
//
//   Ordinate chart                      Slack chart
//   column, clustered_column            bar (bars grouped by label)
//   line, line_markers                  line
//   area (single or overlapping)        area (layered, first series at the back)
//   pie, donut, every value above 0     pie
//   anything else (stacked_*, pct_stacked_*, scatter, maps, gauge, treemap, funnel, …)   none
//
// Used only when: at most 12 series (or 12 pie segments); at most 20 points per series, one for every category; category,
// series and segment labels unique after Slack's 20-character limit; a title within 50 characters.

import type { Card } from './ask';

const KIND: Readonly<Record<string, 'bar' | 'line' | 'area' | 'pie'>> = {
  column: 'bar', clustered_column: 'bar', line: 'line', line_markers: 'line', area: 'area', pie: 'pie', donut: 'pie',
};
export const MAX_SERIES = 12;
export const MAX_POINTS = 20;
export const MAX_LABEL = 20;
export const MAX_TITLE = 50;

interface Data { labels: unknown[]; series: Array<{ name: unknown; values: unknown[] }> }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Labels as Slack takes them (strings, at most 20 characters), or null when one is empty or two collide once cut. */
function cut(raw: readonly unknown[]): string[] | null {
  const out = raw.map((x) => String(x ?? '').slice(0, MAX_LABEL));
  return out.every((s) => s !== '') && new Set(out).size === out.length ? out : null;
}

/** The block for `card`, or null when it does not fit exactly (the caller posts the table). */
export function chartBlock(card: Card | null): Record<string, unknown> | null {
  const kind = card && !('kind' in card && card.kind === 'sql') ? KIND[String(card.chartType ?? (card.spec as { chartType?: unknown } | undefined)?.chartType ?? '')] : undefined;
  const data = card?.data as Data | undefined;
  const title = typeof card?.title === 'string' ? card.title : '';
  if (!kind || !data || !Array.isArray(data.labels) || !Array.isArray(data.series) || !title || title.length > MAX_TITLE) return null;
  const labels = cut(data.labels);
  if (!labels || !labels.length || labels.length > MAX_POINTS || !data.series.length || data.series.length > MAX_SERIES) return null;
  if (data.series.some((s) => !Array.isArray(s.values) || s.values.length !== labels.length || !s.values.every(finite))) return null; // one number per category, none missing

  if (kind === 'pie') {
    if (labels.length > MAX_SERIES || data.series.length !== 1 || !data.series[0].values.every((v) => (v as number) > 0)) return null; // a pie is one series of at most 12 segments; a zero or negative slice has no share
    return {
      type: 'data_visualization', title,
      chart: { type: 'pie', segments: labels.map((label, i) => ({ label, value: data.series[0].values[i] })) },
    };
  }
  const names = cut(data.series.map((s) => s.name));
  if (!names) return null;
  return {
    type: 'data_visualization', title,
    chart: {
      type: kind,
      series: data.series.map((s, i) => ({ name: names[i], data: labels.map((label, j) => ({ label, value: s.values[j] })) })),
      axis_config: { categories: labels },
    },
  };
}

/** The blocks to put in the message for `card` (at most one chart: Slack allows two per message), or null for the table. */
export function chartBlocks(card: Card | null): unknown[] | null {
  const b = chartBlock(card);
  return b ? [b] : null;
}
