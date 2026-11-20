import { t } from '../app/i18n';
// What reading a knowledge document says when it cannot (docs/knowledge-docs/00-design.md) — MAIN, through the catalog.
// Its own file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else.

export function typeNotAccepted(): string {
  return t('knowledgeMessages.this_file_type_is_not_accepted');
}

export function notUtf8(): string {
  return t('knowledgeMessages.this_text_file_is_not_utf');
}

export function encrypted(): string {
  return t('knowledgeMessages.this_pdf_is_password_protected_remove');
}

export function noText(): string {
  return t('knowledgeMessages.no_text_could_be_read_from');
}

export function zipBomb(): string {
  return t('knowledgeMessages.this_word_file_expands_to_more');
}

export function tooLong(): string {
  return t('knowledgeMessages.this_document_is_longer_than_300');
}

export function timedOut(): string {
  return t('knowledgeMessages.reading_this_file_took_too_long');
}

export function unreadable(): string {
  return t('knowledgeMessages.this_file_could_not_be_read');
}

export function fileTooBig(): string {
  return t('knowledgeMessages.this_file_is_larger_than_10');
}
