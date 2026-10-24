import { t } from '../app/i18n';
// What a draining pod says (./shutdown.ts) — MAIN, through the catalog. Its own
// file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these
// sentences and nothing else.

/** A job asked for, or a request still running, while the pod stops. */
export function restarting(): string {
  return t('lifecycleMessages.ordinate_is_restarting_try_again_in');
}

/** A job the shutdown cancelled (src/app/jobs.ts drain). */
export function restartedWhileRunning(): string {
  return t('lifecycleMessages.ordinate_restarted_while_this_was');
}
