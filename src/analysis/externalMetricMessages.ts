import { t } from '../app/i18n';
// What a person reads when a metric is defined in another tool's semantic layer (semantic layer part 7, b0) — MAIN,
// through the catalog. Its own file so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans only these.

/** A figure that needs a metric whose math lives in another tool's semantic layer, which this pod cannot ask. */
export function externalPending(name: string): string {
  return t('externalMetricMessages.is_defined_in_another_tool_s', { name });
}

/** The short form of such a definition, where a simple one says "sum of revenue" (b2 names the layer). */
export function definedElsewhere(): string {
  return t('externalMetricMessages.defined_in_another_tool');
}

/** "Duplicate" on such a metric: a second copy of a layer's definition. */
export function externalNoDuplicate(name: string): string {
  return t('externalMetricMessages.is_defined_in_another_tool_s_2', { name });
}

/** Key drivers (and a metric tree's split) of such a metric: its parts are the layer's, not this server's. */
export function externalNoSplit(): string {
  return t('externalMetricMessages.it_is_defined_in_another_tool');
}
