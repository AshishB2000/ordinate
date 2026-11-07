import { t } from '../app/i18n';
// What a person reads when a semantic layer cannot answer a question (semantic layer part 7, b1;
// docs/semantic-layer/07-portability.md D16, D17) — MAIN, through the catalog. Its own file, beside
// ./liveRefusals.ts, so the i18n extractor (scripts/i18n-extract.ts MAIN_FILES) scans only these
// sentences; ./live/semantic/semanticRefusals.ts types them. Names arrive as written: the dataset's,
// the layer's (Snowflake, Cube, dbt), the metric's and the field's. No figure, value or row-rule
// value ever appears here.

/** A layer whose backend this server has no name for. */
export function anotherTool(): string {
  return t('semanticMessages.another_tool');
}

// ── Needs rows: refused on every Live dataset, here naming the layer ─────────

export function layerPivot(dataset: string, layer: string): string {
  return t('semanticMessages.a_pivot_table_can_t_be', { dataset, layer });
}

export function layerCohort(dataset: string, layer: string): string {
  return t('semanticMessages.a_cohort_chart_can_t_be', { dataset, layer });
}

export function layerFunnel(dataset: string, layer: string): string {
  return t('semanticMessages.an_event_funnel_can_t_be', { dataset, layer });
}

export function layerDrivers(dataset: string, layer: string): string {
  return t('semanticMessages.key_drivers_can_t_be_worked', { dataset, layer });
}

export function layerFacet(dataset: string, layer: string): string {
  return t('semanticMessages.small_multiples_can_t_be_drawn', { dataset, layer });
}

export function layerMap(dataset: string, layer: string): string {
  return t('semanticMessages.a_map_can_t_be_drawn', { dataset, layer });
}

export function layerRaw(dataset: string, layer: string): string {
  return t('semanticMessages.single_points_can_t_be_drawn', { dataset, layer });
}

export function layerRelated(dataset: string, layer: string): string {
  return t('semanticMessages.a_field_from_a_related_dataset', { dataset, layer });
}

// ── Needs our arithmetic on the layer's figures ──────────────────────────────

export function layerBins(dataset: string, layer: string, column: string): string {
  return t('semanticMessages.can_t_be_grouped_into_number', { column, dataset, layer });
}

export function layerWeekRollup(dataset: string, layer: string): string {
  return t('semanticMessages.retail_calendar_periods_can_t_be', { dataset, layer });
}

export function layerAutoGrain(dataset: string, layer: string, column: string): string {
  return t('semanticMessages.choose_a_grain_that_lists_for', { layer, column, dataset });
}

export function layerNonAdditiveCalc(layer: string, metric: string): string {
  return t('semanticMessages.can_t_be_added_up_so', { metric, layer });
}

export function layerFormulaOverLayer(layer: string, metric: string): string {
  return t('semanticMessages.a_formula_can_t_use_computes', { metric, layer });
}

export function layerColumnOnLayer(dataset: string, layer: string, column: string): string {
  return t('semanticMessages.is_a_field_of_not_a', { column, dataset, layer });
}

export function layerMetricOnTable(metric: string): string {
  return t('semanticMessages.is_a_metric_from_a_semantic', { metric });
}

export function layerMetricMissing(layer: string, metric: string): string {
  return t('semanticMessages.is_no_longer_defined_in', { metric, layer });
}

export function layerRowPolicy(dataset: string, layer: string): string {
  return t('semanticMessages.your_access_to_is_limited_to', { dataset, layer });
}

export function layerLookup(dataset: string, layer: string): string {
  return t('semanticMessages.this_question_needs_the_latest_date', { dataset, layer });
}

export function layerFilter(dataset: string, layer: string, column: string): string {
  return t('semanticMessages.can_t_apply_this_filter_on', { layer, column, dataset });
}

// ── A semantic dataset (b2) ──────────────────────────────────────────────────

/** A schema sync's sample, skipped on a semantic dataset: no rows, so nothing is detected. */
export function layerNotSampled(layer: string): string {
  return t('semanticMessages.computes_this_dataset_s_figures_so', { layer });
}

/** Listing or adding a layer's models from a connection whose connector has no semantic layer. */
export function noLayer(): string {
  return t('semanticMessages.this_connection_has_no_semantic_layer');
}

/** The layer did not answer a listing or a describe: its own words are in the server log. */
export function layerReadFailed(layer: string): string {
  return t('semanticMessages.didn_t_answer_so_nothing_changed', { layer });
}

/** `live:setBaseFilters` on a semantic dataset (cross-part check 14). */
export function layerBaseFilter(layer: string): string {
  return t('semanticMessages.always_applied_filters_are_not_available', { layer });
}

/** A mirror metric's definition in a picker, the Metrics table and a model's facts. */
export function definedIn(layer: string): string {
  return t('semanticMessages.defined_in', { layer });
}

/** An edit of a mirror metric's definition or filters: the layer's to change. */
export function externalReadOnly(layer: string): string {
  return t('semanticMessages.defined_in_edit_it_there', { layer });
}

/** "Make a copy" or "Copy the data instead" of a semantic dataset. */
export function semanticNoCopy(dataset: string, layer: string): string {
  return t('semanticMessages.a_copy_can_t_be_made', { dataset, layer });
}

/** Adding a semantic dataset to a project that is gone. */
export function addNoProject(): string {
  return t('semanticMessages.invalid_project_or_the_project_no');
}

/** Adding a semantic dataset failed for a reason only the log holds. */
export function addFailed(): string {
  return t('semanticMessages.could_not_add_the_dataset');
}
