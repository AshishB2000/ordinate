import { t } from '../app/i18n';
// What a person reads on a chart whose measures come from the many sides of its relationships (semantic
// layer part 8, D13 and D11) — MAIN, through the catalog. Its own file so the i18n extractor
// (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else. Names arrive formatted:
// quoted and comma-joined by the caller, never a list built for the locale.

/** D13 row 1: the category or split is on a many side, so a one-side row would sit in several groups. */
export function fanOutManySide(field: string, dataset: string, primary: string): string {
  return t('fanOutMessages.the_category_or_split_comes_from', { field, dataset, primary });
}

/** D13 row 2: the category, split or a filter is not on the path the many side shares with the chart's dataset. */
export function fanOutOffPath(field: string, dataset: string, primary: string): string {
  return t('fanOutMessages.is_not_on_the_path_shares', { field, dataset, primary });
}

/** D13 row 3: each question keeps its own top 50 or bin range, so the axes cannot be lined up. */
export function fanOutOneAxis(): string {
  return t('fanOutMessages.measures_from_several_tables_cannot_be');
}

/** D13 row 4: a pivot, cohort, funnel, small multiples, map, key drivers or raw points over several tables. */
export function fanOutShape(): string {
  return t('fanOutMessages.measures_from_several_tables_can_only');
}

/** The tile's note: these measures are computed on their own table's rows (`names` quoted and comma-joined). */
export function fanOutOwnRows(names: string): string {
  return t('fanOutMessages.counted_on_their_own_table_s', { names });
}

/** The tile's note: a filter that reaches only some measures (`names` quoted and comma-joined). */
export function fanOutNarrows(column: string, names: string): string {
  return t('fanOutMessages.narrows_only', { column, names });
}

/** The tile's note: a filter no measure of this chart can reach. */
export function fanOutNarrowsNone(column: string): string {
  return t('fanOutMessages.narrows_none_of_these_measures', { column });
}
