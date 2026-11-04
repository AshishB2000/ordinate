import { t } from '../app/i18n';
import { MAX_VALUE_LABELS, MAX_VALUE_LEN, type ValueLabelProblem } from './valueLabels';
// What a value-label save and a chart reply say when a label cannot be used (semantic layer,
// PR 06) — MAIN, through the catalog. Its own file so the i18n extractor
// (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

/** The same stored value listed on two rows (`valueLabelProblem` `repeatValue`). */
export function valueListedTwice(value: string): string {
  return t('valueLabelMessages.is_listed_twice', { value });
}

/** One label on two values (`sharedLabel`): a label names one value only. */
export function labelShared(label: string, a: string, b: string): string {
  return t('valueLabelMessages.would_name_both_and_a_label', { label, a, b });
}

/** More rows than a column may label (`tooMany`). */
export function tooManyLabels(count: number): string {
  return t('valueLabelMessages.a_column_can_have_at_most', { count });
}

/** A value on a row with nothing in it (`blankValue`). */
export function valueBlank(): string {
  return t('valueLabelMessages.a_value_cannot_be_blank');
}

/** A value longer than a stored cell may be (`valueTooLong`). */
export function valueTooLong(max: number): string {
  return t('valueLabelMessages.a_value_can_have_at_most', { max });
}

/** A row with a value and no label once trimmed (`emptyLabel`). */
export function labelEmpty(value: string): string {
  return t('valueLabelMessages.needs_a_label', { value });
}

/** A number, date or other non-text column (D6: labels are for text columns). */
export function labelsTextOnly(column: string, type: string): string {
  return t('valueLabelMessages.value_labels_are_for_text_columns', { column, type });
}

/** A reply where a label is also a stored value on the same axis: the pair is left out, the value shows as stored. */
export function labelNotShown(label: string, column: string): string {
  return t('valueLabelMessages.is_also_a_value_of_so', { label, column });
}

/** A column the dataset does not have (a label saved for a name that is not there). */
export function labelColumnGone(column: string): string {
  return t('valueLabelMessages.is_not_a_column_of_this', { column });
}

/** The sentence for whatever `valueLabelProblem` found, every kind covered. */
export function valueLabelProblemText(problem: ValueLabelProblem): string {
  switch (problem.kind) {
    case 'repeatValue': return valueListedTwice(problem.value);
    case 'sharedLabel': return labelShared(problem.label, problem.values[0], problem.values[1]);
    case 'tooMany': return tooManyLabels(MAX_VALUE_LABELS);
    case 'blankValue': return valueBlank();
    case 'valueTooLong': return valueTooLong(MAX_VALUE_LEN);
    case 'emptyLabel': return labelEmpty(problem.value);
  }
}
