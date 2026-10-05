// The words the grids print, under the desktop catalog's own keys
// (src/i18n/en.json) and through its ICU formatter — the arrangement of
// ../strings.ts. grids.test.tsx pins every message to en.json.
// ponytail: English only until the web app gets its catalog (as ../strings.ts).

import { formatMessage } from '../../../../src/app/i18nCore.ts';

export const GRID_STRINGS = {
  'cohortRender.build_a_cohort_from_a_dataset': 'Build a cohort from a dataset in Visuals.',
  'cohortRender.build_an_event_funnel_from_a': 'Build an event funnel from a dataset in Visuals.',
  'cohortRender.by': 'By {column}{p1}',
  'cohortRender.cohort_members': '{label} cohort ({p1} members) · {periodNoun} {k}: {v}',
  'cohortRender.cohort_table': 'Cohort table',
  'cohortRender.cohort_view': 'Cohort view',
  'cohortRender.entered_strict_order_within_of_the': '{p0} entered · strict order · within {window} of the first step',
  'cohortRender.entities': 'Entities',
  'cohortRender.entities_move_through_the_steps_in': 'Entities move through the steps in order, each inside the conversion window.',
  'cohortRender.export_the_cohort_table_as_csv': 'Export the cohort table as CSV',
  'cohortRender.export_the_funnel_as_csv': 'Export the funnel as CSV',
  'cohortRender.median_after_step': 'median {p0} after step {k}',
  'cohortRender.median_time_from_previous': 'Median time from previous',
  'cohortRender.members': 'Members',
  'cohortRender.members_are_grouped_by_the_period': 'Members are grouped by the period of their first event; each column shows who came back.',
  'cohortRender.members_by': '{cohortsCount} {cohortsCount, plural, one {cohort} other {cohorts}} · {members} members · {p3} by {p4}',
  'cohortRender.no_events_to_group_yet': 'No events to group yet.',
  'cohortRender.of_first': '{p0} of first',
  'cohortRender.of_first_step': '% of first step',
  'cohortRender.of_previous': '{p0} of previous',
  'cohortRender.of_previous_step': '% of previous step',
  'cohortRender.of_the_first_step_of_the': ', {p0} of the first step, {p1} of the previous, median {p2}',
  'cohortRender.retained': 'Retained %',
  'cohortRender.retention_curve_cohorts_and_their': 'Retention curve: {cohortsCount} cohorts and their average',
  'cohortRender.s_since_first_event': '{periodNoun}s since first event',
  'cohortRender.showing_the_latest_cohorts_and_first': 'Showing the latest {cohortsCount} cohorts and first {periods} {p2}s.',
  'cohortRender.step_entities': 'Step {p0}, {step}: {p2} entities{p3}',
  'cohortRender.top': ' — top {groupsCount}',
  'cohortRender.weighted_by_cohort_size_over_the': 'Weighted by cohort size, over the cohorts that have reached each period',
  'cohortRender.without_an_entity_or_a_readable': '{excluded} {excluded2, plural, one {row} other {rows}} without an entity or a readable date left out.',
  'cohortRender.without_an_entity_or_a_readable_2': '{excluded} {excluded2, plural, one {row} other {rows}} without an entity or a readable timestamp left out.',
  'common.cohort': 'Cohort',
  'common.collapse': 'Collapse ',
  'common.expand': 'Expand ',
  'common.export_csv': 'Export CSV',
  'common.label': 'Label',
  'common.retention_curve': 'Retention curve',
  'common.step': 'Step',
  'common.table': 'Table',
  'common.total': 'Total',
  'pivotRender.ascending': ', ascending',
  'pivotRender.descending': ', descending',
  'pivotRender.pick_a_row_dimension_and_at': 'Pick a row dimension and at least one value to build a pivot.',
  'pivotRender.showing_the_first_row_groups_and': 'Showing the first {p0} row groups and {p1} column groups — narrow the pivot with a filter or Top N to see the rest.',
  'pivotRender.sort_by': 'Sort by {p0}{p1}',
} as const;

export type GridStringKey = keyof typeof GRID_STRINGS;

export function t(key: GridStringKey, params?: Record<string, unknown>): string {
  return formatMessage(GRID_STRINGS[key], params, 'en');
}
