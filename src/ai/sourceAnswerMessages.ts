import { t } from '../app/i18n';
// What an answer straight from a source table, keeping it, and a missing link say (docs/assistant/00-design.md,
// outcomes C and E) — MAIN, through the catalog. Its own file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES)
// scans these sentences and nothing else.

/** An editor's answer named a table on a connection that is not asked live (a production database, a SaaS app). */
export function copyFirst(table: string): string {
  return t('sourceAnswerMessages.is_on_a_connection_ordinate_does', { table });
}

/** A documented table whose columns no facts read has stored yet: there is nothing to answer from. */
export function tableNotRead(table: string): string {
  return t('sourceAnswerMessages.ordinate_has_not_read_the_columns', { table });
}

/** The provenance line of a card answered from a source table. */
export function tableNote(): string {
  return t('sourceAnswerMessages.warehouse_table_not_a_dataset_computed');
}

/** Save as visual (or Verify) on an answer still read straight from its table. */
export function keepFirst(): string {
  return t('sourceAnswerMessages.keep_this_answer_as_a_dataset');
}

/** Keep as a dataset on a turn that is not (or no longer) a source table's answer. */
export function notFromTable(): string {
  return t('sourceAnswerMessages.this_answer_is_not_read_straight');
}

/** A filter's list of values on a warehouse table explored with no dataset (Explore, phase D): the view has no sample. */
export function tableValuesOnKeep(): string {
  return t('sourceAnswerMessages.a_warehouse_table_has_no_list');
}

/** Outcome E for a viewer, or for a pair the app cannot check: the reason Ask an editor carries (`link`). */
export function cannotCombine(): string {
  return t('sourceAnswerMessages.these_can_t_be_combined_yet');
}

/** Outcome E for an editor: the checked link the card proposes. */
export function linkProposed(from: string, to: string): string {
  return t('sourceAnswerMessages.has_no_link_to_yet_so', { from, to });
}
