import { t } from '../app/i18n';
// What a user reads about a dataset's incremental refresh settings
// (src/data/incrementalSettings.ts) — MAIN, through the catalog. Its own file
// so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these
// sentences and nothing else.

/** Not imported from a connection: a file, a paste, a query over datasets has no source to ask for new rows. */
export function incrementalNeedsConnection(): string {
  return t('incrementalMessages.only_a_dataset_imported_from_a');
}

/** A Live dataset keeps no copy, so there is nothing to refresh, incrementally or not. */
export function incrementalNotForLive(): string {
  return t('incrementalMessages.a_live_dataset_is_asked_at');
}

/** The connection the dataset was imported from has been deleted. */
export function incrementalConnectionGone(): string {
  return t('incrementalMessages.the_connection_this_dataset_was_imported');
}

/** No number or date column: nothing can serve as the cursor. */
export function incrementalNoCursorColumn(): string {
  return t('incrementalMessages.this_dataset_has_no_number_or');
}

/** The source cannot take the cursor predicate, so every "incremental" run would read all of it. */
export function incrementalCannotPush(source: string): string {
  return t('incrementalMessages.cannot_filter_by_a_column_so', { source });
}

/** The cursor named is not a number or date column of the stored table. */
export function incrementalPickCursor(): string {
  return t('incrementalMessages.pick_a_number_or_date_column');
}

/** Update-by-key mode without a key column of the table. */
export function incrementalPickKey(): string {
  return t('incrementalMessages.pick_the_column_whose_value_identifies');
}

/** Append mode with a key column: the two contradict each other. */
export function incrementalAppendNoKey(): string {
  return t('incrementalMessages.append_mode_adds_new_rows_and');
}

/** A lookback below zero or beyond any real window (the contract refuses it first). */
export function incrementalLookbackRange(): string {
  return t('incrementalMessages.the_lookback_must_be_zero_or');
}

/** The settings could not be read (the record is missing or unreadable). */
export function incrementalNotRead(): string {
  return t('incrementalMessages.could_not_read_the_incremental_refresh');
}

/** The settings could not be written (the record is missing or unreadable). */
export function incrementalNotSaved(): string {
  return t('incrementalMessages.could_not_save_the_incremental_refresh');
}
