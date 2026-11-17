// Every sentence "Alert me" on an Assistant answer says (src/ipc/answerAlert.ts) — MAIN, through the catalog.
// Its own file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

import { t } from '../app/i18n';

/** A spec that does not read. */
export function alertAnswerUnreadable(): string {
  return t('verifiedMessages.this_answer_could_not_be_read');
}

/** More than one measure: an alert watches one number. */
export function alertOneMeasure(count: number): string {
  return t('answerAlertMessages.this_answer_has_measures_and_an', { count });
}

/** A measure with "Calculate as". */
export function alertNoCalc(): string {
  return t('answerAlertMessages.an_alert_watches_the_figure_itself');
}

/** A top-N answer. */
export function alertNoTop(): string {
  return t('answerAlertMessages.an_alert_can_t_follow_a');
}

/** A measure with no total (a raw value) or one on a linked dataset. */
export function alertNoTotal(): string {
  return t('answerAlertMessages.an_alert_watches_a_total_of');
}

/** A period compared with an earlier year. */
export function alertNoYearsBack(): string {
  return t('answerAlertMessages.an_alert_can_t_watch_a');
}

/** What the alert's one number covers. */
export function alertAcross(category: string): string {
  return t('answerAlertMessages.one_number_for_every_together_under', { category });
}

/** A measure, filter or glossary term from a linked dataset (ai/answerJoin): an alert's subject is one dataset's column and filters. */
export function alertNoLinked(): string {
  return t('answerAlertMessages.an_alert_watches_one_dataset_s');
}
