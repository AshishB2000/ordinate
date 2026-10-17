import { t } from '../app/i18n';
// What a saved-view edit is told (src/analysis/savedViews.ts applyViewOp, the
// `analysis:view` channel in src/ipc/analyses.ts) — MAIN, through the catalog.
// Its own file so the i18n extractor scans only sentences. A figure arrives
// already formatted.

export function viewNameMissing(): string {
  return t('savedViewMessages.give_the_view_a_name');
}

export function viewLimit(n: string): string {
  return t('savedViewMessages.a_dashboard_keeps_at_most_views', { n });
}

export function viewNameTaken(name: string): string {
  return t('savedViewMessages.there_is_already_a_view_called', { name });
}

export function viewGone(): string {
  return t('savedViewMessages.that_view_no_longer_exists');
}

export function viewUnknownOp(): string {
  return t('savedViewMessages.unknown_view_action');
}

export function dashboardGone(): string {
  return t('savedViewMessages.that_dashboard_could_not_be_loaded');
}
