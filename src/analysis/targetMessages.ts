import { t } from '../app/i18n';
// What a metric's target says when it has no figure, and how it was worked out (semantic layer part 5, step 09) — MAIN,
// through the catalog. Its own file so the i18n extractor scans only sentences. Figures arrive formatted.

/** An additive metric with no closed period in scope: nothing says how much of the target has elapsed. */
export function targetPickPeriod(): string {
  return t('targetMessages.pick_a_period_to_see_the');
}

/** A filter the plan's dataset can't apply: the target would be the plan of something else. */
export function targetPlanLacks(column: string): string {
  return t('targetMessages.the_plan_has_no_so_there', { column });
}

/** A glossary term that doesn't expand on the plan's dataset. */
export function targetPlanTerm(): string {
  return t('targetMessages.a_glossary_term_in_this_filter');
}

/** Row access rules restrict the actuals and the plan differently (or one only). */
export function targetRowRules(): string {
  return t('targetMessages.the_target_comes_from_data_your');
}

/** The plan metric was deleted. */
export function targetPlanGone(): string {
  return t('targetMessages.the_plan_metric_was_deleted');
}

/** `how` for a period in progress: the target for the whole period, pro-rated to a day. */
export function targetHowProRated(full: string, period: string, to: string): string {
  return t('targetMessages.for_pro_rated_to', { full, period, to });
}

/** `how` for a whole period. */
export function targetHowWhole(full: string, period: string): string {
  return t('targetMessages.for_all_of', { full, period });
}

/** A metric that adds up over time, with a target that doesn't say what period its figure covers. */
export function targetNeedsPer(): string {
  return t('targetMessages.a_target_for_a_metric_that');
}

/** A plan metric with no date: it can't be matched to a period. */
export function targetPlanNoDate(name: string): string {
  return t('targetMessages.has_no_date_it_counts_by', { name });
}

/** A metric as its own plan. */
export function targetOwnPlan(): string {
  return t('targetMessages.a_metric_can_t_be_its');
}

/** A per-period target for a metric that counts by no date. */
export function targetNeedsDate(): string {
  return t('targetMessages.a_target_for_each_period_needs');
}

/** A chart with more dates than a target line is drawn for. */
export function targetSeriesTooLong(): string {
  return t('targetMessages.the_target_is_drawn_for_at');
}

/** A chart by a column the plan doesn't have: the target can't be split that way. */
export function targetPlanNoColumn(column: string): string {
  return t('targetMessages.the_plan_has_no_so_the', { column });
}

/** A period metric that compares periods (a change, a % change, last year's figure): no plan is for that. */
export function targetOnCompare(): string {
  return t('targetMessages.a_metric_that_compares_periods_has');
}
