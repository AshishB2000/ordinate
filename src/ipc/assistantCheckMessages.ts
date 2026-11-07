import { t } from '../app/i18n';
// What Check the Assistant says (semantic layer part 3 D13 (3), ./assistantCheck) — MAIN, through the catalog. Its own
// file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

/** The job's label in the Jobs popover. */
export function checkLabel(): string {
  return t('assistantCheckMessages.checking_the_assistant');
}

export function checkNoModel(): string {
  return t('assistantCheckMessages.connect_a_model_to_check_the');
}

export function checkRunning(): string {
  return t('assistantCheckMessages.a_check_is_already_running_for');
}

export function checkNothing(): string {
  return t('assistantCheckMessages.there_are_no_working_verified_questions');
}

/** A reply with no chart answer: prose only, or another kind of action. */
export function checkNoChart(): string {
  return t('assistantCheckMessages.the_assistant_did_not_answer_with');
}

/** A run that failed on something with no message of its own. */
export function checkFailed(): string {
  return t('assistantCheckMessages.something_went_wrong');
}
