// Can a measure be added up? (semantic layer part 1, D7) Derived from what the measure IS, never typed in.
// A running total, a percent of total and a moving sum add the measure's values, so they are right only when
// the values add: a sum of averages is not an average. A snapshot (a stock count) adds across categories but
// not across time. A period metric's window (part 5, D10) adds across categories as its base does and never across
// time (two YTDs overlap); a compare adds across neither. A funnel's entered and converted add across categories (one entry
// per entity), never across time; its rate across neither.
//
//   categories   the values of two members of a dimension (two regions) add to the whole
//   time         the values of two periods (two days) add to the whole
//
// The rule is PURE: it reads a metric record and the dataset's column list. The chart check at the foot reads
// metric records and dataset metadata, never a row, so a Live chart is not hydrated.

import type { ParsedColumn } from '../data/parse';
import { aggWord } from '../data/aggregations';
import { getDatasetMeta } from '../data/datasets';
import type { Metric } from './metrics';
import { getMetric, isExternalDefinition, isFormulaDefinition, isFunnelDefinition, isPeriodDefinition, metricsByName } from './metrics';
import { isNewerKind } from './pendingKinds';
import { metricShape } from './driverShape';
import { tokenize } from '../formula/formulaTokens';
import type { ParamValues } from './params';
import { CALC_KIND_NAMES, calcAlong, sanitizeTableCalc } from './tableCalc';
import type { TableCalcKind } from './tableCalc';
import type { VizEncoding, VizMeasure } from './visuals';
import { calcNotAdditive, calcNotAdditiveOverTime } from './metricCheckMessages';
import { layerLabel, refuseLayer } from '../engine/live/semantic/semanticRefusals';

export interface Additivity { categories: boolean; time: boolean }

// A new aggregation is not additive until it is added to this list.
const ADDS: ReadonlySet<string> = new Set(['sum', 'count', 'none']);
const ADDING: ReadonlySet<TableCalcKind> = new Set<TableCalcKind>(['running_total', 'pct_of_total', 'moving_sum']);

/** `sum`, `count` and `none` (the raw value) add; every other aggregation, an unknown or missing one included, does not. */
export function aggregationAdditivity(aggregation: string): Additivity {
  const adds = ADDS.has(aggregation);
  return { categories: adds, time: adds };
}

/** Whether the metric's figures add up across categories and across time. Never throws. */
export function additivityOf(
  m: Pick<Metric, 'datasetId' | 'definition' | 'filters' | 'name'>,
  columns: ParsedColumn[],
  byName: Map<string, Metric>,
  params?: ParamValues,
): Additivity {
  const def = m.definition;
  if (isPeriodDefinition(def)) {
    const base = baseIn(def.base, byName);
    const b = base && !isPeriodDefinition(base.definition) ? additivityOf(base, columns, byName, params) : null;
    return { categories: !!b?.categories && !def.compare, time: false };
  }
  if (isFunnelDefinition(def)) return { categories: def.show !== 'rate', time: false }; // D7: one entry per entity adds across categories, never across time; a rate adds across neither
  if (isExternalDefinition(def)) return { categories: def.additive === true, time: def.additive === true }; // D16: only where the layer says plain sum or count
  if (!isFormulaDefinition(def)) {
    const a = aggregationAdditivity(def.aggregation);
    return def.snapshot ? { categories: a.categories, time: false } : a;
  }
  // shortcut: a formula over a snapshot metric reads as not additive (metricShape refuses snapshots); give metricShape a linearity-only mode when snapshot formulas need running totals.
  const adds = metricShape(m.datasetId, columns, def, m.filters, byName, params, m.name).kind === 'additive';
  return { categories: adds, time: adds };
}

/** A period metric's base, by id, from the project's metrics by name. */
const baseIn = (id: string, byName: Map<string, Metric>): Metric | undefined => [...byName.values()].find((b) => b.id === id);

/** Whether this formula, or a metric it follows, names a `[[parameter]]` that `params` does not hold or holds empty (null, or a list, which binds to null). */
function needsUnknownParam(formula: string, byName: Map<string, Metric>, params: ParamValues | undefined, seen: Set<string>): boolean {
  let toks;
  try { toks = tokenize(formula); } catch { return false; }
  for (const t of toks) {
    if (t.kind === 'param') {
      const p = params?.get(t.value.toLowerCase());
      if (!p || p.value == null || Array.isArray(p.value)) return true;
    } else if (t.kind === 'col' || t.kind === 'name') {
      const key = t.value.toLowerCase();
      const followed = byName.get(key)?.definition;
      if (seen.has(key) || !followed || !isFormulaDefinition(followed)) continue;
      seen.add(key);
      if (needsUnknownParam(followed.formula, byName, params, seen)) return true;
    }
  }
  return false;
}

/**
 * A saved metric's additivity, or null when it is not known: the metric is gone, or its formula (or one it follows)
 * names a `[[parameter]]` whose value is not in `params` or is empty (a dashboard supplies them). Reads the dataset's column list for
 * a formula only, never a row. Never throws.
 */
export async function metricAdditivity(projectId: string, id: string, byName: Map<string, Metric>, params?: ParamValues): Promise<Additivity | null> {
  try {
    const m = await getMetric(projectId, id);
    if (!m) return null;
    const own = isPeriodDefinition(m.definition) ? baseIn(m.definition.base, byName) ?? m : m; // a period metric adds as its base does
    if (!isFormulaDefinition(own.definition)) return additivityOf(m, [], byName);
    if (needsUnknownParam(own.definition.formula, byName, params, new Set([own.name.toLowerCase()]))) return null;
    return additivityOf(m, (await getDatasetMeta(projectId, m.datasetId))?.columns ?? [], byName, params);
  } catch {
    return null;
  }
}

