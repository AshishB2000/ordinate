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

// ── Planning an import (a2) ──────────────────────────────────────────────────

/** A metric or term whose dataset differs in the files: a definition never moves between datasets. */
export function modelDatasetMoved(): string {
  return t('modelFileMessages.this_definition_is_on_another_dataset');
}

/** An upload token that has expired, was used already, or is not the caller's: files are uploaded again for each run. */
export function modelUploadExpired(): string {
  return t('modelFileMessages.that_upload_has_expired_or_was');
}

/** A metric file whose definition another tool's semantic layer owns (D13): mirrors stay with their layer. */
export function modelExternalMetric(name: string): string {
  return t('modelFileMessages.is_defined_in_another_tool_s', { name });
}

/** A metric whose definition, format or target the store would cut or drop on save (metric:save's contract refuses it). */
export function modelMetricOutOfBounds(name: string): string {
  return t('modelFileMessages.can_t_be_imported_as_the', { name });
}

// ── Applying an import (a3) ──────────────────────────────────────────────────

/** The plan's hash moved since the dry run: nothing is written. */
export function modelPlanChanged(): string {
  return t('modelFileMessages.this_project_changed_since_the_dry');
}

/** One object was edited in this project after the dry run: it is not written, the rest are. */
export function modelObjectMoved(): string {
  return t('modelFileMessages.this_was_changed_in_the_project');
}

/** One object's write failed for a reason that is not its own (the log has it): the rest are written. */
export function modelWriteFailed(): string {
  return t('modelFileMessages.this_could_not_be_written_check');
}

// ── Importing dbt definitions (f1) ───────────────────────────────────────────

/** A JSON upload past the value budget or 32 MiB: a full manifest.json, which holds the whole project. */
export function dbtUseSemanticManifest(): string {
  return t('modelFileMessages.upload_target_semantic_manifest_json');
}

/** An upload that is neither a model zip nor JSON holding dbt's semantic models and metrics. */
export function dbtNotAManifest(): string {
  return t('modelFileMessages.this_file_is_neither_model_files');
}

/** More semantic models or metrics than one dry run reads. */
export function dbtTooMany(): string {
  return t('modelFileMessages.this_semantic_manifest_defines_more_than');
}
