import { t } from '../app/i18n';
// What the Assistant agents' channels and asks say (docs/assistant-agents/00-design.md) — MAIN, through the catalog.
// Its own file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

export function agentNameMissing(): string {
  return t('agentMessages.an_assistant_needs_a_name');
}

/** Another agent of the project has this name, ignoring case — or it is the Project assistant's own. */
export function agentNameTaken(name: string): string {
  return t('agentMessages.this_project_already_has_an_assistant', { name });
}

export function tooManyAgents(n: number): string {
  const count = String(n);
  return t('agentMessages.a_project_can_have_at_most', { count });
}

export function agentTopicGone(): string {
  return t('agentMessages.that_topic_no_longer_exists_pick');
}

export function agentModelNotEnabled(): string {
  return t('agentMessages.that_model_is_not_enabled_in');
}

export function agentTeamGone(): string {
  return t('agentMessages.a_team_picked_here_no_longer');
}

/** `agent:*` of an id with no agent behind it. */
export function agentNotFound(): string {
  return t('agentMessages.this_assistant_no_longer_exists');
}

/** An instruction added to an agent's full list (src/app/instructions.ts MAX_INSTRUCTIONS). */
export function agentTooManyInstructions(max: number): string {
  const count = String(max);
  return t('agentMessages.an_assistant_can_have_at_most', { count });
}

export function agentsNotRead(): string {
  return t('agentMessages.could_not_read_the_assistants_try');
}

export function agentNotSaved(): string {
  return t('agentMessages.could_not_save_the_assistant_try');
}

/** `trash:restore` of an agent by someone who is not a project admin (rule 5). */
export function agentRestoreAdminOnly(): string {
  return t('agentMessages.only_a_project_admin_can_restore');
}

// ── The ask ─────────────────────────────────────────────────────────────────

/** A question in a conversation whose agent is in the Trash (rule 12). */
export function agentWasDeleted(name: string): string {
  return t('agentMessages.was_deleted_so_the_project_assistant', { name });
}

/** …whose agent is gone for good, or was never there. */
export function agentGone(): string {
  return t('agentMessages.that_assistant_no_longer_exists_so');
}

/** …whose agent the caller may not use (no longer in its teams, or never was). */
export function agentNotYours(): string {
  return t('agentMessages.that_assistant_is_not_available_to');
}

/** The out-of-scope card's first line (rule 10). */
export function outsideTopic(topic: string): string {
  return t('agentMessages.this_isn_t_in_the_data', { topic });
}

/** …when the app found it among what the caller can read. */
export function outsideOffer(dataset: string): string {
  return t('agentMessages.the_project_assistant_can_answer_it', { dataset });
}

/** …when it found it nowhere the caller can read. */
export function outsideNowhere(): string {
  return t('agentMessages.nothing_else_in_this_project_that');
}

/** `plan:start` in a conversation whose agent may only answer (rule 8). */
export function agentAnswersOnly(name: string): string {
  return t('agentMessages.only_answers_questions_ask_the_project', { name });
}
