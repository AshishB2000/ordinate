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

/** A Live dataset's base filters hold a step this release cannot read: part of a list must never travel as all of it. */
export function modelFiltersUnreadable(name: string): string {
  return t('modelFileMessages.has_always_applied_filters_this_version', { name });
}

// ── Reading an upload (a2) ───────────────────────────────────────────────────

/** No model.json, one that is not JSON, or another format: the whole upload is refused. */
export function modelNotAModel(): string {
  return t('modelFileMessages.this_is_not_a_model_export');
}

/** A formatVersion past this release's: the whole upload is refused. */
export function modelTooNew(version: string): string {
  return t('modelFileMessages.these_model_files_use_format_from', { version });
}

/** Every entry's JSON values together, past the value budget (src/app/jsonBudget.ts). */
export function modelTooManyValues(): string {
  return t('modelFileMessages.the_model_files_hold_more_values');
}

/** One object that is not JSON, not an object, or has a value of the wrong type or length: that item only. */
export function modelObjectUnreadable(): string {
  return t('modelFileMessages.ordinate_can_t_read_this_file');
}

/** A dataset's guide past part 1's 8,000 characters: refused, never cut. */
export function modelGuideTooLong(): string {
  return t('modelFileMessages.this_guide_is_longer_than_8');
}

/** A second file with an id another file already has. */
export function modelDuplicateId(): string {
  return t('modelFileMessages.another_file_in_the_model_has');
}
