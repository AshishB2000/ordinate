import { t } from '../app/i18n';
// What a connection test says beyond "OK" — MAIN, through the catalog. Its own
// file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these
// sentences and nothing else of the connector code; a connector imports the
// function, never the catalog.

/** Test connection succeeded, but the connection signs in with an administrator role. */
export function adminRoleWarning(role: string): string {
  return t('connectorMessages.this_connection_signs_in_with_the', { role });
}
