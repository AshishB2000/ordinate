import { t } from '../app/i18n';
import { CALC_KIND_NAMES } from './tableCalc';
// What the measure editor and a chart say when a calculated measure cannot be
// computed — MAIN, through the catalog. Its own file so the i18n extractor scans
// only sentences (as engine/liveQueryMessages.ts). Each is a whole sentence the
// editor prints beside the field it concerns; none carries a figure.

/** `[Typo]` names nothing. */
export function unknownMetric(name: string): string {
  return t('metricCheckMessages.no_metric_is_called', { name });
}

/** `[Typo]`, with a near miss worth offering. */
export function unknownMetricNear(name: string, near: string): string {
  return t('metricCheckMessages.no_metric_is_called_did_you', { name, near });
}

/** `[revenue]` bare: a column, where a measure needs a total. */
export function columnNeedsTotal(column: string): string {
  return t('metricCheckMessages.is_a_column_a_measure_is', { column });
}

/** `sum(region)`: an aggregation that needs numbers, over a column that has none. */
export function needsNumberColumn(aggregation: string, column: string): string {
  return t('metricCheckMessages.needs_a_number_column_and_is', { aggregation, column });
}

/** The formula names the metric it defines. */
export function refersToItself(name: string): string {
  return t('metricCheckMessages.refers_to_itself_so_it_would', { name });
}

/** `[A]` → `[B]` → `[A]`. `path` is the chain, already joined. */
export function circularReference(name: string, path: string): string {
  return t('metricCheckMessages.is_circular_a_metric_cannot_be', { name, path });
}

/** A chart cannot break out a metric measured on another dataset. */
export function otherDataset(name: string): string {
  return t('metricCheckMessages.is_measured_on_another_dataset_so', { name });
}

/** The saved formula no longer compiles (a column was renamed or removed). */
export function measureDoesNotCompile(name: string, reason: string): string {
  return t('metricCheckMessages.the_measure_cannot_be_calculated', { name, reason });
}

/** A level-of-detail aggregate inside a chart measure. */
export function measureNoLod(name: string): string {
  return t('metricCheckMessages.the_measure_uses_a_level_of', { name });
}

/** Small multiples. */
export function measureNoFacets(): string {
  return t('metricCheckMessages.a_calculated_measure_cannot_be_drawn');
}

/** Parts that need separate queries cannot be lined up over a folded or binned axis. */
export function measureNeedsOneAxis(name: string): string {
  return t('metricCheckMessages.the_measure_is_calculated_from_parts', { name });
}

/** A snapshot metric charted by a date column other than its own: per bucket of which date? Refused, never guessed. */
export function snapshotOtherDate(metric: string, snapshotColumn: string, category: string): string {
  return t('metricCheckMessages.is_a_snapshot_on_so_it', { metric, snapshotColumn, category });
}

/** A pivot value that is a snapshot metric: a pivot plots the stored column, a sum over every date. */
export function snapshotInPivot(metric: string): string {
  return t('metricCheckMessages.is_a_snapshot_which_a_pivot', { metric });
}

/** An answer card or Explain over a snapshot metric: the answer door draws a measure's stored column, a sum over every date. */
export function snapshotInAnswer(metric: string): string {
  return t('metricCheckMessages.is_a_snapshot_which_an_answer', { metric });
}

/** A snapshot metric's date names a column that is not a date column of its dataset. */
export function snapshotNotDate(column: string): string {
  return t('metricCheckMessages.is_not_a_date_column_so', { column });
}

/** Two dashboard date controls set different periods, and both land on the date a metric counts by. */
export function controlPeriodsDisagree(): string {
  return t('metricCheckMessages.this_metric_counts_by_its_own');
}

/** A running total, percent of total or moving sum of a measure that cannot be added up. `calc` is its name in prose. */
export function calcNotAdditive(measure: string, calc: string): string {
  return t('metricCheckMessages.can_t_be_shown_as_it', { measure, calc });
}

/** The same, for a snapshot measure along dates: it adds across categories but not across time. */
export function calcNotAdditiveOverTime(measure: string, calc: string): string {
  return t('metricCheckMessages.can_t_be_shown_as_along', { measure, calc });
}

// ── The date a metric counts by (semantic layer D9) ──────────────────────────
// A date is a column name, or `dashboardDate()` for "no date of its own".

/** A metric's date names a column that is not a date column of its dataset. */
export function notADateColumn(column: string): string {
  return t('metricCheckMessages.is_not_a_date_column_of', { column });
}

/** What a metric or measure with no date of its own counts by, inside a sentence. */
export function dashboardDate(): string {
  return t('metricCheckMessages.the_dashboard_s_date');
}

/** A formula's own date is not the date one of its parts counts by. */
export function formulaDatesDiffer(name: string, part: string, partDate: string, ownDate: string): string {
  return t('metricCheckMessages.counts_by_but_its_part_counts', { name, ownDate, part, partDate });
}

/** A formula with no date of its own, over parts that count by different dates: it has none to take. */
export function formulaPartsDiffer(name: string, a: string, aDate: string, b: string, bDate: string): string {
  return t('metricCheckMessages.is_calculated_from_which_counts_by', { name, a, aDate, b, bDate });
}

/** A pivot table's value is a metric with its own date, under a dashboard date control on another column: a pivot draws its stored copy, so the period is not moved. */
export function pivotOwnDate(name: string): string {
  return t('metricCheckMessages.counts_by_its_own_date_and', { name });
}

