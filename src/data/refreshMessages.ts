import { t } from '../app/i18n';
// What a user sees when a refresh schedule is refused or a refresh coalesces
// (L0.3, L0.4) — MAIN, through the catalog. Its own file so the i18n extractor
// (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

/** Every 5 or 15 minutes on a dataset without incremental refresh (src/data/refreshCadence.ts). */
export function fastCadenceNeedsIncremental(): string {
  return t('refreshMessages.every_5_or_15_minutes_needs');
}

/** A refresh asked for while one of the same dataset runs, here or on another server: nothing new starts. */
export function refreshAlreadyRunning(): string {
  return t('refreshMessages.this_dataset_is_already_being_refreshed');
}
