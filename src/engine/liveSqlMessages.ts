import { t } from '../app/i18n';
// What a person reads when a SQL statement cannot run on a Live dataset (docs/live-data/01-live-sql.md,
// F1: src/engine/live/sql/) — MAIN, through the catalog. Its own file so the i18n extractor
// (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else. A name arrives as the
// statement wrote it, a construct as SQL text from the translator's own tables; no value from a row
// and no warehouse name ever appears here.

/** DuckDB's parser refused the statement; `detail` is its message about the model's own text. */
export function sqlParseError(detail: string): string {
  return t('liveSqlMessages.duckdb_could_not_read_this_statement', { detail });
}

/** Not exactly one SELECT statement (DDL, SET, COPY, CALL, PRAGMA, two statements…). */
export function sqlOneSelect(): string {
  return t('liveSqlMessages.only_one_select_statement_can_run');
}

/** A construct outside the allow-list, named as SQL (`WITH RECURSIVE`, `QUALIFY`, `AT (…)`, `regexp_matches()`…). */
export function sqlConstruct(construct: string): string {
  return t('liveSqlMessages.can_t_run_on_a_live', { construct });
}

/** A construct the printer cannot carry to one warehouse yet. */
export function sqlConstructOn(construct: string, warehouse: string): string {
  return t('liveSqlMessages.can_t_run_on_yet_ask', { construct, warehouse });
}

/** A table name that is no dataset in reach. */
export function sqlUnknownTable(name: string): string {
  return t('liveSqlMessages.is_not_a_dataset_this_question', { name });
}

/** A schema- or catalog-qualified table name. */
export function sqlQualified(name: string): string {
  return t('liveSqlMessages.name_a_dataset_by_its_name', { name });
}

/** A column name that is no visible column in scope. */
export function sqlUnknownColumn(name: string): string {
  return t('liveSqlMessages.is_not_a_column_here', { name });
}

/** A name two tables or columns in scope could mean (or two tables in one FROM share). */
export function sqlAmbiguous(name: string): string {
  return t('liveSqlMessages.could_mean_more_than_one_table', { name });
}

/** A function or operator given the wrong kind of value. */
export function sqlNeedsNumber(name: string): string {
  return t('liveSqlMessages.needs_numbers_here', { name });
}

export function sqlNeedsDate(name: string): string {
  return t('liveSqlMessages.needs_a_date_here', { name });
}

export function sqlNeedsText(name: string): string {
  return t('liveSqlMessages.needs_text_here', { name });
}

/** A comparison, CASE, COALESCE or set operation mixing kinds of value. */
export function sqlMixed(): string {
  return t('liveSqlMessages.both_sides_here_must_be_the');
}

/** A condition used as a value. */
export function sqlTrueFalse(): string {
  return t('liveSqlMessages.a_true_or_false_value_can');
}

/** A text literal compared with a date that is not an ISO day. */
export function sqlBadDate(value: string): string {
  return t('liveSqlMessages.is_not_a_date_written_as', { value });
}

/** A number literal no warehouse reads the same way (too large, not finite). */
export function sqlBadNumber(): string {
  return t('liveSqlMessages.this_number_is_too_large_to');
}

/** LIMIT, an offset of lag/lead or a frame bound that is not a whole number of at least 1. */
export function sqlWholeNumber(): string {
  return t('liveSqlMessages.limit_window_frames_and_lag_or');
}

/** An aggregate or a window function where neither can be used. */
export function sqlPlacement(): string {
  return t('liveSqlMessages.aggregates_and_window_functions_can_only');
}

/** Set operations, IN (subquery) and scalar subqueries whose columns do not line up. */
export function sqlColumns(): string {
  return t('liveSqlMessages.both_sides_must_return_the_same');
}

/** LIKE over something other than a pattern written in the statement. */
export function sqlLikePattern(): string {
  return t('liveSqlMessages.like_needs_its_pattern_written_as');
}

/** date_trunc or extract with a unit outside the four each takes. */
export function sqlDateUnit(unit: string): string {
  return t('liveSqlMessages.date_trunc_takes_week_month_quarter', { unit });
}

/** A statement that reads no dataset at all. */
export function sqlNoTable(): string {
  return t('liveSqlMessages.this_statement_reads_no_dataset');
}

/** A tree nested past the translator's depth bound. */
export function sqlTooDeep(): string {
  return t('liveSqlMessages.this_statement_is_nested_too_deeply');
}

// ── The executor (F3: src/engine/live/liveSql.ts) ────────────────────────────

/** A statement over Live datasets on two connections (F-D9): one warehouse cannot read the other's tables. */
export function sqlTwoConnections(): string {
  return t('liveSqlMessages.one_sql_answer_can_read_live');
}

/** A statement over a Live dataset and a copied one (F-D9): the warehouse cannot read our copy. */
export function sqlMixedEngines(): string {
  return t('liveSqlMessages.one_sql_answer_can_t_read');
}

/** A dataset answered by a semantic layer: its layer takes questions, never SQL. */
export function sqlOnLayer(): string {
  return t('liveSqlMessages.a_dataset_answered_by_a_semantic');
}

/** The member's SQL_PER_HOUR Live SQL answers on this connection are spent. `limit` and `minutes` formatted. */
export function sqlPerHour(limit: string, minutes: string): string {
  return t('liveSqlMessages.you_have_had_sql_answers_from', { limit, minutes });
}

/** BigQuery's free dry run says the statement would bill past the ceiling: nothing was sent. Sizes formatted ("14.2 GB"). */
export function sqlTooCostly(size: string, limit: string): string {
  return t('liveSqlMessages.refused_before_running_this_query_would', { size, limit });
}

/** DuckDB's binder refused the statement over empty views typed as the Live ones; `detail` is its message about the model's own names. */
export function sqlBindError(detail: string): string {
  return t('liveSqlMessages.this_statement_doesn_t_add_up', { detail });
}

/** A statement past the lane's length cap (MAX_SQL_TEXT, formatted). */
export function sqlTooLong(max: string): string {
  return t('liveSqlMessages.the_sql_is_longer_than_characters', { max });
}
