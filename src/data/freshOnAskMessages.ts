import { t } from '../app/i18n';
// What a user reads about fresh on ask (docs/live-data/00-plan.md L3.1) —
// MAIN, through the catalog. Its own file so the i18n extractor
// (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

/** Fresh on ask asked for on a dataset whose incremental refresh is off (src/data/freshOnAskRule.ts). */
export function freshOnAskNeedsIncremental(): string {
  return t('freshOnAskMessages.fresh_on_ask_needs_incremental_refresh');
}

/** A Live dataset is asked at the warehouse every time; it has no copy to keep fresh. */
export function freshOnAskNotForLive(): string {
  return t('freshOnAskMessages.a_live_dataset_is_asked_at');
}

/** An age outside 1 minute – 1 day. */
export function freshOnAskRange(): string {
  return t('freshOnAskMessages.fresh_on_ask_takes_an_age');
}

/** The record could not be written (missing, unreadable). */
export function freshOnAskNotSet(): string {
  return t('freshOnAskMessages.could_not_change_fresh_on_ask');
}

/**
 * An incremental-only refresh (a pull on ask) found that the next run must be a
 * full one, and did nothing. `reason` is incrementalRefresh.fullReason's line.
 */
export function freshOnAskSkippedFull(reason: string): string {
  return t('freshOnAskMessages.fresh_on_ask_pulls_only_new', { reason });
}

/** An incremental-only refresh of a dataset with no incremental refresh (not opted in, or not a connection). */
export function freshOnAskSkippedNotIncremental(): string {
  return t('freshOnAskMessages.fresh_on_ask_pulls_only_new_2');
}
