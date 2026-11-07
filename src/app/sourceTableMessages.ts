import { t } from '../app/i18n';
// What a source table doc says when it refuses (./sourceTables.ts, src/ipc/sourceTables.ts) —
// MAIN, through the catalog. Its own file so the i18n extractor (scripts/i18n-extract.ts
// MAIN_FILES) scans these sentences and nothing else.

/** A connection documents at most MAX_SOURCE_DOCS tables. */
export function sourceTablesFull(): string {
  return t('sourceTableMessages.this_connection_already_documents_2_000');
}

/** The connection a call named is not in this project (or was deleted, docs and all). */
export function connectionGone(): string {
  return t('sourceTableMessages.that_connection_is_gone');
}

/** The doc a call named is not there (deleted in another tab, or never made). */
export function sourceDocGone(): string {
  return t('sourceTableMessages.those_notes_are_gone');
}

/** `sourceTable:read` was taken 60 times on one connection in an hour; the wait is rounded up to whole minutes. */
export function factsReadLimit(minutes: number): string {
  return t('sourceTableMessages.this_connection_s_tables_were_read', { minutes });
}

/** The source has neither a table-facts reader nor a column catalog (a SaaS app, Trino, Elasticsearch, …). */
export function factsNotReadable(): string {
  return t('sourceTableMessages.this_source_has_no_catalog_ordinate');
}