/** The side a calc needs the measure to add on: `time` along a date axis, else `categories`. Null when it adds nothing. */
export function calcNeedsAdditive(kind: TableCalcKind, alongTime: boolean): 'categories' | 'time' | null {
  return ADDING.has(kind) ? (alongTime ? 'time' : 'categories') : null;
}

/** The sentence that refuses `kind` of `measure`, or null when the measure adds on the side the calc needs. */
export function calcRefusal(measure: string, kind: TableCalcKind, a: Additivity, alongTime: boolean): string | null {
  const needs = calcNeedsAdditive(kind, alongTime);
  if (!needs || a[needs]) return null;
  return needs === 'time' && a.categories ? calcNotAdditiveOverTime(measure, CALC_KIND_NAMES[kind]) : calcNotAdditive(measure, CALC_KIND_NAMES[kind]);
}

/** What a measure is called in a sentence, and whether it adds. A metric that is gone (or is on another dataset) is what is plotted: its stored aggregation. */
async function resolveMeasure(
  projectId: string, datasetId: string, m: VizMeasure, params?: ParamValues, plotsStored = false,
): Promise<{ name: string; additivity: Additivity; layer?: string }> {
  const dataset = m.datasetId ?? datasetId;
  const found = m.metricId ? await getMetric(projectId, m.metricId) : null;
  const metric = found && found.datasetId === dataset ? found : null;
  const stored = { name: metric?.name ?? `${aggWord(m.aggregation)} of ${m.column}`, additivity: aggregationAdditivity(m.aggregation) };
  if (!metric || plotsStored) return stored;
  const def = metric.definition;
  if (!isFormulaDefinition(def) && !isNewerKind(def) && !isExternalDefinition(def) && !def.snapshot) return stored;
  // The columns and the other metrics are read for a formula (or a period metric: its base) only; a snapshot's rule needs neither.
  const formula = isFormulaDefinition(def) || isPeriodDefinition(def);
  const columns = formula ? (await getDatasetMeta(projectId, dataset))?.columns ?? [] : [];
  const byName = formula ? await metricsByName(projectId) : new Map<string, Metric>();
  return { name: metric.name, additivity: additivityOf(metric, columns, byName, params), ...(isExternalDefinition(def) ? { layer: def.layer ?? '' } : {}) };
}

/** Whether a chart measure's figures add up across categories and across time. Step 03 passes `followedEncoding(...)` as the encoding wherever it asks the chart door. */
export async function measureAdditivity(projectId: string, datasetId: string, m: VizMeasure, params?: ParamValues): Promise<Additivity> {
  return (await resolveMeasure(projectId, datasetId, m, params)).additivity;
}

/**
 * The reply itself, or a refusal when a running total, percent of total or moving sum is asked of a measure that
 * does not add. A chart checks the measures it calculates (a split chart calculates `values[0]` only); a pivot
 * plots the stored column, so each value is judged by its aggregation, across categories. The first refusal wins.
 * A chart with no adding calc, or a reply that is not ok, comes back as the very object, with nothing read.
 */
export async function refuseNonAdditiveCalcs<R extends { ok: boolean; category?: { kind?: string } }>(
  reply: R, projectId: string, datasetId: string, enc: VizEncoding, params?: ParamValues,
): Promise<R | { ok: false; error: string; code: 'calc_not_additive' } | { ok: false; error: string; code: 'live_refused'; reason: 'nonAdditiveCalc' }> {
  // A map plots no calc (applyChartCalcs), so there is no total to get wrong.
  if (!reply.ok || enc.geo) return reply;
  const pivot = enc.pivot ?? null;
  const all = Array.isArray(enc.values) ? enc.values : [];
  const values: VizMeasure[] = pivot ? pivot.values : enc.series ? all.slice(0, 1) : all;
  for (const m of Array.isArray(values) ? values : []) {
    const calc = sanitizeTableCalc(m?.calc);
    if (!calc || !calcNeedsAdditive(calc.kind, false)) continue;
    const { name, additivity, layer } = await resolveMeasure(projectId, datasetId, m, params, !!pivot);
    let alongTime = false; // a pivot plots the stored column, never along time
    if (!pivot) {
      // The split column's declared type matters only to a measure that adds on one side and not the other.
      const needsSplitType = additivity.categories !== additivity.time && !!enc.series;
      alongTime = calcAlong(calc, enc) === 'across'
        ? reply.category?.kind === 'date'
        : needsSplitType && (await getDatasetMeta(projectId, enc.seriesDatasetId ?? datasetId))?.columns.find((c) => c.name === enc.series)?.type === 'date';
    }
    const error = calcRefusal(name, calc.kind, additivity, alongTime);
    // A layer's metric says so naming the layer (part 7 b2, D16): its figures are never added up here.
    if (error && layer !== undefined) return { ok: false, error: refuseLayer('nonAdditiveCalc', { dataset: '', layer: layerLabel(layer), metric: name }).message, code: 'live_refused', reason: 'nonAdditiveCalc' };
    if (error) return { ok: false, error, code: 'calc_not_additive' };
  }
  return reply;
}
