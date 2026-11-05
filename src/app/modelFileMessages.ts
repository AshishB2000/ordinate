import { t } from '../app/i18n';
// What the model files' channels say when they refuse (semantic layer part 7: ./modelFormat.ts,
// src/ipc/modelFiles.ts) — MAIN, through the catalog. Its own file so the i18n extractor
// (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else. A name passed in is
// already cut and stripped of control characters by the zip reader.

/** Export and import both: the files hold term values and value labels a row access rule withholds (D7). */
export function modelRestricted(): string {
  return t('modelFileMessages.your_access_to_this_project_is');
}

/** A zip entry outside the model files' whitelist (D2): the whole upload is refused. */
export function modelEntryRefused(name: string): string {
  return t('modelFileMessages.the_model_files_hold_a_file', { name });
}
