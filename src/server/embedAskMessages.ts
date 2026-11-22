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
