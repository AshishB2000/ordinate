import { t } from '../app/i18n';
// What Publish, Unpublish and Discard edits are told (src/ipc/analysesPublish.ts) — MAIN, through the catalog.
// Its own file so the i18n extractor scans only sentences.

export function nothingPublished(): string {
  return t('draftMessages.this_dashboard_has_not_been_published');
}

/** An MCP token without editor on the project asking publish_dashboard / unpublish_dashboard (src/automation/registry.ts). */
export function onlyEditorsPublish(): string {
  return t('draftMessages.only_the_project_s_editors_and');
}
