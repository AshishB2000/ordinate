import { t } from '../app/i18n';
// What a person reads about row access rules (docs/row-policy/00-design.md,
// "Refusals") — MAIN, through the catalog. Its own file so the i18n extractor
// scans only sentences. Fixed sentences: a refusal never names another team,
// person or value, and the RPC route recognises a caught refusal by its sentence.

/** No rule names the caller or a team they are in (or every value was blank). */
export function rowNoneMessage(): string {
  return t('rowAccessMessages.you_don_t_have_access_to');
}

/** The rule column is gone, not text, or missing from the warehouse. */
export function rowColumnMessage(): string {
  return t('rowAccessMessages.this_dataset_s_row_access_rules');
}

/** Stored cross-row values, a parameter in the steps, or a changed writer of the rule column. */
export function rowPipelineMessage(): string {
  return t('rowAccessMessages.this_dataset_stores_values_computed');
}

/** A reader that is not one of the locked doors. */
export function rowReaderMessage(): string {
  return t('rowAccessMessages.this_reads_the_whole_dataset_and');
}

/** A column or label reached through a relationship. */
export function rowRelatedMessage(): string {
  return t('rowAccessMessages.this_question_reaches_a_related_dataset');
}

/** An as-of read. */
export function rowAsOfMessage(): string {
  return t('rowAccessMessages.looking_at_past_data_is_off');
}

/** Publish, embed, subscription, alert. */
export function rowFanOutMessage(): string {
  return t('rowAccessMessages.this_reads_a_dataset_with_row');
}

/** An export by a restricted caller. */
export function rowExportMessage(): string {
  return t('rowAccessMessages.exports_are_off_for_datasets_with');
}

/** A dataset with no rules of its own, built from one that has them. */
export function rowDerivedMessage(): string {
  return t('rowAccessMessages.this_dataset_is_built_from_a');
}

/** Rules need the user directory. */
export function rowNeedsDatabaseMessage(): string {
  return t('rowAccessMessages.row_access_rules_need_the_server');
}

/** A rule names someone who is not a user or team of this organization. */
export function rowUnknownMemberMessage(): string {
  return t('rowAccessMessages.a_rule_names_someone_who_is');
}

/** The chosen column is not a text column of the dataset. */
export function rowBadColumnMessage(): string {
  return t('rowAccessMessages.pick_a_text_column_of_this');
}

/** A rule's values are missing or invalid. */
export function rowBadValuesMessage(): string {
  return t('rowAccessMessages.each_rule_needs_at_least_one');
}

/** The record holding the rules could not be read: closed until it can be. */
export function rowUnreadableMessage(): string {
  return t('rowAccessMessages.the_row_access_rules_of_this');
}
