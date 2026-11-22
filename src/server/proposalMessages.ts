import { t } from '../app/i18n';
// Every sentence metric proposals show or tell (docs/metric-proposals/00-design.md; ./proposals/) — MAIN, through the
// catalog. Its own file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

export function proposalsOff(): string {
  return t('proposalMessages.proposing_a_definition_needs_the_user');
}

/** A turn that is not one of the caller's refused answers (someone else's, a missing one, one with nothing to define). */
export function notRefusedAnswer(): string {
  return t('proposalMessages.that_answer_is_not_one_of');
}

export function nothingToDefine(): string {
  return t('proposalMessages.nothing_in_that_question_can_be');
}

export function noDataset(): string {
  return t('proposalMessages.there_is_no_dataset_you_can');
}

export function tooManyToday(max: number): string {
  return t('proposalMessages.you_can_propose_up_to_definitions', { max });
}

export function tooManyOpen(max: number): string {
  return t('proposalMessages.this_project_already_has_proposals', { max });
}

export function modelFailed(): string {
  return t('proposalMessages.the_model_could_not_draft_a');
}

export function badDraft(): string {
  return t('proposalMessages.the_model_did_not_return_a');
}

export function figureInDraft(): string {
  return t('proposalMessages.the_draft_put_a_figure_in');
}

export function datasetNotFound(name: string): string {
  return t('proposalMessages.there_is_no_dataset_called_that', { name });
}

export function columnNotUsable(column: string, dataset: string): string {
  return t('proposalMessages.is_not_a_column_of_that', { column, dataset });
}

export function badFormula(why: string): string {
  return t('proposalMessages.the_formula_does_not_work', { why });
}

export function notANumber(column: string): string {
  return t('proposalMessages.is_not_a_number_column_so', { column });
}

export function nameEmpty(): string {
  return t('proposalMessages.a_definition_needs_a_name');
}

export function savedFailed(why: string): string {
  return t('proposalMessages.it_could_not_be_saved', { why });
}

export function proposalGone(): string {
  return t('proposalMessages.that_proposal_is_not_here');
}

export function alreadyDecided(): string {
  return t('proposalMessages.that_proposal_was_already_decided');
}

export function beingDecided(): string {
  return t('proposalMessages.another_editor_is_deciding_that_proposal');
}

/** An edit the draft does not allow (a formula on a term, or on a metric that is a column). */
export function invalidEdit(): string {
  return t('proposalMessages.that_change_is_not_allowed_for');
}

/** Appended to a metric's description: the names people use for it. */
export function alsoCalled(names: string): string {
  return t('proposalMessages.also_called', { names });
}
