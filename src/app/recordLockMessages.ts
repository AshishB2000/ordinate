import { t } from '../app/i18n';
// What a save says when its record lock (./recordFs.ts `locked`) could not
// help it — MAIN, through the catalog. Its own file so the i18n extractor
// (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

/** Another save of the same record held it past the lock wait (Postgres 55P03 / 40P01, or the in-process queue). */
export function recordBusy(): string {
  return t('recordLockMessages.this_is_being_saved_by_someone');
}

/** A record body over RECORD_MAX_BYTES (./bundleRules.ts): never stored. */
export function recordTooLarge(): string {
  return t('recordLockMessages.this_is_too_large_to_save');
}

/** A statement inside the locked save failed and was swallowed: Postgres rolled the whole save back. */
export function recordNotSaved(): string {
  return t('recordLockMessages.this_could_not_be_saved_try');
}
