import { t } from '../app/i18n';
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

/** A snapshot metric (the latest rows only) in a chart this version cannot compute it for. */
export function measureSnapshotPending(name: string): string {
  return t('metricCheckMessages.is_a_snapshot_metric_which_this', { name });
}

/** A metric that counts by its own date, under a dashboard date control on another column: a later release moves the period onto that date. */
export function measureTimeColumnPending(): string {
  return t('metricCheckMessages.this_chart_counts_a_metric_by');
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
