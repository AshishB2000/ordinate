import { t } from '../app/i18n';
// What the column access setter says when it refuses (semantic layer part 4, step 07) — MAIN, through the catalog.
// Its own file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.
// A name here is a column of the dataset, shown to the admin who typed it; no sentence names a team or a user.

/** Column rules need the user directory (as row rules do). */
export function columnNeedsDatabase(): string {
  return t('columnAccessMessages.column_access_rules_need_the_server');
}

export function columnNotInDataset(column: string): string {
  return t('columnAccessMessages.is_not_a_column_of_this', { column });
}

export function columnTwice(column: string): string {
  return t('columnAccessMessages.has_more_than_one_rule_give', { column });
}

/** A rule on a carrier names someone its source column hides it from. */
export function carrierWider(column: string, from: string): string {
  return t('columnAccessMessages.is_computed_from_so_only_people', { column, from });
}

export function tooManyColumns(max: string): string {
  return t('columnAccessMessages.a_dataset_can_hide_at_most', { max });
}
