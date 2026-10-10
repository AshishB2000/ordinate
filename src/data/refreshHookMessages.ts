import { t } from '../app/i18n';
// What a member sees when a refresh URL (live data L0.5, src/server/hooks/)
// cannot be made — MAIN, through the catalog. Its own file so the i18n
// extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and
// nothing else.

/** No DATABASE_URL: a refresh URL is a row in Postgres. */
export function hooksNeedDatabase(): string {
  return t('refreshHookMessages.refresh_urls_need_the_server_s');
}

/** Created through a personal API token: a leaked token must not be able to mint a credential that outlives it. */
export function hooksNeedSession(): string {
  return t('refreshHookMessages.make_a_refresh_url_from_the');
}

/** The dataset is gone (deleted, or in the Trash). */
export function hookDatasetGone(): string {
  return t('refreshHookMessages.this_dataset_no_longer_exists');
}

/** A screenshot, pasted rows or an input table: there is no source to fetch from again. */
export function hookNotRefreshable(name: string): string {
  return t('refreshHookMessages.has_no_source_to_refresh_from', { name });
}

/** At the per-dataset cap (src/server/hooks/store.ts MAX_LIVE_PER_DATASET). */
export function hookLimit(max: number): string {
  return t('refreshHookMessages.a_dataset_can_have_at_most', { max });
}

/** A connection's URL: the connection is gone (deleted, or in the Trash). */
export function hookConnectionGone(): string {
  return t('refreshHookMessages.this_connection_no_longer_exists');
}

/** At the per-connection cap (the same MAX_LIVE_PER_DATASET). */
export function hookLimitConnection(max: number): string {
  return t('refreshHookMessages.a_connection_can_have_at_most', { max });
}
