import { t } from '../app/i18n';
// What a refused bundle, backup or record says (./zipReader.ts, ./bundleImport.ts,
// ./bundle.ts, src/ipc/settingsServer.ts) — MAIN, through the catalog. Its own
// file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these
// sentences and nothing else. A name passed in is already cut and stripped of
// control characters by the reader.

export function notAZip(): string {
  return t('bundleMessages.not_a_bundle_no_zip_directory');
}

export function damagedDirectory(): string {
  return t('bundleMessages.the_bundle_is_damaged_directory');
}

export function damagedEntry(name: string): string {
  return t('bundleMessages.the_bundle_is_damaged', { name });
}

export function tooManyFiles(): string {
  return t('bundleMessages.the_bundle_holds_too_many_files');
}

export function encrypted(): string {
  return t('bundleMessages.encrypted_bundles_are_not_supported');
}

export function unsupportedMethod(): string {
  return t('bundleMessages.the_bundle_uses_an_unsupported');
}

export function unsupportedFeature(): string {
  return t('bundleMessages.the_bundle_uses_a_zip_feature');
}

export function tooLarge(): string {
  return t('bundleMessages.the_bundle_is_too_large_to');
}

export function entryTooLarge(name: string): string {
  return t('bundleMessages.the_bundle_s_is_larger_than', { name });
}

export function inflatesPast(name: string): string {
  return t('bundleMessages.the_bundle_is_damaged_is_larger', { name });
}

export function duplicateName(name: string): string {
  return t('bundleMessages.the_bundle_holds_twice_it_was', { name });
}

export function badName(): string {
  return t('bundleMessages.the_bundle_holds_a_file_name');
}

export function bundleNotImported(name: string): string {
  return t('bundleMessages.the_bundle_holds_files_ordinate_does', { name });
}

export function bundleNameCase(name: string): string {
  return t('bundleMessages.the_bundle_holds_a_file_name_2', { name });
}

export function noManifest(): string {
  return t('bundleMessages.the_bundle_has_no_readable_manifest');
}

export function notThisFormat(): string {
  return t('bundleMessages.this_is_not_an_ordinate_project');
}

export function manifestMismatch(what: string, listed: string, present: string): string {
  return t('bundleMessages.the_bundle_does_not_match_its', { what, listed, present });
}

export function alertsUnreadable(): string {
  return t('bundleMessages.the_bundle_s_alerts_json_is');
}

export function notWritten(): string {
  return t('bundleMessages.the_bundle_could_not_be_written');
}

export function notABackup(): string {
  return t('bundleMessages.that_file_is_not_an_ordinate');
}

export function backupTooLarge(): string {
  return t('bundleMessages.the_backup_is_too_large_over');
}

/** A record older than the 32 MiB cap, met at export: refused there, never written into a bundle our import refuses. */
export function recordTooLargeToExport(name: string): string {
  return t('bundleMessages.is_over_32_mb_more_than', { name });
}
