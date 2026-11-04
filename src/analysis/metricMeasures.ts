// A chart measure that IS a formula metric — MAIN PROCESS. Reads the metrics
// store and dataset metadata; never a row.
//
// `Margin % = sum(profit) / sum(revenue)` on a chart by region must be each
// region's profit over each region's revenue: CALCULATED AFTER TOTALS. Averaging
// per-row ratios, or dividing one chart-wide figure, gives a plausible number
// that is wrong in a way no one can see (the same rule ipc/metrics.ts holds for
// a KPI, where the scope is a filter instead of a category).
//
// So a formula measure is PLANNED here into its leaves — the plain
// `{column, aggregation}` totals it is made of, each with the filters of the
// metric that owns it — and ipc/vizMetricMeasures.ts asks the one chart door
// for those leaves (resident, JS or a Live warehouse: the door decides) and
// evaluates the formula on each cell's totals with the ordinary formula engine.
// Nothing here aggregates: the leaves are the engines' figures, and the only
// arithmetic is the user's own expression over them.
//
// A SIMPLE metric measure is drawn as the metric defines it now (D16): its
// column, its aggregation and its own filters. One filter list shared by every
// measure rides on the chart's filters in one question; measures that need
// different rows are planned here as leaves. The copy the chart stored is only
// the fallback for a metric that is gone (visuals.VizMeasure).

import * as metrics from './metrics';
import type { Metric } from './metrics';
import { isFormulaDefinition } from './metrics';
import { compileMetricFormula, evaluateMetricFormula } from './metricFormula';
import type { MetricFormulaProgram } from './metricFormula';
import type { MetricAggregation } from './metricValue';
import { bindFormulaText, resolveFilterParams } from './params';
import type { ParamValues } from './params';
import type { VizEncoding, VizMeasure } from './visuals';
import { measureLabel } from './vizData';
import * as datasets from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import * as msg from './metricCheckMessages';

/** How deep `[A]` → `[B]` may go — ipc/metrics.ts's MAX_FORMULA_DEPTH, for the same reason. */
const MAX_DEPTH = 10;

/** One total the door is asked for: a column, an aggregation, and its metric's OWN filters. */
export interface Leaf {
  column: string;
  aggregation: MetricAggregation;
  filters: FilterStep[];
}

/** A leaf by index, or a formula over operands keyed by the reference as written. */
export type Operand = { leaf: number } | { program: MetricFormulaProgram; operands: Map<string, Operand | null> };

export interface MeasurePlan {
  leaves: Leaf[];
  /** By `encoding.values` index: the measures to calculate (`simple`: a filtered simple metric as one leaf). Every other index plots as given. */
  formulas: Map<number, { name: string; root: Operand; simple?: true }>;
}

/**
 * `values`: the encoding's measures, each drawn simple metric's `column`/`aggregation` replaced by its metric's.
 * `filters`: the metric filters every measure shares, params bound. `plan`: only when the measures need separate questions.
 */
export type PlanResult = { ok: true; values: VizMeasure[]; filters: FilterStep[]; plan?: MeasurePlan } | { ok: false; error: string };

/** Whether a simple metric reads other rows than its column's plain total (step 07 adds a snapshot). */
export function needsMetricPlan(m: Metric): boolean {
  return m.filters.length > 0;
}

/** Thrown inside `build` for a measure no chart can draw; becomes `{ok:false, error}`. */
class PlanError extends Error {}

/** Cheap and synchronous: every chart without a metric measure stops here. */
export function hasMetricMeasure(encoding: VizEncoding | null | undefined): boolean {
  if (!encoding || encoding.pivot || encoding.cohort || encoding.eventFunnel || encoding.drivers) return false;
  return Array.isArray(encoding.values) && encoding.values.some((v) => v && typeof v.metricId === 'string');
}

/**
 * How a chart's metric measures are drawn, an error sentence, or null when
 * nothing differs from the measures as stored (the door then answers as it always did).
 */
