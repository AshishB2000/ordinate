import { t } from '../app/i18n';
// What the Columns tab says of a name the server refused — an "Also called"
// name, or a display name another column is also called — MAIN, through the catalog. Its own file so the i18n extractor
// (scripts/i18n-extract.ts MAIN_FILES) scans this sentence and nothing else.

/** A name another column of the dataset already answers to (./columnNames `aliasCollision`). */
export function alreadyCalled(alias: string, column: string): string {
  return t('columnNameMessages.is_already_what_people_call', { alias, column });
}
