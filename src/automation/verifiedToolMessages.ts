import { t } from '../app/i18n';
// What the verified-question tools say when they refuse — MAIN, through the catalog. Its own file so the i18n
// extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

/** An unknown question, and a hidden one alike: hiding never says "hidden". */
export function noVerifiedQuestion(question: string): string {
  return t('verifiedToolMessages.no_verified_question_in_this_project', { question });
}

/** The line a listed question carries when `aggregate` cannot say its spec. */
export function useAnswerVerified(): string {
  return t('verifiedToolMessages.use_answer_verified_question_for_its');
}

/** A Share policy that drops a column the question reads (MCP is an export). */
export function verifiedSensitive(): string {
  return t('verifiedToolMessages.hidden_by_the_share_policy_a');
}
