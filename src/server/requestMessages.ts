// Every sentence dashboard requests show or send (docs/team-folders/00-design.md, "Dashboard requests";
// ./requests/) — MAIN, through the catalog. Its own file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES)
// scans these sentences and nothing else. Names, titles and figures arrive formatted.

import { t } from '../app/i18n';

/** Asking for a dashboard on a server with no user directory. */
export function requestsOff(): string {
  return t('requestMessages.dashboard_requests_need_the_user');
}

/** A turn that is not one of the caller's answers (someone else's, a question, a missing one): the same words for each. */
export function notYourAnswer(): string {
  return t('requestMessages.that_answer_is_not_in_one');
}

/** An answer with no chart form: an SQL answer, or one read straight from a warehouse table. */
export function notAChart(): string {
  return t('requestMessages.only_answers_drawn_as_a_chart');
}

/** An answer whose dataset is gone. */
export function datasetGone(): string {
  return t('requestMessages.the_dataset_one_of_these_answers');
}

/** Nobody who edits every dataset the charts read, other than the requester. */
export function noApprovers(): string {
  return t('requestMessages.no_editor_of_this_data_can');
}

/** The requester's day is used up. */
export function tooManyRequests(max: number): string {
  return t('requestMessages.you_can_ask_for_dashboards_a', { max });
}

/** A request id that is not there (another project's, or never made). */
export function requestGone(): string {
  return t('requestMessages.that_dashboard_request_is_no_longer');
}

/** Approving or declining a request someone already decided. */
export function alreadyDecided(): string {
  return t('requestMessages.this_request_was_already_decided');
}

/** Another approver's approval is under way. */
export function beingApproved(): string {
  return t('requestMessages.someone_is_approving_this_request_right');
}

/** A chart of the request the engine cannot draw now: nothing is made. */
export function chartNotDrawn(title: string, reason: string): string {
  return t('requestMessages.can_t_be_drawn_now_so', { title, reason });
}

/** Saving the dashboard or one of its charts failed. */
export function notMade(): string {
  return t('requestMessages.could_not_make_the_dashboard');
}

/** Where a dashboard lands when no folder restricts its data. */
export function everyoneFolder(): string {
  return t('requestMessages.everyone_in_the_project');
}

/** The approvers' email title, one chart. */
export function askedForDashboardOne(by: string, title: string): string {
  return t('requestMessages.asked_for_a_dashboard_1_chart', { by, title });
}

/** The approvers' email title, `count` charts (formatted). */
export function askedForDashboard(by: string, title: string, count: string): string {
  return t('requestMessages.asked_for_a_dashboard_charts', { by, title, count });
}

/** The requester's email title, approved. */
export function dashboardReady(title: string): string {
  return t('requestMessages.your_dashboard_is_ready', { title });
}

/** The requester's email title, declined. */
export function requestDeclined(title: string): string {
  return t('requestMessages.your_dashboard_request_was_declined', { title });
}

/** Why someone has a request email, under it. */
export function requestEmailReason(): string {
  return t('requestMessages.you_get_this_email_because_you');
}