/** One chart draws measures that count by different dates, under a date control. */
export function measuresCountByDifferentDates(a: string, aDate: string, b: string, bDate: string): string {
  return t('metricCheckMessages.counts_by_and_by_so_one', { a, aDate, b, bDate });
}

/** A period metric (part 5, D8) whose base metric is gone: no figure, never a fallback copy. */
export function periodBaseMissing(): string {
  return t('metricCheckMessages.its_base_metric_was_deleted_so');
}

/** A period metric's base is a metric of another dataset. */
export function periodBaseOtherDataset(): string {
  return t('metricCheckMessages.the_base_metric_must_be_on');
}

/** A period metric's base names no date it counts by, so no window can be laid on it. */
export function periodBaseNoDate(base: string): string {
  return t('metricCheckMessages.has_no_date_it_counts_by', { base });
}

/** A period metric built on another period metric. */
export function periodOfPeriod(): string {
  return t('metricCheckMessages.a_period_metric_can_t_be');
}

/** A period metric named a date of its own. */
export function periodOwnDate(): string {
  return t('metricCheckMessages.a_period_metric_counts_by_its');
}

/** A compare with no window and no period in scope: nothing to compare with. */
export function pickPeriodToCompare(): string {
  return t('metricCheckMessages.pick_a_period_to_compare');
}

/** A period metric on a date axis is one resolution per bucket, at most 24 (part 5, D10). `calc`: the Moving sum calculation's name. */
export function periodTooManyBuckets(name: string, grain: string, n: number): string {
  const calc = CALC_KIND_NAMES.moving_sum;
  return t('metricCheckMessages.by_needs_points_and_a_period', { name, grain, n, calc });
}

/** A period metric (part 5, D10) is charted alone: one resolution per bucket, or one scope rewritten for the whole chart. */
export function measureChartsAlone(name: string): string {
  return t('metricCheckMessages.is_charted_on_its_own_one', { name });
}

/** A period metric on a date axis other than the date its base counts by: its window would be laid on one date and the axis on another. */
export function periodOtherDate(name: string, date: string, category: string): string {
  return t('metricCheckMessages.counts_by_so_it_can_be', { name, date, category });
}

/** A formula over a period metric on a chart (planned on tiles only). */
export function periodInChartFormula(name: string): string {
  return t('metricCheckMessages.a_formula_over_can_t_be', { name });
}

/** A per-entity snapshot (part 5, D11) with no period in scope: an entity that stopped reporting still counts its last value. */
export function snapshotPerStale(per: string): string {
  return t('metricCheckMessages.a_that_stopped_reporting_still_counts', { per });
}

/** A per-entity snapshot asked with what it does not combine with yet: currency conversion, a parameter replayed in Prepare, a related table. */
export function snapshotPerUnsupported(per: string): string {
  return t('metricCheckMessages.a_snapshot_per_can_t_yet', { per });
}

/** A snapshot's `per` that names no column of its dataset. */
export function snapshotPerNotColumn(per: string): string {
  return t('metricCheckMessages.is_not_a_column_of_this', { per });
}

/** A snapshot's `per` that names its own date: each day would be its own entity. */
export function snapshotPerIsDate(per: string): string {
  return t('metricCheckMessages.is_the_snapshot_s_own_date', { per });
}

/** A per-entity snapshot whose question needs the LOD pass (an LOD expression, a context filter over an LOD field, or a relative LOD field by a chart's dims): the kept rows hold the stored values only. */
export function snapshotPerLod(per: string): string {
  return t('metricCheckMessages.a_snapshot_per_can_t_yet_2', { per });
}

/** A funnel metric (part 5, D6) whose entry period ends less than a window before today: its last entrants have not had their full window. */
export function funnelMayStillConvert(): string {
  return t('metricCheckMessages.recent_entries_may_still_convert');
}

/** A funnel metric's rows left out: no entity, or a time its grammar can't read. `n` is formatted. */
export function funnelExcluded(n: string): string {
  return t('metricCheckMessages.rows_without_an_entity_or_a', { n });
}

/** A scope filter a funnel metric can't use to pick who enters: another table's column, or none of its dataset's. */
export function funnelEntryNotOwn(column: string): string {
  return t('metricCheckMessages.a_filter_on_can_t_pick', { column });
}

/** A context filter in a funnel metric's scope over a dataset with LOD fields: the entry would read the stored values, not the context's. */
export function funnelEntryLod(): string {
  return t('metricCheckMessages.a_context_filter_can_t_pick');
}

/** A funnel metric by a category (D7): the engine's breakdown keeps its `n` biggest groups by entries. */
export function funnelTopGroups(n: number, column: string): string {
  return t('metricCheckMessages.only_the_values_of_with_the', { n, column });
}

/** A funnel metric on a date axis is one resolution per bucket, at most 24. */
export function funnelTooManyBuckets(name: string, grain: string, n: number): string {
  return t('metricCheckMessages.by_needs_points_and_a_funnel', { name, grain, n });
}

/** A funnel metric charted by a column of another dataset, or by none: its breakdown is its entry event's own value. */
export function funnelOwnColumn(name: string, category: string): string {
  return t('metricCheckMessages.can_be_charted_by_a_column', { name, category });
}
