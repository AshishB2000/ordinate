import { t } from '../app/i18n';
// What a metric's save and update say when they refuse or fail (./metricSave.ts) — MAIN, through the catalog. Its own
// file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else. They reach
// the editor and a model import's reply alike.

/** Another metric already has this name (case-blind): a formula names metrics by name. */
export function metricNameTaken(name: string): string {
  return t('metricSaveMessages.a_metric_called_already_exists', { name });
}

/** The store wrote nothing: the dataset is gone. */
export function metricNotSaved(): string {
  return t('metricSaveMessages.could_not_save_the_metric_check');
}

/** A save that threw with no message of its own. */
export function metricSaveFailed(): string {
  return t('metricSaveMessages.failed_to_save_the_metric');
}

/** An update of a metric the project no longer has. */
export function metricNotFound(): string {
  return t('metricSaveMessages.metric_not_found');
}

/** An update that threw with no message of its own. */
export function metricUpdateFailed(): string {
  return t('metricSaveMessages.failed_to_update_the_metric');
}
