import { t } from '../app/i18n';
// What an answer card says about its filter VALUES, and about being kept —
// MAIN, through the catalog. Its own file so the i18n extractor
// (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

/** The card's note where a said value was matched loosely to the one the data holds (./answerValues `matchValues`). */
export function valueMatched(said: string, value: string, column: string): string {
  return t('answerMessages.matched_to_in', { said, value, column });
}

/** A chart with no rows because a filter value is not in its column — the line above the card's "Did you mean". `in`: one value of a list. */
export function noRowsMatch(column: string, op: '=' | 'in', said: string): string {
  if (op === 'in') return t('answerMessages.no_rows_have_in', { said, column });
  return t('answerMessages.no_rows_match', { column, said });
}

/** An empty answer whose period starts after its data ends (./answerSpec `periodsAfterData`). `ends`: the day, already formatted. */
export function periodAfterData(period: string, dataset: string, ends: string): string {
  return t('answerMessages.no_rows_in_ends_on', { period, dataset, ends });
}

/** `answer:saveVisual` when the visual store would not take the chart. */
export function answerNotSaved(): string {
  return t('answerMessages.could_not_save_this_answer_as');
}

// ── `answer:addToDashboard` (src/ipc/answerDashboard.ts) ──

/** A spec with no chart form: an SQL answer, or one that cannot be read. */
export function notAChartAnswer(): string {
  return t('answerMessages.only_a_chart_answer_can_be');
}

/** The dashboard named is not there for the caller (deleted, or never theirs to edit). */
export function dashboardGone(): string {
  return t('answerMessages.that_dashboard_is_no_longer_in');
}

/** The dashboard store would not take the tile. */
export function answerNotAdded(): string {
  return t('answerMessages.could_not_add_this_answer_to');
}

// ── The chart form's `calc` (./answerCalc): why a table calculation was refused ──

/** A calculation name the form does not know; `kinds`: the ones it does, listed. */
export function calcUnknown(said: string, kinds: string): string {
  return t('answerMessages.is_not_a_calculation_the_chart', { said, kinds });
}

/** A moving window out of bounds; the bounds already formatted. */
export function calcWindow(min: string, max: string): string {
  return t('answerMessages.a_moving_window_is_a_whole', { min, max });
}

/** A calculation worked out in date order, asked of a category that is not a date, or down the split. `calc`: its name (tableCalc CALC_KIND_NAMES). */
export function calcNeedsDate(calc: string): string {
  return t('answerMessages.the_chart_form_works_out_along', { calc });
}

/** A direction other than across the category, or down a split the answer does not have. */
export function calcAlongOf(): string {
  return t('answerMessages.a_calculation_runs_across_the_category');
}

/** A calculation beside a top-N cut: each kind compares a category with every other. `n` already formatted. */
export function calcWithTop(calc: string, n: string): string {
  return t('answerMessages.the_chart_form_cannot_keep_only', { n, calc });
}

/** A calculation on a measure a split chart does not draw. */
export function calcSplitFirst(): string {
  return t('answerMessages.with_a_split_the_chart_draws');
}

/**
 * A model's answer that names a linked dataset's column on the dataset it is linked to (../ipc/askLinks) without naming
 * that dataset: rejection, not repair. Its category, split, a measure or a filter may come from it when the answer names
 * it as that field's dataset (./answerJoin).
 */
export function linkedColumnRefused(column: string, linked: string, dataset: string): string {
  return t('answerMessages.is_a_column_of_which_is', { column, linked, dataset });
}

/** A relative period on a related dataset's date column (./answerJoin): its days are that dataset's cells, which an answer does not read. */
export function relatedPeriodRefused(column: string, linked: string, dataset: string): string {
  return t('answerMessages.an_answer_on_can_t_filter', { dataset, linked, column });
}
