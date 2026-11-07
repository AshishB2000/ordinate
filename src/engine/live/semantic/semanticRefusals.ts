// A question a semantic layer cannot answer, typed (semantic layer part 7, b1; docs/semantic-layer/07-portability.md
// D16, D17) — PURE. The twin of ../liveSpec's `refuse` for the layer codes: the same `LiveRefusal`, but a sentence
// that names the dataset and the layer (and the metric or field it is about), so ../liveSpec's one-parameter
// MESSAGES stay untouched. The row-needing codes (pivot, cohort, …) keep their code on a semantic dataset and take a
// sentence naming the layer instead. `key`/`params` name the catalog sentence (test-semanticPlan renders each).

import type { LayerRefusalCode, LiveRefusal } from '../liveSpec';
import * as msg from '../../semanticMessages';

/** The row-needing codes that are already refused on Live; on a semantic dataset the sentence names the layer. */
export type RowNeedingCode = 'pivot' | 'cohort' | 'funnel' | 'drivers' | 'facet' | 'map' | 'raw' | 'related';

export interface LayerNames {
  dataset: string;
  layer: string;
  metric?: string;
  column?: string;
}

type P = Required<LayerNames>;
interface Sentence {
  key: string;
  /** The ICU parameters the sentence takes, from the names. */
  params: (p: P) => Record<string, string>;
  text: (p: P) => string;
}

const DL = (p: P): Record<string, string> => ({ dataset: p.dataset, layer: p.layer });
const DLC = (p: P): Record<string, string> => ({ dataset: p.dataset, layer: p.layer, column: p.column });
const LM = (p: P): Record<string, string> => ({ layer: p.layer, metric: p.metric });

const SENTENCES: Record<LayerRefusalCode | RowNeedingCode, Sentence> = {
  pivot: { key: 'semanticMessages.a_pivot_table_can_t_be', params: DL, text: (p) => msg.layerPivot(p.dataset, p.layer) },
  cohort: { key: 'semanticMessages.a_cohort_chart_can_t_be', params: DL, text: (p) => msg.layerCohort(p.dataset, p.layer) },
  funnel: { key: 'semanticMessages.an_event_funnel_can_t_be', params: DL, text: (p) => msg.layerFunnel(p.dataset, p.layer) },
  drivers: { key: 'semanticMessages.key_drivers_can_t_be_worked', params: DL, text: (p) => msg.layerDrivers(p.dataset, p.layer) },
  facet: { key: 'semanticMessages.small_multiples_can_t_be_drawn', params: DL, text: (p) => msg.layerFacet(p.dataset, p.layer) },
  map: { key: 'semanticMessages.a_map_can_t_be_drawn', params: DL, text: (p) => msg.layerMap(p.dataset, p.layer) },
  raw: { key: 'semanticMessages.single_points_can_t_be_drawn', params: DL, text: (p) => msg.layerRaw(p.dataset, p.layer) },
  related: { key: 'semanticMessages.a_field_from_a_related_dataset', params: DL, text: (p) => msg.layerRelated(p.dataset, p.layer) },
  bins: { key: 'semanticMessages.can_t_be_grouped_into_number', params: DLC, text: (p) => msg.layerBins(p.dataset, p.layer, p.column) },
  weekRollup: { key: 'semanticMessages.retail_calendar_periods_can_t_be', params: DL, text: (p) => msg.layerWeekRollup(p.dataset, p.layer) },
  autoGrain: { key: 'semanticMessages.choose_a_grain_that_lists_for', params: DLC, text: (p) => msg.layerAutoGrain(p.dataset, p.layer, p.column) },
  nonAdditiveCalc: { key: 'semanticMessages.can_t_be_added_up_so', params: LM, text: (p) => msg.layerNonAdditiveCalc(p.layer, p.metric) },
  formulaOverLayer: { key: 'semanticMessages.a_formula_can_t_use_computes', params: LM, text: (p) => msg.layerFormulaOverLayer(p.layer, p.metric) },
  columnOnLayer: { key: 'semanticMessages.is_a_field_of_not_a', params: DLC, text: (p) => msg.layerColumnOnLayer(p.dataset, p.layer, p.column) },
  metricOnTable: { key: 'semanticMessages.is_a_metric_from_a_semantic', params: (p) => ({ metric: p.metric }), text: (p) => msg.layerMetricOnTable(p.metric) },
  metricMissing: { key: 'semanticMessages.is_no_longer_defined_in', params: LM, text: (p) => msg.layerMetricMissing(p.layer, p.metric) },
  layerRowPolicy: { key: 'semanticMessages.your_access_to_is_limited_to', params: DL, text: (p) => msg.layerRowPolicy(p.dataset, p.layer) },
  layerLookup: { key: 'semanticMessages.this_question_needs_the_latest_date', params: DL, text: (p) => msg.layerLookup(p.dataset, p.layer) },
  layerFilter: { key: 'semanticMessages.can_t_apply_this_filter_on', params: DLC, text: (p) => msg.layerFilter(p.dataset, p.layer, p.column) },
};

/** Every code `refuseLayer` words, in a stable order (test-semanticPlan renders each). */
export const LAYER_CODES = Object.keys(SENTENCES) as (LayerRefusalCode | RowNeedingCode)[];

export function refuseLayer(code: LayerRefusalCode | RowNeedingCode, names: LayerNames): LiveRefusal {
  const s = SENTENCES[code];
  const p: P = { dataset: names.dataset, layer: names.layer, metric: names.metric ?? '', column: names.column ?? '' };
  return { ok: false, code, key: s.key, params: s.params(p), message: s.text(p) };
}

// ── The layer's name ─────────────────────────────────────────────────────────

/** The shipped backends' product names (part 7: c1, e1, d1). A test adapter adds its own with `registerLayerLabel`. */
const LABELS = new Map<string, string>([['snowflake', 'Snowflake'], ['cube', 'Cube'], ['dbt', 'dbt']]);

/** A test adapter's label (scripts/semanticFake.ts). A shipped backend's name is never replaced. */
export function registerLayerLabel(id: string, label: string): void {
  if (!LABELS.has(id)) LABELS.set(id, label);
}

/** The product name of a backend this pod knows, or null. */
export function knownLayerLabel(id: string): string | null {
  return LABELS.get(id) ?? null;
}

/** What a sentence calls the layer behind backend `id`: its product name, or "another tool". */
export function layerLabel(id: string): string {
  return LABELS.get(id) ?? msg.anotherTool();
}
