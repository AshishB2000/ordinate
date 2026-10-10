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
