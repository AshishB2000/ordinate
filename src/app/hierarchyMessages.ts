import { t } from '../app/i18n';
// What `catalog:setTable` says when a hierarchy would mislead — MAIN, through the catalog. Its own file so the i18n
// extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

/** A level the dataset has no column for. */
export function hierarchyLevelMissing(column: string): string {
  return t('valueLabelMessages.is_not_a_column_of_this', { column });
}

/** A level that is not a text column (numbers bin, dates drill by themselves). */
export function hierarchyLevelNotText(column: string, type: string): string {
  return t('hierarchyMessages.hierarchy_levels_are_text_columns_is', { column, type });
}

/** A column in a hierarchy already (this one or another). */
export function hierarchyColumnTaken(column: string, name: string): string {
  return t('hierarchyMessages.is_already_a_level_of_a', { column, name });
}

/** Two hierarchies of one dataset with one name. */
export function hierarchyNameTaken(name: string): string {
  return t('hierarchyMessages.this_dataset_already_has_a_hierarchy', { name });
}
