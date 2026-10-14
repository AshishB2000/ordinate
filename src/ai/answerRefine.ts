// A FOLLOW-UP as a CHANGE to the answer on screen — MAIN PROCESS, PURE: no fs, no model.
//
// "Now only enterprise" after "revenue by region last quarter" is not a new
// question: it is the same chart with one more filter. The model says only WHAT
// CHANGES — {"refine":true, …}, as ./suggestedAction's prompt spells it — and
// this file lays that patch over the previous answer's stored spec.
//
// What comes back is a RAW spec, which goes through validateAnswerSpec like any
// other: one validator, one set of rules. Nothing here decides whether a name is
// real. It only decides which parts of the previous answer the patch replaces,
// so a model that re-typed nothing can drop nothing.

import type { VizMeasure } from '../analysis/visuals';
import { defaultAnswerChart, resolveColumn } from './answerSpec';
import type { AnswerSpec, SpecDataset, SpecMetric } from './answerSpec';

/** The patch's own two keys, as the prompt spells them (scripts/test-suggestedAction.ts ties the two). */
export const REFINE_KEY = 'refine';
export const DROP_FILTERS_KEY = 'dropFilters';

/** A spec that asks to continue the previous answer: `"refine": true`, exactly. */
export function isRefine(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>)[REFINE_KEY] === true;
}

/**
 * The previous answer with the patch laid over it, as a raw spec to validate.
 *
 *   - the dataset is ALWAYS the previous one, whatever the patch names;
 *   - `category`, `measures` (or `measure`), `chartType` and `top` (or `limit`)
 *     replace when the patch carries them; `"top": null` removes the cut;
 *   - `series` replaces, and `"series": null` removes the split;
 *   - a filter in the patch replaces EVERY previous filter on the same column —
 *     the column found by the validator's own name rules, taught names included,
 *     so "Segment" and "segment" are one column — and is added otherwise. A
 *     period on a date column is the same rule: it replaces the period before it;
 *   - `dropFilters` removes the previous filters on the columns it names.
 *
 * A chart type nobody chose — the default for the previous shape — is left for
 * the validator to choose again, so a split added to a column chart is drawn as
 * clusters and not as a chart the new shape does not fit. A chosen one is kept.
 *
 * `metrics` lets a carried measure keep its link to a defined metric: it is
 * named the way the validator resolves one, and only when that gives the very
 * measure back. Otherwise it is carried as its column and aggregation.
 */
export function refineSpec(previous: AnswerSpec, patch: unknown, dataset: SpecDataset, metrics: SpecMetric[] = []): unknown {
  const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? (patch as Record<string, unknown>) : {};
  const real = (said: unknown): string | null => resolveColumn(said, dataset.columns, dataset.names)?.name ?? null;

  const carried = (m: VizMeasure): unknown => {
    const metric = m.metricId ? metrics.find((x) => x.id === m.metricId) : undefined;
    const byName = !!metric && !metric.hasFilters && metric.column === m.column && !resolveColumn(metric.name, dataset.columns)
      && metrics.find((x) => x.datasetId === dataset.id && x.name.trim().toLowerCase() === metric.name.trim().toLowerCase()) === metric;
    return byName ? { metric: metric.name } : { column: m.column, aggregation: m.aggregation };
  };

  const added: unknown[] = Array.isArray(p.filters) ? p.filters : [];
  const gone = new Set<string>();
  // A drop the dataset has no column for is handed on as a filter on that name:
  // the validator then refuses it by the name that was said, like any other.
  const unknownDrops: unknown[] = [];
  for (const said of ([] as unknown[]).concat(p[DROP_FILTERS_KEY] ?? [])) {
    const name = real(said);
    if (name) gone.add(name);
    else unknownDrops.push({ column: said });
  }
  for (const f of added) {
    const name = f && typeof f === 'object' ? real((f as { column?: unknown }).column) : null;
    if (name) gone.add(name);
  }

  const merged: Record<string, unknown> = {
    dataset: previous.datasetId,
    category: p.category ?? previous.category,
    measures: p.measures ?? (p.measure != null ? [p.measure] : previous.measures.map(carried)),
    filters: [...previous.filters.filter((f) => !gone.has(f.column)), ...added, ...unknownDrops],
  };
  const series = p.series !== undefined ? p.series : previous.series;
  if (series != null) merged.series = series;
  const top = p.top !== undefined ? p.top : p.limit !== undefined ? p.limit : previous.top;
  if (top != null) merged.top = top;

  const typeOf = (name: string): string => dataset.columns.find((c) => c.name === name)?.type ?? 'text';
  const chosen = previous.chartType !== defaultAnswerChart(typeOf(previous.category), !!previous.series);
  if (p.chartType != null) merged.chartType = p.chartType;
  else if (chosen) merged.chartType = previous.chartType;
  // The date axis keeps its roll-up while it is still the axis.
  if (previous.grain && p.category == null) merged.grain = previous.grain;
  return merged;
}
