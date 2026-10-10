import { t } from '../app/i18n';
// What a user reads when a point on a chart is explained ("Explain this
// change", ./driverPoint.ts) — MAIN, through the catalog. Its own file so the
// i18n extractor scans only sentences (as engine/liveRefusals.ts).
//
// Every figure and period arrives already formatted: nothing here rounds,
// divides or picks a date.

// ── The panel's header ───────────────────────────────────────────────────────
// `pct` is formatted without its sign; `from` is the baseline's figure, `to`
// the period's. A period longer than a day reads "in Mar 2026", a day "on Mar 3, 2026".

export function changeFell(metric: string, pct: string, period: string, baseline: string, from: string, to: string): string {
  return t('driverPointMessages.fell_in_vs_from_to', { metric, pct, period, baseline, from, to });
}

export function changeRose(metric: string, pct: string, period: string, baseline: string, from: string, to: string): string {
  return t('driverPointMessages.rose_in_vs_from_to', { metric, pct, period, baseline, from, to });
}

export function changeFellDay(metric: string, pct: string, period: string, baseline: string, from: string, to: string): string {
  return t('driverPointMessages.fell_on_vs_from_to', { metric, pct, period, baseline, from, to });
}

export function changeRoseDay(metric: string, pct: string, period: string, baseline: string, from: string, to: string): string {
  return t('driverPointMessages.rose_on_vs_from_to', { metric, pct, period, baseline, from, to });
}

/** A change with no percentage to give (a ratio, or a baseline of zero): the change itself. */
export function changeFellBy(metric: string, change: string, period: string, baseline: string, from: string, to: string): string {
  return t('driverPointMessages.fell_in_vs_from_to_2', { metric, change, period, baseline, from, to });
}

export function changeRoseBy(metric: string, change: string, period: string, baseline: string, from: string, to: string): string {
  return t('driverPointMessages.rose_in_vs_from_to_2', { metric, change, period, baseline, from, to });
}

export function changeFellByDay(metric: string, change: string, period: string, baseline: string, from: string, to: string): string {
  return t('driverPointMessages.fell_on_vs_from_to_2', { metric, change, period, baseline, from, to });
}

export function changeRoseByDay(metric: string, change: string, period: string, baseline: string, from: string, to: string): string {
  return t('driverPointMessages.rose_on_vs_from_to_2', { metric, change, period, baseline, from, to });
}

export function changeFlat(metric: string, period: string, baseline: string, value: string): string {
  return t('driverPointMessages.did_not_change_in_vs_in', { metric, period, baseline, value });
}

export function changeFlatDay(metric: string, period: string, baseline: string, value: string): string {
  return t('driverPointMessages.did_not_change_on_vs_on', { metric, period, baseline, value });
}

/** A measure as the header names it. */
export function measureSum(column: string): string {
  return t('driverPointMessages.sum_of', { column });
}

export function measureAvg(column: string): string {
  return t('driverPointMessages.average_of', { column });
}

export function measureCount(column: string): string {
  return t('driverPointMessages.count_of', { column });
}

/** The baseline picker: the period just before the one being explained. */
export function baselinePrevious(period: string): string {
  return t('driverPointMessages.previous_period', { period });
}

/** …and the same period a year earlier, when the chart reaches that far. */
export function baselineLastYear(period: string): string {
  return t('driverPointMessages.same_period_last_year', { period });
}

// ── Refusals: each is the whole answer, never an empty panel ─────────────────

/** The chart's axis is not a date rolled up to periods. */
export function pointNotTimeSeries(): string {
  return t('driverPointMessages.a_change_is_explained_between_two');
}

/** A map, a pivot, a cohort, a funnel, small multiples, a drivers tile, or a field from a related dataset. */
export function pointUnsupported(): string {
  return t('driverPointMessages.this_visual_is_not_a_plain');
}

/** The chart drew no period at all under its filters. */
export function pointNoPeriods(): string {
  return t('driverPointMessages.this_chart_has_no_periods_under');
}

/** A label that is not one of the chart's own buckets (a forecast point, a stale click). */
export function pointUnknownBucket(): string {
  return t('driverPointMessages.that_point_is_not_one_of');
}

/** The earliest bucket: nothing before it. */
export function pointFirstBucket(period: string): string {
  return t('driverPointMessages.is_the_first_period_on_this', { period });
}

/** A baseline that is not an earlier bucket of the same chart. */
export function pointUnknownBaseline(): string {
  return t('driverPointMessages.that_baseline_is_not_an_earlier');
}

/** min / max: one row's value. */
export function pointNotAdditive(): string {
  return t('driverPointMessages.this_chart_shows_a_minimum_or');
}

/** "Calculate as": a running total, a percent of total, a rank… */
export function pointTableCalc(): string {
  return t('driverPointMessages.this_measure_is_shown_through_a');
}

/** A series name that is not one of the chart's measures (a comparison overlay, a trend line). */
export function pointUnknownSeries(): string {
  return t('driverPointMessages.that_line_is_not_one_of');
}

/** The dashboard is read as of an earlier time. */
export function pointAsOf(): string {
  return t('driverPointMessages.a_change_is_explained_from_today');
}

/** The chart's money is converted to another currency. */
export function pointConverted(): string {
  return t('driverPointMessages.this_chart_s_figures_are_converted');
}

/** One of the two periods has no figure under the chart's filters. */
export function pointNoFigure(): string {
  return t('driverPointMessages.one_of_the_two_periods_has');
}

/** Too little to split by: no column has between `min` and `max` values in these periods. Both are formatted. */
export function pointNoDimension(min: string, max: string): string {
  return t('driverPointMessages.no_column_has_between_and_distinct', { min, max });
}

/** The measure is not a number that adds up (a total over a text column, say). */
export function pointNotSplittable(): string {
  return t('driverPointMessages.this_measure_does_not_add_up');
}
