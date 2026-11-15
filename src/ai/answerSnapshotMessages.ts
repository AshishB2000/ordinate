import { t } from '../app/i18n';
// What `answer:refresh` says when it cannot draw an answer again (../ipc/answerSnapshots) — MAIN, through the
// catalog. Its own file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

/** The turn named is not one of the caller's answers: an unknown id, another member's conversation, or deleted since. */
export function answerNotThere(): string {
  return t('answerSnapshotMessages.that_answer_is_no_longer_there');
}

/** A refresh that failed with no reason of its own. */
export function answerNotRefreshed(): string {
  return t('answerSnapshotMessages.could_not_refresh_this_answer');
}
