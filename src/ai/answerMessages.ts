import { t } from '../app/i18n';
// What an answer card says about its filter VALUES, and about being kept —
// MAIN, through the catalog. Its own file so the i18n extractor
// (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

/** The card's note where a said value was matched loosely to the one the data holds (./answerValues `matchValues`). */
export function valueMatched(said: string, value: string, column: string): string {
  return t('answerMessages.matched_to_in', { said, value, column });
}

/** A chart with no rows because a filter value is not in its column — the line above the card's "Did you mean". */
export function noRowsMatch(column: string, said: string): string {
  return t('answerMessages.no_rows_match', { column, said });
}

/** `answer:saveVisual` when the visual store would not take the chart. */
export function answerNotSaved(): string {
  return t('answerMessages.could_not_save_this_answer_as');
}
