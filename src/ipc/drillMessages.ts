import { t } from '../app/i18n';
// What `visual:drillDown` (./drillDown) says when a mark resolves but there is nowhere further to go. Its own file so
// the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else. A mark that cannot be
// resolved is refused with the rows panel's own sentence (resolveDrill), never one of these.

/** A pivot, cohort, event funnel, key-drivers chart or small multiples. */
export function drillNotThisChart(): string {
  return t('drillMessages.this_chart_does_not_drill_down');
}

/** A day bar: the date ladder ends there. */
export function drillFinestDate(): string {
  return t('drillMessages.a_day_is_the_finest_level');
}

/** The axis is the last level of its hierarchy. */
export function drillLastLevel(column: string, name: string): string {
  return t('drillMessages.is_the_last_level_of', { column, name });
}

/** The axis is a text column no hierarchy names. */
export function drillNoHierarchy(column: string): string {
  return t('drillMessages.is_not_a_level_of_a', { column });
}

/** A chart whose measures are separate questions under different filters (metricMeasures' plan): no one row set is behind a mark. */
export function drillSeparateFilters(): string {
  return t('drillMessages.this_chart_s_measures_are_filtered');
}

/** A snapshot measure's figure is one day's rows only, chosen per bucket: no one row set the panel lists is behind a mark. */
export function drillSnapshotRows(): string {
  return t('drillMessages.this_chart_shows_a_snapshot_one');
}
