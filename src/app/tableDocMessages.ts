import { t } from '../app/i18n';
// What the table docs' channels say when they refuse — MAIN, through the catalog. Its own file so the i18n
// extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

/** A key the dataset has no column for (`catalog:setTable`, `catalog:checkKey`). */
export function keyNotAColumn(key: string): string {
  return t('tableDocMessages.is_not_a_column_of_this', { key });
}

/** "Check now" with no key picked. */
export function noKeyToCheck(): string {
  return t('tableDocMessages.pick_the_key_column_first');
}

/** The count itself failed, on an extract, in both engines. A Live failure has its own typed sentence. */
export function keyCheckFailed(): string {
  return t('tableDocMessages.the_key_could_not_be_counted');
}
