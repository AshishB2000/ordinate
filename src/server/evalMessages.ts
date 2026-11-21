import { t } from '../app/i18n';
// Every sentence evaluation suites say from the server (docs/eval-suites/00-design.md) — MAIN, through the catalog. Its own file so the
// i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else. A reason a case failed is a CODE the page
// words (src/ai/evalChecks.ts CheckCode): no model words and no figure ever travel as a sentence from here.

export function needsDb(): string {
  return t('evalMessages.evaluation_suites_need_the_server_s');
}
export function notReady(): string {
  return t('evalMessages.running_tests_needs_an_ai_model');
}
export function notFound(): string {
  return t('evalMessages.that_suite_case_or_run_was');
}
export function tooManySuites(max: string): string {
  return t('evalMessages.a_project_holds_at_most_suites', { max });
}
export function suiteFull(max: string): string {
  return t('evalMessages.a_suite_holds_at_most_test', { max });
}
export function suiteBusy(): string {
  return t('evalMessages.this_suite_has_a_run_going');
}
export function alreadyRunning(): string {
  return t('evalMessages.a_test_run_is_already_going');
}
export function emptySuite(): string {
  return t('evalMessages.add_a_test_case_before_running');
}
export function agentNotYours(): string {
  return t('evalMessages.you_cannot_use_that_assistant_so');
}
export function badCase(): string {
  return t('evalMessages.a_test_case_needs_a_question');
}
export function sqlQuestion(): string {
  return t('evalMessages.a_question_answered_with_sql_cannot');
}
export function noChart(): string {
  return t('evalMessages.that_answer_has_no_chart_to');
}
export function dataClosed(): string {
  return t('evalMessages.you_cannot_open_the_data_this');
}
export function notResumable(): string {
  return t('researchMessages.this_run_cannot_be_resumed');
}
export function judgeNotEnabled(): string {
  return t('evalMessages.that_model_is_not_enabled_in');
}
export function couldNotRate(): string {
  return t('evalMessages.that_answer_could_not_be_rated');
}
export function inboxGone(): string {
  return t('evalMessages.that_question_is_no_longer_in');
}
export function questionMissing(): string {
  return t('evalMessages.the_question_that_came_with_this');
}