export async function planMetricMeasures(
  projectId: string,
  datasetId: string,
  encoding: VizEncoding,
  params: ParamValues = new Map(),
): Promise<PlanResult | null> {
  if (!hasMetricMeasure(encoding)) return null;
  // With a split only the first measure is drawn (vizData.buildPivot).
  const considered = encoding.series ? encoding.values.slice(0, 1) : encoding.values;
  const plan: MeasurePlan = { leaves: [], formulas: new Map() };
  const leafAt = new Map<string, number>();
  let byName: Map<string, Metric> | null = null;
  let columns: string[] | null = null;

  const leafOf = (column: string, aggregation: MetricAggregation, own: FilterStep[], owner: string): Operand => {
    // ponytail: an LOD total is per ROW of the whole table, not per chart cell;
    // refused until the chart door can group one (analysis/lodQuery.ts).
    if (column[0] === '{') throw new PlanError(msg.measureNoLod(owner));
    const filters = resolveFilterParams(own, params).steps;
    const key = JSON.stringify([column, aggregation, filters]);
    let at = leafAt.get(key);
    if (at === undefined) {
      at = plan.leaves.length;
      plan.leaves.push({ column, aggregation, filters });
      leafAt.set(key, at);
    }
    return { leaf: at };
  };

  const build = async (m: Metric, stack: Set<string>, depth: number, top: boolean): Promise<Operand | null> => {
    if (m.datasetId !== datasetId) throw new PlanError(msg.otherDataset(m.name));
    if (!isFormulaDefinition(m.definition)) {
      if (m.definition.snapshot) throw new PlanError(msg.measureSnapshotPending(m.name)); // a sum over every date would be wrong; step 07 removes this
      return m.definition.column ? leafOf(m.definition.column, m.definition.aggregation, m.filters, m.name) : null;
    }
    if (depth > MAX_DEPTH) return null;
    if (!columns) columns = ((await datasets.getDatasetMeta(projectId, datasetId))?.columns ?? []).map((c) => c.name);
    const compiled = compileMetricFormula(bindFormulaText(m.definition.formula, params).text, columns);
    if (!compiled.ok) {
      // The chart's own measure says why; an operand degrades to null, as a KPI's does.
      if (top) throw new PlanError(msg.measureDoesNotCompile(m.name, compiled.error));
      return null;
    }
    const operands = new Map<string, Operand | null>();
    for (const agg of compiled.program.aggregates) operands.set(agg.ref, leafOf(agg.column, agg.aggregation, m.filters, m.name));
    for (const ref of compiled.program.metricRefs) {
      const key = ref.toLowerCase();
      if (!byName) byName = await metrics.metricsByName(projectId);
      const other = byName.get(key);
      // Unknown, or back round a loop: no value — never zero (ipc/metrics.resolveByName).
      if (!other || stack.has(key)) {
        operands.set(ref, null);
        continue;
      }
      stack.add(key);
      try {
        operands.set(ref, await build(other, stack, depth + 1, false));
      } finally {
        stack.delete(key);
      }
    }
    return { program: compiled.program, operands };
  };

  const values = encoding.values.slice();
  const own: FilterStep[][] = considered.map(() => []); // each drawn measure's own filters, params bound
  const filtered = new Map<number, Metric>();
  let formula = false;
  let changed = false;
  try {
    for (let i = 0; i < considered.length; i += 1) {
      const v = considered[i];
      const m = v?.metricId ? await metrics.getMetric(projectId, v.metricId) : null;
      if (!m) continue; // gone: the stored copy, as before
      const def = m.definition;
      if (isFormulaDefinition(def)) {
        formula = true;
        const root = await build(m, new Set([m.name.toLowerCase()]), 0, true);
        if (root) plan.formulas.set(i, { name: m.name, root });
        continue;
      }
      if (m.datasetId !== datasetId) continue; // another dataset's: the stored copy, as before
      if (def.snapshot) throw new PlanError(msg.measureSnapshotPending(m.name)); // a sum over every date would be wrong; step 07 removes this
      if (!def.column) continue; // no column of its own: nothing to follow
      if (def.column !== v.column || def.aggregation !== v.aggregation) {
        values[i] = { ...v, column: def.column, aggregation: def.aggregation };
        changed = true;
      }
      if (!needsMetricPlan(m)) continue;
      own[i] = resolveFilterParams(m.filters, params).steps;
      filtered.set(i, m);
    }
    const shared = own[0] ?? [];
    if (!formula && own.every((f) => JSON.stringify(f) === JSON.stringify(shared))) {
      return shared.length || changed ? { ok: true, values, filters: shared } : null;
    }
    // A filtered simple metric is one leaf under its own filters; values[i] holds its metric's column and aggregation.
    for (const [i, m] of filtered) {
      plan.formulas.set(i, { name: measureLabel(values[i]), root: leafOf(values[i].column, values[i].aggregation as MetricAggregation, m.filters, m.name), simple: true });
    }
  } catch (err) {
    if (err instanceof PlanError) return { ok: false, error: err.message };
    throw err;
  }
  return { ok: true, values, filters: [], plan };
}

/** The encoding as the chart door draws it: each simple metric measure as its metric defines it now. */
export async function followedEncoding(projectId: string, datasetId: string, encoding: VizEncoding, params?: ParamValues): Promise<VizEncoding> {
  const res = await planMetricMeasures(projectId, datasetId, encoding, params);
  return res && res.ok ? { ...encoding, values: res.values } : encoding;
}

/** One cell's value: the formula over that cell's leaf totals. A missing total is null, and so is the result. */
export function evaluateOperand(op: Operand | null, leafValue: (leaf: number) => number | null): number | null {
  if (!op) return null;
  if ('leaf' in op) return leafValue(op.leaf);
  const values = new Map<string, number | null>();
  for (const [ref, child] of op.operands) values.set(ref, evaluateOperand(child, leafValue));
  return evaluateMetricFormula(op.program, values);
}

/**
 * The encoding as the door draws it, each planned measure replaced by the COLUMNS
 * it totals — what a policy that decides by column must be shown (app/sharePolicy.ts):
 * a formula over a sensitive column, or a metric edited onto one, is a figure drawn from that column.
 */
export async function withLeafMeasures(projectId: string, datasetId: string, encoding: VizEncoding): Promise<VizEncoding> {
  const res = await planMetricMeasures(projectId, datasetId, encoding);
  if (!res || !res.ok) return encoding;
  const plan = res.plan;
  if (!plan) return { ...encoding, values: res.values };
  const plain = res.values.filter((_, i) => !plan.formulas.has(i));
  const leaves: VizMeasure[] = plan.leaves.map((l) => ({ column: l.column, aggregation: l.aggregation }));
  return { ...encoding, values: plain.concat(leaves) };
}
