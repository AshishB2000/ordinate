import { t } from '../app/i18n';
// What a source table doc says when it refuses (./sourceTables.ts, src/ipc/sourceTables.ts) —
// MAIN, through the catalog. Its own file so the i18n extractor (scripts/i18n-extract.ts
// MAIN_FILES) scans these sentences and nothing else.

/** A connection documents at most MAX_SOURCE_DOCS tables. */
export function sourceTablesFull(): string {
  return t('sourceTableMessages.this_connection_already_documents_2_000');
}
