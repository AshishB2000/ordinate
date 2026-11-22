import { t } from '../app/i18n';
// Every sentence the issues board says from the server (docs/issues-board/00-design.md) — MAIN, through the catalog. Its own file so the
// i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else. The app's own title and fix for an issue
// a model has not named yet (or could not), and the words of a ticket. No model words and no figure travel as a sentence from here: a
// count is passed in by the caller, who got it from the database.

export function needsDb(): string {
  return t('issueMessages.the_issues_board_needs_the_server');
}
export function notFound(): string {
  return t('issueMessages.that_issue_was_not_found');
}
export function noOpenQuestions(): string {
  return t('issueMessages.none_of_this_issue_s_questions');
}
export function needsMasterKey(): string {
  return t('issueMessages.saving_a_tracker_token_needs_ordinate');
}
export function notConnected(provider: string): string {
  return t('issueMessages.is_not_connected_an_admin_connects', { provider });
}
export function alreadySent(provider: string): string {
  return t('issueMessages.this_issue_was_already_sent_to', { provider });
}
export function badToken(provider: string): string {
  return t('issueMessages.did_not_accept_that_token', { provider });
}
export function trackerUnreachable(provider: string): string {
  return t('issueMessages.could_not_be_reached_try_again', { provider });
}
export function ticketFailed(provider: string): string {
  return t('issueMessages.did_not_accept_the_ticket', { provider });
}
export function badSite(): string {
  return t('issueMessages.enter_your_jira_site_as_name');
}
export function noTeam(key: string): string {
  return t('issueMessages.linear_has_no_team_with_the', { key });
}
export function noJiraProject(key: string): string {
  return t('issueMessages.jira_has_no_project_with_the', { key });
}
export function noIssueType(): string {
  return t('issueMessages.that_jira_project_has_no_issue');
}

// An issue's own words, until a model names it.
export function titleName(name: string): string {
  return t('issueMessages.is_not_defined', { name });
}
export function fixName(name: string): string {
  return t('issueMessages.define_as_a_business_term_or', { name });
}
export function titleMiss(name: string): string {
  return t('issueMessages.was_not_found', { name });
}
export function fixMiss(name: string): string {
  return t('issueMessages.add_as_a_name_or_a', { name });
}
export function titleLink(names: string): string {
  return t('issueMessages.are_not_linked', { names });
}
export function fixLink(): string {
  return t('issueMessages.approve_a_link_between_these_datasets');
}
export function titleCopy(): string {
  return t('issueMessages.a_live_table_needs_a_copy');
}
export function fixCopy(): string {
  return t('issueMessages.make_a_copy_of_the_live');
}
export function titleOutside(dataset: string): string {
  return t('issueMessages.questions_about_go_to_the_wrong', { dataset });
}
export function fixOutside(dataset: string): string {
  return t('issueMessages.point_these_questions_to_an_assistant', { dataset });
}
export function titleWords(words: string): string {
  return t('issueMessages.questions_about_struggle', { words });
}
export function titleUntraced(): string {
  return t('issueMessages.answers_with_a_figure_the_app');
}
export function fixUntraced(): string {
  return t('issueMessages.add_the_metric_these_questions_need');
}
export function titleThumbs(): string {
  return t('issueMessages.answers_people_marked_as_bad');
}
export function fixThumbs(): string {
  return t('issueMessages.read_the_questions_then_add_a');
}
export function titleAgain(): string {
  return t('issueMessages.questions_people_ask_twice_in_other');
}
export function fixAgain(): string {
  return t('issueMessages.add_a_verified_answer_or_a');
}

// The words of a ticket (no question text leaves Ordinate).
export function ticketSummary(questions: number, people: number, fix: string): string {
  return t('issueMessages.assistant_questions_from_people_did_not', { questions, people, fix });
}
export function ticketLink(url: string): string {
  return t('issueMessages.open_in_ordinate_for_the_details', { url });
}
export function noPublicUrl(): string {
  return t('issueMessages.a_ticket_links_back_to_ordinate');
}
export function checkFailed(): string {
  return t('issueMessages.the_check_could_not_finish_try');
}
