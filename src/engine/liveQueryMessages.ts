import { t } from '../app/i18n';
// What a viewer reads when a Live question was not answered by the warehouse
// (docs/live-data/00-plan.md L2.3, D6, R-L6) — MAIN, through the catalog. Its
// own file so the i18n extractor scans only sentences (as ./liveRefusals.ts).
//
// No warehouse text ever reaches one of these. A warehouse error can quote the
// statement, the defining query, a table or a host, so the viewer reads a
// sentence from here and the server log gets the reason, secrets redacted.
// Figures are formatted BEFORE they are passed in.

/** The warehouse failed and nothing was cached to fall back on. */
export function liveWarehouseFailed(): string {
  return t('liveQueryMessages.the_warehouse_could_not_answer_this');
}

/** LIVE_QUERY_TIMEOUT_MS ran out and nothing was cached. `seconds` is formatted. */
export function liveWarehouseTimeout(seconds: string): string {
  return t('liveQueryMessages.the_warehouse_took_longer_than_seconds', { seconds });
}

/** The caller hung up first (nobody reads it, but a reply is still typed). */
export function liveCancelled(): string {
  return t('liveQueryMessages.the_question_was_cancelled_before_the');
}

/** A result past the live row cap: drawing part of it would be a wrong chart. `limit` is formatted. */
export function liveTooManyGroups(limit: string): string {
  return t('liveQueryMessages.the_warehouse_answered_with_more_than', { limit });
}

/** The executor was handed an extract dataset. */
export function liveNotLive(): string {
  return t('liveQueryMessages.this_dataset_is_not_live_so');
}

/** The dataset record is gone. */
export function liveDatasetMissing(): string {
  return t('liveQueryMessages.this_dataset_no_longer_exists');
}

/** LIVE_DAILY_QUERY_LIMIT is used up for today and nothing was cached (L2.7). `limit` is formatted. */
export function liveDailyLimit(limit: string): string {
  return t('liveQueryMessages.this_organization_has_used_today_s', { limit });
}
