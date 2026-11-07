import { t } from '../app/i18n';
// What verified questions say (semantic layer part 3 D7) — MAIN, through the catalog. Its own file so the i18n
// extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

// ── No longer runs (../ipc/verifiedState) ────────────────────────────────────

export function verifiedDatasetGone(): string {
  return t('verifiedMessages.the_dataset_this_question_was_verified');
}

export function verifiedColumnGone(column: string, dataset: string): string {
  return t('verifiedMessages.is_no_longer_a_column_of', { column, dataset });
}

export function verifiedTermGone(): string {
  return t('verifiedMessages.a_glossary_term_this_question_uses');
}

/** A measure named by a metric that was redefined, given filters of its own, or deleted since (a retired one still runs). */
export function verifiedMetricChanged(): string {
  return t('verifiedMessages.a_metric_this_question_uses_changed');
}

// ── Saving one (../ipc/verified) ─────────────────────────────────────────────

/** A question or phrasing whose key another question or phrasing of the project holds (./verifiedRules `keyClash`). */
export function verifiedTaken(text: string): string {
  return t('verifiedMessages.is_already_a_verified_question_or', { text });
}

/** A question in the Trash whose question or a phrasing a live question now holds: it stays in the Trash. */
export function verifiedRestoreTaken(text: string): string {
  return t('verifiedMessages.it_could_not_be_restored_is', { text });
}

/** A question that is only punctuation: it has no key, so nobody could ask it. */
export function verifiedNoWords(): string {
  return t('verifiedMessages.write_the_question_in_words');
}

export function verifiedNotRead(): string {
  return t('verifiedMessages.this_answer_could_not_be_read');
}

/** The spec named everything that exists, but its card could not be drawn (a Live failure, a snapshot measure…). */
export function verifiedDoesNotDraw(reason: string): string {
  return t('verifiedMessages.this_answer_cannot_be_verified', { reason });
}

/** An edit or a delete of a question the project no longer holds. */
export function verifiedGone(): string {
  return t('verifiedMessages.this_verified_question_was_deleted');
}

/** A value filter of a question whose spec a restricted caller is not sent (D5). */
export function verifiedValuesHidden(column: string): string {
  return t('verifiedMessages.values_hidden_by_row_access_rules', { column });
}
