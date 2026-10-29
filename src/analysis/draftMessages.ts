import { t } from '../app/i18n';
// What Publish, Unpublish and Discard edits are told (src/ipc/analysesPublish.ts) — MAIN, through the catalog.
// Its own file so the i18n extractor scans only sentences.

export function nothingPublished(): string {
  return t('draftMessages.this_dashboard_has_not_been_published');
}
