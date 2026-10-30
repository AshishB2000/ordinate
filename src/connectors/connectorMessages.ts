import { t } from '../app/i18n';
// What a connection test says beyond "OK" — MAIN, through the catalog. Its own
// file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these
// sentences and nothing else of the connector code; a connector imports the
// function, never the catalog.

/** Test connection succeeded, but the connection signs in with an administrator role. */
export function adminRoleWarning(role: string): string {
  return t('connectorMessages.this_connection_signs_in_with_the', { role });
}

/** SQL Server: the server's reply declined the encryption the connection requires, so the login was not sent. */
export function encryptionDeclined(): string {
  return t('connectorMessages.the_server_did_not_agree_to');
}

/** Oracle Autonomous on the server: a wallet folder (or a wallet in the connect string) names a server path. */
export function walletRefused(): string {
  return t('connectorMessages.a_wallet_folder_is_a_path');
}
