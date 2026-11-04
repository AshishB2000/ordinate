// What a person reads when a formula cannot run as a Live calculated field (semantic layer part 8,
// step 03: src/engine/live/formulaSql.ts) — MAIN, through the catalog. Its own file so the i18n
// extractor (scripts/i18n-extract.ts MAIN_FILES) scans these sentences and nothing else. Names arrive
// as the formula wrote them; no value from a row ever appears here.

import type { LiveFnReason } from './live/formulaSqlFunctions';
import { t } from '../app/i18n';

/** A function Live does not run, and why. */
export function calcFunctionRefused(name: string, reason: LiveFnReason): string {
  switch (reason) {
    case 'math': return t('formulaSqlMessages.can_t_run_on_a_live', { name });
    case 'characters': return t('formulaSqlMessages.can_t_run_on_a_live_2', { name });
    case 'casing': return t('formulaSqlMessages.can_t_run_on_a_live_3', { name });
    case 'regex': return t('formulaSqlMessages.can_t_run_on_a_live_4', { name });
    case 'dates': return t('formulaSqlMessages.can_t_run_on_a_live_5', { name });
    case 'clock': return t('formulaSqlMessages.can_t_run_on_a_live_6', { name });
    case 'conversion': return t('formulaSqlMessages.can_t_run_on_a_live_7', { name });
    default: return t('formulaSqlMessages.can_t_run_on_a_live_8', { name });
  }
}

export function calcModRefused(): string {
  return t('formulaSqlMessages.can_t_run_on_a_live_9');
}

export function calcLodRefused(): string {
  return t('formulaSqlMessages.a_level_of_detail_expression_can');
}

export function calcParamRefused(): string {
  return t('formulaSqlMessages.a_dashboard_parameter_can_t_be');
}

export function calcLaterCalc(name: string): string {
  return t('formulaSqlMessages.is_a_calculated_field_that_comes', { name });
}

export function calcNeedsNumber(what: string): string {
  return t('formulaSqlMessages.needs_a_number_here', { what });
}

export function calcNeedsText(what: string): string {
  return t('formulaSqlMessages.needs_text_here', { what });
}

export function calcNeedsDate(what: string): string {
  return t('formulaSqlMessages.needs_a_date_column_here', { what });
}

export function calcCompareTypes(op: string): string {
  return t('formulaSqlMessages.compares_two_values_of_one_type', { op });
}

export function calcSameType(what: string): string {
  return t('formulaSqlMessages.every_result_of_must_have_the', { what });
}

export function calcNumberTooLarge(): string {
  return t('formulaSqlMessages.this_number_is_too_large_for');
}

export function calcNotBoolean(what: string): string {
  return t('formulaSqlMessages.needs_a_true_or_false_test', { what });
}

export function calcNotLiteral(what: string): string {
  return t('formulaSqlMessages.needs_a_fixed_value_here_such', { what });
}

export function calcArity(name: string, count: string): string {
  return t('formulaSqlMessages.can_t_take_values_on_a', { name, count });
}

export function calcDateColumn(name: string): string {
  return t('formulaSqlMessages.holds_its_dates_as_text_so', { name });
}

export function calcDateResult(): string {
  return t('formulaSqlMessages.a_live_calculated_field_can_t');
}

export function calcTimestampCompare(): string {
  return t('formulaSqlMessages.a_date_that_holds_a_time');
}

export function calcRoundDigits(): string {
  return t('formulaSqlMessages.round_on_a_live_table_takes');
}

export function calcDatediffPart(): string {
  return t('formulaSqlMessages.datediff_on_a_live_table_counts');
}

export function calcTooLong(): string {
  return t('formulaSqlMessages.this_formula_is_too_long_to');
}
