import { t } from '../app/i18n';
// What `topic:save` says when a topic cannot be saved (semantic layer part 6, D14) — MAIN, through the catalog. Its own
// file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

/** Another topic of the project already has this name, ignoring case. */
export function topicNameTaken(name: string): string {
  return t('topicMessages.this_project_already_has_a_topic', { name });
}

export function topicNameMissing(): string {
  return t('topicMessages.a_topic_needs_a_name');
}

export function topicTooManyDatasets(n: number): string {
  return t('topicMessages.a_topic_holds_at_most_datasets', { n });
}

export function tooManyTopics(n: number): string {
  return t('topicMessages.a_project_holds_at_most_topics', { n });
}

/** A dataset, field, metric or term the save names that is not there (deleted, or dropped by a refresh). */
export function topicMemberGone(): string {
  return t('topicMessages.something_in_this_topic_no_longer');
}

/** `topic:get` of an id with no topic behind it. */
export function topicNotFound(): string {
  return t('topicMessages.this_topic_no_longer_exists');
}
