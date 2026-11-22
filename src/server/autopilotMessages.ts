import { t } from '../app/i18n';
// Every sentence Autopilot sends (docs/autopilot/00-design.md) — MAIN, through the catalog. Its own file so the i18n extractor
// (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else. The report page words its own rows (the web is
// English only); these are the push and the email. Names and counts arrive formatted.

/** The email's title: a project's weekly report. */
export function reportTitle(project: string): string {
  return t('autopilotMessages.autopilot_report_for', { project });
}

/** The email's lines, each a count. */
export function movedToTrash(count: string): string {
  return t('autopilotMessages.moved_to_trash', { count });
}
export function repaired(count: string): string {
  return t('autopilotMessages.repaired', { count });
}
export function broken(count: string): string {
  return t('autopilotMessages.broken_for_you_to_fix', { count });
}
export function slow(count: string): string {
  return t('autopilotMessages.slow', { count });
}

/** Autopilot stopped because the admin it acts as is not an admin of the organization any more. */
export function pausedTitle(project: string): string {
  return t('autopilotMessages.autopilot_paused_in', { project });
}
export function pausedNote(who: string): string {
  return t('autopilotMessages.switched_autopilot_on_and_is_no', { who });
}
