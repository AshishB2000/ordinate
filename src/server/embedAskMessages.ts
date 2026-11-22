import { t } from '../app/i18n';
// What the embedded Assistant says when it cannot answer (docs/embedded-assistant/00-design.md) — MAIN, through the
// catalog. Its own file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

export function embedAskBlank(): string {
  return t('embedAskMessages.ask_a_question_first');
}

export function embedAskUnavailable(): string {
  return t('embedAskMessages.this_assistant_is_not_available');
}

export function embedAskNotReady(): string {
  return t('embedAskMessages.the_assistant_is_not_available_right');
}

export function embedAskNoData(): string {
  return t('embedAskMessages.there_is_no_data_this_assistant');
}

export function embedAskFailed(): string {
  return t('embedAskMessages.the_assistant_could_not_answer_try');
}

export function embedAskOutside(): string {
  return t('embedAskMessages.that_question_is_outside_what_this');
}

export function embedAskLimited(): string {
  return t('embedAskMessages.too_many_questions_right_now_try');
}

// Admin → Embedding → Assistant: why a marking is refused.

export function embedAdminNeedsStore(): string {
  return t('embedAskMessages.needs_a_database_and_ordinate_master');
}

export function embedAdminNoAgent(): string {
  return t('embedAskMessages.that_assistant_is_no_longer_in');
}

export function embedAdminNoDataset(): string {
  return t('embedAskMessages.a_dataset_you_picked_is_no');
}

export function embedAdminNeedsDataset(): string {
  return t('embedAskMessages.mark_at_least_one_dataset_with');
}

export function embedAdminTooMany(max: number): string {
  return t('embedAskMessages.at_most_datasets_for_one_assistant', { max });
}

export function embedAdminColumn(dataset: string): string {
  return t('embedAskMessages.pick_a_text_column_of_it', { dataset });
}

export function embedAdminRules(dataset: string): string {
  return t('embedAskMessages.has_row_access_rules_or_is', { dataset });
}

export function embedAdminPipeline(dataset: string): string {
  return t('embedAskMessages.its_prepare_steps_compute_across_rows', { dataset });
}

export function embedAdminCaps(): string {
  return t('embedAskMessages.caps_are_whole_numbers_up_to');
}

export function embedAdminFolder(dataset: string): string {
  return t('embedAskMessages.is_in_a_team_folder_an', { dataset });
}
