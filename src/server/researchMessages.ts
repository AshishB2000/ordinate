import { t } from '../app/i18n';
// Every sentence deep research says (docs/deep-research/00-design.md) — MAIN, through the catalog. Its own file so the i18n
// extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else. A reason a step was refused or failed
// is the app's FIXED text: no model words, no figures, no names of data. Names and dates arrive formatted.

/** The conversation's research turn: a fixed sentence, which a later ask replays to the model (no figure, no fact). */
export function turnText(): string {
  return t('researchMessages.deep_research_on_this_question_the');
}

/** The Story's prose where the cited data is restricted: the starter's private report holds the full text. */
export function restrictedProse(): string {
  return t('researchMessages.the_written_findings_for_this_part');
}

/** Under each section of the Story: when it was written. */
export function writtenOn(date: string): string {
  return t('researchMessages.written_on_from_the_data_then', { date });
}

export function notReady(): string {
  return t('researchMessages.deep_research_needs_an_ai_model');
}
export function alreadyRunning(): string {
  return t('researchMessages.you_already_have_a_research_run');
}
export function agentNotYours(): string {
  return t('researchMessages.you_cannot_use_that_agent_so');
}
export function needsDb(): string {
  return t('researchMessages.deep_research_needs_the_server_s');
}
export function notFound(): string {
  return t('researchMessages.that_research_run_was_not_found');
}
export function notResumable(): string {
  return t('researchMessages.this_run_cannot_be_resumed');
}
export function noReport(): string {
  return t('researchMessages.this_run_has_no_report_to');
}
export function badLimits(): string {
  return t('researchMessages.each_limit_must_be_a_whole');
}
export function couldNotAdd(): string {
  return t('researchMessages.the_report_could_not_be_added');
}

// What a refused step says (the reply was not one action).
export function replyEmpty(): string {
  return t('researchMessages.the_model_sent_no_step');
}
export function replyProse(): string {
  return t('researchMessages.the_model_replied_with_words_instead');
}
export function replyMany(): string {
  return t('researchMessages.the_model_sent_more_than_one');
}
export function replyJson(): string {
  return t('researchMessages.the_model_s_step_was_not');
}
export function replyKind(): string {
  return t('researchMessages.the_model_asked_for_something_research');
}
export function replyShape(): string {
  return t('researchMessages.the_model_s_step_was_incomplete');
}
export function replyFigureName(): string {
  return t('researchMessages.the_model_put_a_number_where');
}
export function datasetUnknown(): string {
  return t('researchMessages.that_step_named_a_dataset_the');
}
export function notAllowed(): string {
  return t('researchMessages.the_app_does_not_allow_that');
}
export function stepFailed(): string {
  return t('researchMessages.the_app_could_not_compute_this');
}
export function timeUp(): string {
  return t('researchMessages.the_time_limit_ended_this_step');
}
export function tooBusy(): string {
  return t('researchMessages.the_ai_request_limit_was_reached');
}

// A chart the Story could not carry.
export function chartNotSaved(step: string): string {
  return t('researchMessages.the_chart_for_step_could_not', { step });
}
export function sqlNotSaved(step: string): string {
  return t('researchMessages.step_read_the_data_with_sql', { step });
}

// A step's title when the model's own is not kept (it held a digit) or the step has none.
export function sqlResultTitle(): string {
  return t('researchMessages.sql_result');
}
export function whyChanged(metric: string): string {
  return t('researchMessages.why_changed', { metric });
}
export function whyItChanged(): string {
  return t('researchMessages.why_it_changed');
}
// The Story where the run touched restricted data.
export function restrictedCaveats(): string {
  return t('researchMessages.the_caveats_for_this_research_are');
}
export function findingTitle(n: string): string {
  return t('researchMessages.finding', { n });
}
