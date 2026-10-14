import { t } from '../app/i18n';
import { MAX_ALIASES } from './columnNames';
// What the Columns tab says of a name the server refused — an "Also called"
// name, or a display name another column is also called — MAIN, through the catalog. Its own file so the i18n extractor
// (scripts/i18n-extract.ts MAIN_FILES) scans this sentence and nothing else.

/** A name another column of the dataset already answers to (./columnNames `aliasCollision`). */
export function alreadyCalled(alias: string, column: string): string {
  return t('columnNameMessages.is_already_what_people_call', { alias, column });
}

/** "Remember" on an answer card, for a column whose "Also called" list is full (./catalog `setColumn` with `addAlias`). */
export function tooManyNames(column: string): string {
  const count = String(MAX_ALIASES);
  return t('columnNameMessages.already_has_other_names', { column, count });
}
