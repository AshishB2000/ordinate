import { t } from '../app/i18n';
// What a user reads about a Live dataset (docs/live-data/00-plan.md L2.1) —
// MAIN, through the catalog. Its own file so the i18n extractor scans only
// sentences: the refusal every reader not yet built for Live answers with
// (D6), and the create / switch flow's own refusals.

/** The one refusal: a feature that reads rows met a dataset that has none here. */
export function liveRefusedMessage(): string {
  return t('liveMessages.this_is_a_live_dataset_this');
}

/** Live needs a connection to ask: a file, a paste or a query over datasets has none. */
export function liveNeedsConnectionMessage(): string {
  return t('liveMessages.only_a_dataset_imported_from_a');
}

/** The connector declares no live dialect (plan D2). */
export function liveNotOfferedMessage(): string {
  return t('liveMessages.this_source_can_t_answer_questions');
}

/** A prepare pipeline is extract-only in v1, and dropping it silently would change what the columns mean. */
export function liveHasStepsMessage(): string {
  return t('liveMessages.remove_this_dataset_s_prepare_steps');
}

/** Switching to Live deletes the stored copy, so the caller must say it means it. */
export function liveConfirmDropMessage(): string {
  return t('liveMessages.switching_to_live_deletes_the_stored');
}

/** The warehouse described nothing to store. */
export function liveNoColumnsMessage(): string {
  return t('liveMessages.the_source_returned_no_columns_for');
}

/** Column names are how a Live query names what it reads, so two alike cannot be told apart. */
export function liveDuplicateColumnMessage(name: string): string {
  return t('liveMessages.two_columns_are_named_rename_one', { name });
}

/** The dataset's connection is gone, so there is nothing to ask. */
export function liveConnectionGoneMessage(): string {
  return t('liveMessages.the_connection_this_dataset_reads_from');
}

/** A cache age outside 0 s – 30 days (plan D5). */
export function liveCacheAgeRangeMessage(): string {
  return t('liveMessages.the_cache_age_must_be_between');
}

/**
 * Live on this connector is opt-in per connection (plan D8, L3.2) and this
 * connection has not opted in. `label` is the checkbox's own label.
 */
export function liveNeedsOptInMessage(label: string): string {
  return t('liveMessages.live_is_off_for_this_connection', { label });
}

/** Unticking the opt-in while Live datasets still ask the connection. `count` is `n`, formatted. */
export function liveOptInInUseMessage(n: number, count: string, label: string): string {
  if (n === 1) return t('liveMessages.one_live_dataset_asks_this_connection', { label });
  return t('liveMessages.live_datasets_ask_this_connection_switch', { count, label });
}

/** The connection's connector has no Live opt-in to tick. */
export function liveNoOptInMessage(): string {
  return t('liveMessages.this_connection_has_no_read_replica');
}
