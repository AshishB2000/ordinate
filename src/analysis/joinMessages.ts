import { t } from '../app/i18n';
// What a person reads when a chart names a join (a relationship) that cannot be used, or a join's
// name is taken (semantic layer, PR 09) — MAIN, through the catalog. Its own file so the i18n
// extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

/** A `via` names a relationship the project no longer has (deleted, or a template from another project). */
export function viaGone(): string {
  return t('joinMessages.a_relationship_this_chart_joins_through');
}

/** A `via` beside a dataset id whose relationship reaches another dataset. */
export function viaElsewhere(join: string, dataset: string): string {
  return t('joinMessages.does_not_lead_to', { join, dataset });
}

/** A `via` reference whose column the relationship's table does not have. */
export function viaNoColumn(join: string, column: string): string {
  return t('joinMessages.has_no_column', { join, column });
}

/** A relationship saved under a name another relationship between the same two datasets already has. */
export function labelTaken(label: string): string {
  return t('joinMessages.another_relationship_between_these_two', { label });
}
