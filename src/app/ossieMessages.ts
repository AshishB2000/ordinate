import { t } from '../app/i18n';
// What the Ossie export's report says about each thing it could not map (semantic layer part 7, g1; ./ossieExport.ts).
// MAIN, through the catalog; its own file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans only these.

export function ossieWhy_term(): string {
  return (t('ossieMessages.ossie_has_no_named_filters_the'));
}

export function ossieWhy_valueLabels(): string {
  return (t('ossieMessages.ossie_has_no_value_labels_they'));
}

export function ossieWhy_baseFilters(): string {
  return (t('ossieMessages.ossie_has_no_always_applied_filters'));
}

export function ossieWhy_role(): string {
  return (t('ossieMessages.ossie_has_no_fact_or_dimension'));
}

export function ossieWhy_sensitivity(): string {
  return (t('ossieMessages.sensitivity_marks_are_never_exported'));
}

export function ossieWhy_metricFilters(): string {
  return (t('ossieMessages.ossie_metrics_have_no_filters_and'));
}

export function ossieWhy_metricBaseFilters(): string {
  return t('ossieMessages.a_metric_on_a_dataset_with');
}

export function ossieWhy_metricCountText(): string {
  return t('ossieMessages.ordinate_counts_only_text_that_is');
}

export function ossieWhy_metricFormula(): string {
  return (t('ossieMessages.ossie_metrics_cannot_refer_to_other'));
}

export function ossieWhy_metricSnapshot(): string {
  return (t('ossieMessages.ossie_has_no_semi_additive_measure'));
}

export function ossieWhy_metricDate(): string {
  return (t('ossieMessages.ossie_does_not_say_which_date'));
}

export function ossieWhy_metricSettings(): string {
  return (t('ossieMessages.ossie_has_no_number_format_direction'));
}

export function ossieWhy_cardinality(): string {
  return (t('ossieMessages.ossie_has_no_one_to_one'));
}

export function ossieWhy_relationship(): string {
  return (t('ossieMessages.a_dataset_of_this_relationship_is'));
}

export function ossieWhy_calendar(): string {
  return (t('ossieMessages.ossie_has_no_calendar_settings'));
}

export const ossieWhy = {
  term: ossieWhy_term,
  valueLabels: ossieWhy_valueLabels,
  baseFilters: ossieWhy_baseFilters,
  role: ossieWhy_role,
  sensitivity: ossieWhy_sensitivity,
  metricFilters: ossieWhy_metricFilters,
  metricBaseFilters: ossieWhy_metricBaseFilters,
  metricCountText: ossieWhy_metricCountText,
  metricFormula: ossieWhy_metricFormula,
  metricSnapshot: ossieWhy_metricSnapshot,
  metricDate: ossieWhy_metricDate,
  metricSettings: ossieWhy_metricSettings,
  cardinality: ossieWhy_cardinality,
  relationship: ossieWhy_relationship,
  calendar: ossieWhy_calendar,
} as const;
