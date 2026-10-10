import { t } from '../app/i18n';
// What a user reads about a Live dataset's schema sync and column profile
// (docs/live-data/00-plan.md L2.5) — MAIN, through the catalog. Its own file so
// the i18n extractor scans only sentences (as ./liveQueryMessages.ts).
//
// No warehouse text ever reaches one of these: a failed describe or sample is
// logged (secrets redacted by safeError) and the reply says this instead.
// Figures are formatted BEFORE they are passed in.

/** "Sync schema" on a dataset that is not Live. */
export function liveSyncNotLive(): string {
  return t('liveProfileMessages.this_dataset_is_not_live_so');
}

/** The warehouse could not list the selection's columns: nothing was changed. */
export function liveSyncReadFailed(): string {
  return t('liveProfileMessages.the_warehouse_could_not_describe_this');
}

/** A sync of this dataset is already queued or running, here or on another server. */
export function liveSyncRunning(): string {
  return t('liveProfileMessages.this_dataset_s_schema_is_already');
}

/** The job's line in the Jobs popover. `columns` is formatted. */
export function liveSyncDone(columns: string): string {
  return t('liveProfileMessages.columns_synced', { columns });
}

/** The job's line when some columns a chart uses are gone. Both figures are formatted. */
export function liveSyncDoneMissing(columns: string, missing: string): string {
  return t('liveProfileMessages.columns_synced_missing_from_the', { columns, missing });
}

/** The estimate said the sample would bill more than a live query may. */
export function liveSampleTooCostly(): string {
  return t('liveProfileMessages.no_sample_was_read_the_warehouse');
}

/** The sample query failed or timed out. */
export function liveSampleFailed(): string {
  return t('liveProfileMessages.the_columns_were_synced_but_the');
}

/** A picker asked for the values of a column of a Live dataset no schema sync has profiled yet. */
export function liveValuesNotSynced(): string {
  return t('liveProfileMessages.this_live_dataset_has_not_been');
}

/** …of a column the last sample never measured: no sample was read, or the column is newer than it. */
export function liveValuesNotSampled(): string {
  return t('liveProfileMessages.the_last_schema_sync_read_no');
}

/** …of a column a list is never kept for: a number, a date, or text with more than `limit` (formatted) values. */
export function liveValuesNotListed(limit: string): string {
  return t('liveProfileMessages.the_values_of_this_column_are', { limit });
}

/** A live query limit (the daily limit, or the size cap) refused the sample. */
export function liveSampleRefused(): string {
  return t('liveProfileMessages.the_columns_were_synced_but_a');
}
