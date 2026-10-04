import { t } from '../app/i18n';
// What a user sees when a user regex is stopped (T6.4) — MAIN, through the
// catalog. Its own file so the regex worker (src/engine/regexWorker.ts) never
// loads the catalog, and so the i18n extractor scans nothing else.
// `seconds` arrives formatted (format.ts), as every figure does.

/** A prepare / text step whose pattern ran past the deadline: skipped, never left hanging. */
export function regexTimeoutWarning(seconds: string): string {
  return t('regexMessages.step_skipped_its_pattern_ran_past', { seconds });
}

/** A quality rule whose pattern ran past the deadline. */
export function regexTimeoutRuleError(seconds: string): string {
  return t('regexMessages.the_pattern_ran_past_the_second', { seconds });
}

/** A pattern the server reached without the regex worker — refused rather than run on the request thread. */
export function regexRefusedWarning(): string {
  return t('regexMessages.skipped_this_pattern_cannot_run_here');
}
