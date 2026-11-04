import { t } from '../app/i18n';
// What a person reads when a glossary term cannot be applied (semantic layer, PR 05a) — MAIN,
// through the catalog. Its own file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES)
// scans these sentences and nothing else.

/** A filter step this pod cannot read, kept as it was (a newer release wrote it). */
export function termUnreadable(): string {
  return t('termMessages.this_figure_uses_a_filter_from');
}

/** A term step that reached an engine no door had expanded. */
export function termNotExpanded(): string {
  return t('termMessages.a_glossary_term_reached_the_engine');
}
