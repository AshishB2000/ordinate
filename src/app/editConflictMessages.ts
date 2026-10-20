// What a save refused as stale says (./editConflict.ts) — MAIN, through the
// catalog. Its own file so the i18n extractor (scripts/i18n-extract.ts
// MAIN_FILES) scans these sentences and nothing else. One per record type, in
// the words the editor's banner uses.

import type { SaveKind } from '../analysis/recordDiff';
import { t } from '../app/i18n';

/** Another tab or person saved this record after the caller's copy was read. */
export function recordChanged(type: SaveKind): string {
  switch (type) {
    case 'dashboard':
      return t('editConflictMessages.this_dashboard_was_changed_in_another');
    case 'visual':
      return t('editConflictMessages.this_visual_was_changed_in_another');
    case 'metric':
      return t('editConflictMessages.this_metric_was_changed_in_another');
    case 'metricTree':
      return t('editConflictMessages.this_metric_tree_was_changed_in');
    case 'report':
      return t('editConflictMessages.this_report_was_changed_in_another');
    case 'story':
      return t('editConflictMessages.this_story_was_changed_in_another');
    case 'scorecard':
      return t('editConflictMessages.this_scorecard_was_changed_in_another');
    case 'scenario':
      return t('editConflictMessages.this_scenario_was_changed_in_another');
    default:
      return t('editConflictMessages.this_was_changed_in_another_tab');
  }
}
