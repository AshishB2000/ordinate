import { t } from '../app/i18n';
// What an SQL answer says (docs/assistant/00-design.md, "The SQL lane") — MAIN, through the catalog. Its own file so
// the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else. Figures are
// formatted by the caller before they come in.

// ── The card (../ipc/answerSql) ─────────────────────────────────────────────

/** The card's caption: how big the result table is. */
export function sqlCaption(rows: string, columns: string): string {
  return t('answerSqlMessages.rows_columns', { rows, columns });
}

/** The caption when the gate's row cap cut the result. */
export function sqlCaptionCut(rows: string, columns: string): string {
  return t('answerSqlMessages.the_first_rows_columns_there_are', { rows, columns });
}

/** The bullet naming what the statement read. */
export function sqlReads(names: string): string {
  return t('answerSqlMessages.reads', { names });
}

// ── Why there is no SQL answer ──────────────────────────────────────────────

/** A name that is no dataset of the caller's, or more than one. */
export function sqlNoDataset(said: string): string {
  return t('answerSqlMessages.is_not_the_name_of_one', { said });
}


/** The statement read a dataset the first call did not pick (so its details were never sent, and an agent's topic holds). */
export function sqlNotPicked(name: string): string {
  return t('answerSqlMessages.the_sql_reads_which_this_answer', { name });
}

export function sqlNoStatement(): string {
  return t('answerSqlMessages.the_ai_wrote_no_sql_for');
}

/** A statement over no dataset: its figures would be the model's own. */
export function sqlReadsNone(): string {
  return t('answerSqlMessages.the_sql_reads_no_dataset_so');
}

// ── Verified SQL questions (../ipc/verifiedSql) ─────────────────────────────

/** A verified SQL question whose statement no longer runs: the gate's or the engine's reason. */
export function verifiedSqlBroken(reason: string): string {
  return t('answerSqlMessages.this_verified_sql_no_longer_runs', { reason });
}

/** MCP's answer_verified_question on a question answered with SQL. */
export function verifiedSqlNotOnMcp(): string {
  return t('answerSqlMessages.this_verified_question_is_answered_with');
}

/** The Verified page's line for an SQL question, beside the datasets it reads. */
export function verifiedSqlDescribe(): string {
  return 'SQL';
}
