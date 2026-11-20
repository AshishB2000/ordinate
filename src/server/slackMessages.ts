import { t } from '../app/i18n';
// Every sentence Ordinate says in Slack (docs/slack/00-design.md) — MAIN, through the catalog. Its own file so the i18n
// extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else. Figures and names arrive
// formatted. A note about a refused or private answer is FIXED text: no model words, no figures, no names of data.

/** The placeholder, posted while the answer is made. */
export function working(): string {
  return t('slackMessages.working_on_it');
}

/** A channel no project admin has tied to an agent: never a guess at a project. */
export function notConnected(): string {
  return t('slackMessages.i_am_not_connected_to_an');
}

/** The channel's note when the answer could not be posted there. */
export function sentPrivately(): string {
  return t('slackMessages.i_sent_you_the_answer_privately');
}

/** The private message that carries the full answer, above it. */
export function privateIntro(): string {
  return t('slackMessages.here_is_the_answer_to_your');
}

/** The first words of a Connect prompt (the button follows). */
export function connectPrompt(): string {
  return t('slackMessages.to_answer_i_need_to_know');
}

/** The Connect button's label. */
export function connectButton(): string {
  return t('slackMessages.connect_to_ordinate');
}

/** No public address, so no Connect link can be made. */
export function connectUnavailable(): string {
  return t('slackMessages.accounts_cannot_be_connected_yet_this');
}

/** Someone from another Slack organization (or a bot). */
export function notForYou(): string {
  return t('slackMessages.ordinate_answers_members_of_this_slack');
}

/** A linked person who may not ask in the project. */
export function noAccess(): string {
  return t('slackMessages.you_do_not_have_access_to');
}

/** A direct message from a person with no project. */
export function noProject(): string {
  return t('slackMessages.you_do_not_have_access_to_2');
}

/** No model is set up. */
export function notReady(): string {
  return t('slackMessages.the_assistant_is_not_set_up');
}

/** Anything that went wrong while answering. */
export function failed(): string {
  return t('slackMessages.i_could_not_answer_that_please');
}

/** The caption that stands in for the model's sentence when the share policy hid something. */
export function maskedCaption(): string {
  return t('slackMessages.some_details_in_this_answer_are');
}

/** The answer's footer: who answered, from which datasets. */
export function footer(agent: string, datasets: string): string {
  if (!datasets) return t('slackMessages.answered_by_using_the_asker_s', { agent });
  return t('slackMessages.answered_by_from_using_the_asker', { agent, datasets });
}

/** A table cut to its first rows. */
export function moreRows(shown: string, total: string): string {
  return t('slackMessages.showing_of_rows_open_in_ordinate', { shown, total });
}

export function openInOrdinate(): string {
  return t('subscriptionText.open_in_ordinate');
}
export function helpful(): string {
  return t('slackMessages.helpful');
}
export function notHelpful(): string {
  return t('slackMessages.not_helpful');
}
export function shareToChannel(): string {
  return t('slackMessages.share_to_channel');
}

/** A Share to channel that passed the check again. */
export function shared(): string {
  return t('slackMessages.shared_to_the_channel');
}

/** A Share to channel that did not pass the check, and the org does not let an asker post past it. */
export function shareRefused(): string {
  return t('slackMessages.i_cannot_share_this_to_the');
}

export function needsDb(): string {
  return t('slackMessages.slack_needs_postgres_database_url');
}

export function needsMasterKey(): string {
  return t('slackMessages.saving_slack_keys_needs_ordinate_master');
}

export function needSigningSecret(): string {
  return t('slackMessages.paste_the_app_s_signing_secret');
}

export function needAppToken(): string {
  return t('slackMessages.socket_mode_needs_the_app_level');
}

export function cannotBeReached(): string {
  return t('slackMessages.slack_cannot_reach_this_server_set');
}

export function badBotToken(): string {
  return t('slackMessages.slack_did_not_accept_that_bot');
}

export function slackUnreachable(): string {
  return t('slackMessages.could_not_reach_slack');
}

export function workspaceTaken(): string {
  return t('slackMessages.that_slack_workspace_is_connected_to');
}

export function connectFirst(): string {
  return t('slackMessages.connect_slack_first');
}

export function saveAppTokenFirst(): string {
  return t('slackMessages.socket_mode_needs_the_app_level_2');
}

export function cannotBeReachedStay(): string {
  return t('slackMessages.slack_cannot_reach_this_server_set_2');
}

export function questionGone(): string {
  return t('slackMessages.that_slack_question_is_no_longer');
}

export function channelsUnread(): string {
  return t('slackMessages.could_not_read_the_channels_from');
}

export function agentGone(): string {
  return t('slackMessages.that_agent_is_no_longer_there');
}

export function notConnectedAdmin(): string {
  return t('slackMessages.slack_is_not_connected_an_org');
}

export function inviteFirst(): string {
  return t('slackMessages.invite_ordinate_to_a_channel_in');
}

/** The title of a card the share policy changed, in place of the model's. */
export function maskedTitle(): string {
  return t('slackMessages.answer');
}

/** Who answered when no agent did. */
export function projectAssistant(): string {
  return t('slackMessages.the_project_assistant');
}

/** More questions than the per-user budget allows. */
export function tooBusy(): string {
  return t('slackMessages.you_are_asking_faster_than_ordinate');
}

/** The answer took longer than the server's time limit. */
export function timedOut(): string {
  return t('slackMessages.that_took_too_long_so_i');
}

/** An agent the asker may not use. */
export function agentNotYours(): string {
  return t('slackMessages.you_cannot_use_the_assistant_this');
}

/** A person who has to choose a new password first. */
export function changePasswordFirst(): string {
  return t('slackMessages.sign_in_to_ordinate_and_choose');
}

/** A channel tied to an agent of another project, which only that project's admin may move. */
export function heldByAnotherProject(): string {
  return t('slackMessages.that_channel_is_used_by_another');
}
