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
