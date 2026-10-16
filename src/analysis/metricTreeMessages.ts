import { t } from '../app/i18n';
// What a reader is told about a metric tree (src/ipc/metricTree.ts,
// src/ipc/metricTreeSplit.ts) — MAIN, through the catalog. Its own file so the
// i18n extractor scans only sentences.
//
// Every figure arrives already formatted: nothing here rounds or divides.

// ── Refusals and notes ───────────────────────────────────────────────────────

export function metricGone(): string {
  return t('metricTreeMessages.that_metric_no_longer_exists');
}

export function noDateColumn(metric: string): string {
  return t('metricTreeMessages.has_no_date_column_to_compare', { metric });
}

export function partGone(): string {
  return t('metricTreeMessages.a_metric_in_this_tree_was');
}

export function otherDataset(metric: string): string {
  return t('metricTreeMessages.is_on_another_dataset_so_it', { metric });
}

export function partMissing(metric: string): string {
  return t('metricTreeMessages.has_no_figure_in_one_of', { metric });
}

export function zeroDenominator(metric: string): string {
  return t('metricTreeMessages.is_divided_by_zero_in_one', { metric });
}

export function splitColumnGone(column: string): string {
  return t('metricTreeMessages.is_no_longer_a_column_of', { column });
}

export function splitNotText(column: string): string {
  return t('metricTreeMessages.is_not_a_text_column_so', { column });
}

export function splitTooMany(column: string, max: number): string {
  return t('metricTreeMessages.has_more_than_values_split_by', { column, max });
}

export function splitNoFigure(metric: string): string {
  return t('metricTreeMessages.has_no_figure_in_one_of_2', { metric });
}

export function otherSegments(count: number): string {
  return t('metricTreeMessages.other', { count });
}

export function splitBy(column: string): string {
  return `by ${column}`;
}

export function residual(): string {
  return t('metricTreeMessages.not_explained_by_its_parts');
}

// ── The headline ─────────────────────────────────────────────────────────────
// `change` is signless ("$18.4K", "1.2 pts"); `pct` signless ("11.2%").
// `lead` names the branch ("Orders", "Orders → West"); `share` its share of the
// change ("115%").

export function rose(metric: string, change: string, pct: string, compare: string): string {
  return t('metricTreeMessages.rose', { metric, change, pct, compare });
}

export function fell(metric: string, change: string, pct: string, compare: string): string {
  return t('metricTreeMessages.fell', { metric, change, pct, compare });
}

/** No percentage to give (a ratio in points, or a baseline of zero). */
export function roseBy(metric: string, change: string, compare: string): string {
  return t('metricTreeMessages.rose_2', { metric, change, compare });
}

export function fellBy(metric: string, change: string, compare: string): string {
  return t('metricTreeMessages.fell_2', { metric, change, compare });
}

export function flat(metric: string, compare: string): string {
  return t('metricTreeMessages.did_not_change', { metric, compare });
}

export function noFigure(metric: string, compare: string): string {
  return t('metricTreeMessages.has_no_figure_to_compare', { metric, compare });
}

export function leadBy(lead: string, share: string): string {
  return t('metricTreeMessages.explains_of_it', { lead, share });
}

export function leadByLedBy(lead: string, share: string, by: string): string {
  return t('metricTreeMessages.explains_of_it_led_by', { lead, share, by });
}

export function leadOnly(lead: string): string {
  return t('metricTreeMessages.most_of_it_came_from', { lead });
}
