import { t } from '../app/i18n';
// What a user sees when a question cannot be answered LIVE (docs/live-data/00-plan.md
// L2.2, D6) — MAIN, through the catalog. A live dataset has no rows to fall back
// on, so everything the compiler does not build yet is refused with one of these
// sentences rather than answered with an empty chart that looks like a real one.
// Its own file so the i18n extractor scans nothing else (as regexMessages.ts).
// Column names arrive as the user wrote them; no figure ever appears here.

/** A pivot table over a live dataset. */
export function livePivotRefused(): string {
  return t('liveRefusals.a_pivot_table_cannot_be_drawn');
}

/** A cohort triangle over a live dataset. */
export function liveCohortRefused(): string {
  return t('liveRefusals.a_cohort_chart_cannot_be_drawn');
}

/** An event funnel over a live dataset. */
export function liveFunnelRefused(): string {
  return t('liveRefusals.an_event_funnel_cannot_be_drawn');
}

/** A key-drivers tile over a live dataset. */
export function liveDriversRefused(): string {
  return t('liveRefusals.key_drivers_cannot_be_worked_out');
}

/** Small multiples over a live dataset. */
export function liveFacetRefused(): string {
  return t('liveRefusals.small_multiples_cannot_be_drawn_from');
}

/** A map over a live dataset. */
export function liveMapRefused(): string {
  return t('liveRefusals.a_map_cannot_be_drawn_from');
}

/** A field reached through a relationship. */
export function liveRelatedRefused(): string {
  return t('liveRefusals.a_field_from_a_related_dataset');
}

/** Every measure set to "none": one point per row, which live never fetches. */
export function liveRawRefused(): string {
  return t('liveRefusals.a_live_chart_needs_a_total');
}

/** No category on the encoding. */
export function liveNoCategory(): string {
  return t('liveRefusals.choose_a_category_for_this_chart');
}

/** No measure on the encoding. */
export function liveNoMeasure(): string {
  return t('liveRefusals.choose_a_measure_for_this_chart');
}

/** A column the stored schema does not declare. */
export function liveUnknownColumn(column: string): string {
  return t('liveRefusals.is_not_a_column_of_this', { column });
}

/** sum / avg / min / max over a column not declared a number: refused, never a wrong figure. */
export function liveNotNumeric(column: string): string {
  return t('liveRefusals.is_not_a_number_column_so', { column });
}

/** An aggregation outside sum / avg / count / min / max. */
export function liveUnknownAggregation(aggregation: string): string {
  return t('liveRefusals.is_not_an_aggregation_a_live', { aggregation });
}

/** The within-a-distance filter. */
export function liveWithinKmRefused(): string {
  return t('liveRefusals.a_distance_filter_cannot_run_on');
}

/** `contains` on a number column: the warehouse would print the number differently from the app. */
export function liveContainsNumberRefused(column: string): string {
  return t('liveRefusals.a_contains_filter_cannot_run_on', { column });
}

/** A split by a date column. */
export function liveDateSeriesRefused(column: string): string {
  return t('liveRefusals.a_live_chart_cannot_be_split', { column });
}

/** A relative period on a column that is not a date. */
export function livePeriodNotDate(column: string): string {
  return t('liveRefusals.is_not_a_date_so_it', { column });
}

/** A period the executor did not resolve before compiling: a bug, said out loud. */
export function liveUnresolvedPeriod(): string {
  return t('liveRefusals.a_period_filter_reached_the_live');
}

/** A name that cannot be quoted safely (empty, or carrying a NUL). */
export function liveBadIdentifier(): string {
  return t('liveRefusals.a_table_or_column_name_of');
}

/** No table and no defining query. */
export function liveBadSource(): string {
  return t('liveRefusals.this_live_dataset_has_no_table');
}

/** The category's declared type and the kind of axis asked for disagree. */
export function liveCategoryType(column: string): string {
  return t('liveRefusals.the_category_no_longer_has_the', { column });
}

/** A top-N or a ranking over a date axis: answers never rank time. */
export function liveRankOnDate(): string {
  return t('liveRefusals.a_date_axis_keeps_time_order');
}

/** A warehouse reply whose width does not match the statement. */
export function liveRowShape(): string {
  return t('liveRefusals.the_warehouse_answered_in_a_shape');
}

/** An IR the compiler does not recognise (a malformed or foreign question). */
export function liveBadQuery(): string {
  return t('liveRefusals.this_question_cannot_be_asked_of');
}

/** A column the question names was in the dataset and is gone from the warehouse (a schema sync found it missing, L2.5). */
export function liveColumnMissing(column: string): string {
  return t('liveRefusals.is_no_longer_in_the_warehouse', { column });
}
