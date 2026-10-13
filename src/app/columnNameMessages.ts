import { t } from '../app/i18n';
// What the Columns tab says under an "Also called" name the server refused —
// MAIN, through the catalog. Its own file so the i18n extractor
// (scripts/i18n-extract.ts MAIN_FILES) scans this sentence and nothing else.

/** An "Also called" name another column of the dataset already answers to (./columnNames `aliasCollision`). */
export function alreadyCalled(alias: string, column: string): string {
  return t('columnNameMessages.is_already_what_people_call', { alias, column });
}
