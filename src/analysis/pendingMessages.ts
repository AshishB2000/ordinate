import { t } from '../app/i18n';
// What a pod says about a figure a newer release writes and this one keeps but cannot compute (semantic layer part 5,
// step 01) — MAIN, through the catalog. Its own file so the i18n extractor scans only sentences.

/** A funnel or period metric, or a per-account snapshot. */
export function metricKindPending(name: string): string {
  return t('pendingMessages.is_a_kind_of_metric_from', { name });
}

/** A point, hexbin or flow map of a count distinct: it plots rows, or folds counts, sums and averages per cell. `measure` is "countd of <column>". */
export function mapCountdRefused(measure: string): string {
  return t('pendingMessages.counts_distinct_values_which_a_point', { measure });
}

/** An alert rule this release keeps but cannot evaluate: a target rule, or a part-5 metric. */
export function alertPending(): string {
  return t('pendingMessages.this_alert_uses_a_figure_from');
}
