// SCENARIOS — the resolver. MAIN PROCESS. Every figure a scenario shows.
//
// THE BASELINE IS resolveMetric's OWN FIGURE — called, not re-derived — so the
// baseline beside a scenario is the number a KPI card shows under the same
// scope, and nothing a scenario does can move it.
//
// THE SCENARIO mirrors src/ipc/metrics.ts resolveDefinition operand for
// operand, with two hooks:
//
//   an aggregate operand over a column a driver targets (`sum(revenue)`, or a
//   simple {column, aggregation} metric) is folded from that column's
//   per-partition pieces after the drivers move them (./scenarioModel). Every
//   other operand — and every `count` — is computeCardMetric's own answer,
//   exactly as in the baseline;
//
//   a metric a driver targets has its resolved value moved, and a formula that
//   names it (`[Profit] / [Revenue]`) reads the moved value, because metric
//   refs resolve through the same memoised lookup.
//
// A ratio therefore recomputes from moved operands under ONE scope: "margin
// with revenue in West −3%" is (profit) / (revenue with West's share moved).
//
// Pieces come from engine/scenarioResident (the Parquet file in place) and fall
// back to analysis/scenarioInputs (hydrated rows, the reference) on any null,
// recorded in engine/residentTrace under `scenario`. A column a driver cannot
// reach — not in the metric's dataset, or scoped through a related dataset's
// filter — is left at its baseline and said so in `notes`, never guessed.

import type { FilterStep } from '../data/transforms';
import * as datasets from '../data/datasets';
import * as metrics from './metrics';
import type { Metric, MetricDefinition, MetricFormat } from './metrics';
import { isFormulaDefinition } from './metrics';
import { compileMetricFormula, evaluateMetricFormula } from './metricFormula';
import { bindFormulaText, resolveFilterParams } from './params';
import type { ParamValues } from './params';
import { formatMetricValue } from './metricFormat';
import type { MetricAggregation } from './metricValue';
import { periodChange } from './scorecardModel';
import { computeCardMetric } from '../ipc/dashboards';
import { resolveMetric } from '../ipc/metrics';
import { relatedColumnNames } from '../ipc/relationships';
import { paramTable } from '../data/paramReplay';
import * as residentQuery from '../engine/residentQuery';
import * as trace from '../engine/residentTrace';
import { scenarioInputsResident } from '../engine/scenarioResident';
import { scenarioInputsJs } from './scenarioInputs';
import {
  TORNADO_STEP, applyColumnMoves, applyMetricMoves, columnMoves, driverLabel, effectiveDrivers, filterWords,
  foldPieces, isMetricTarget, metricMoves, tornadoBars,
} from './scenarioModel';
import type { Driver, DriverKind, DriverTarget, Nudge, Partition, Scenario, TornadoBar } from './scenarioModel';

const MAX_FORMULA_DEPTH = 10; // as src/ipc/metrics.ts

type Tone = 'good' | 'bad' | 'flat' | 'neutral';

export interface ScenarioFigure {
  metricId: string;
  name: string;
  missing?: boolean;
  baseline: number | null;
  baselineDisplay: string;
  value: number | null;
  display: string;
  delta: number | null;
  deltaDisplay: string;
  pct: number | null;
  tone: Tone;
  direction?: 'up_good' | 'down_good';
}

export interface ScenarioDriverInfo {
  index: number;
  label: string;
  kind: DriverKind;
  value: number;
  target: DriverTarget;
  targetText: string;
  param?: string;
  /** Reached at least one row or metric behind these figures. */
  applied: boolean;
}

export interface ScenarioTornado {
  metricId: string;
  name: string;
  value: number | null;
  display: string;
  step: number;
  bars: Array<TornadoBar & { lowDisplay: string; highDisplay: string }>;
}

export interface ScenarioResult {
  ok: true;
  id: string;
  name: string;
  metrics: ScenarioFigure[];
  drivers: ScenarioDriverInfo[];
  tornado: ScenarioTornado | null;
  notes: string[];
}

interface Ctx {
  projectId: string;
  scope: FilterStep[];
  params: ParamValues;
  drivers: Driver[];
  byName: Map<string, Metric> | null;
  byId: Map<string, Metric | null>;
  /** Pieces per (dataset, column, scope, driver filters): a nudge moves values, never rows, so every pass shares them. */
  inputs: Map<string, Promise<Partition[] | null>>;
  touched: Set<number>;
  notes: Set<string>;
}

/** One evaluation: the drivers as set, optionally one of them nudged. */
interface Pass {
  ctx: Ctx;
  nudge: Nudge | null;
  memo: Map<string, number | null>;
  stack: Set<string>;
}

function newCtx(projectId: string, scope: FilterStep[], params: ParamValues, drivers: Driver[]): Ctx {
  return {
    projectId, scope, params, drivers: effectiveDrivers(drivers, params),
    byName: null, byId: new Map(), inputs: new Map(), touched: new Set(), notes: new Set(),
  };
}

async function metricById(ctx: Ctx, id: string): Promise<Metric | null> {
  if (!ctx.byId.has(id)) ctx.byId.set(id, await metrics.getMetric(ctx.projectId, id));
  return ctx.byId.get(id) || null;
}

async function namesFor(ctx: Ctx): Promise<Map<string, Metric>> {
  if (!ctx.byName) ctx.byName = await metrics.metricsByName(ctx.projectId);
  return ctx.byName;
}

// ── pieces ───────────────────────────────────────────────────────────────────

async function loadInputs(ctx: Ctx, datasetId: string, column: string, all: FilterStep[], filters: Array<FilterStep | null>): Promise<Partition[] | null> {
  const meta = await datasets.getDatasetMeta(ctx.projectId, datasetId);
  if (!meta) return null;
  const own = new Set(meta.columns.map((c) => c.name));
  if (!own.has(column)) {
    ctx.notes.add(`"${column}" is not a column of ${meta.name}, so its drivers were not applied there.`);
    return null;
  }
  // A scope filter on a RELATED dataset's column is answered by a join
  // (computeCardMetric → joinedMetricFor); partitions over this table alone would
  // silently drop it, so the operand stays at its baseline instead.
  const related = all.some((f) => !own.has(f.column)) ? new Set(await relatedColumnNames(ctx.projectId, datasetId)) : null;
  if (related && all.some((f) => !own.has(f.column) && related.has(f.column))) {
    ctx.notes.add(`A filter on a related dataset is in scope, so drivers on "${column}" were not applied to ${meta.name}.`);
    return null;
  }
  // A pipeline bound to a dashboard parameter is replayed, as computeCardMetric replays it.
  const replay = await paramTable(ctx.projectId, datasetId, ctx.params);
  if (replay) return scenarioInputsJs(replay.columns, replay.rows, column, all, filters);
  const src = residentQuery.isResident() ? await datasets.residentSource(ctx.projectId, datasetId) : null;
  if (src) {
    const fast = await scenarioInputsResident(src, column, all, filters);
    if (fast) {
      trace.record('scenario', 'resident');
      return fast;
    }
    trace.record('scenario', 'failed', `filters=${all.length}, drivers=${filters.length}`);
  } else {
    trace.record('scenario', 'skipped');
  }
  const ds = await datasets.getDataset(ctx.projectId, datasetId);
  return ds ? scenarioInputsJs(ds.columns, ds.rows, column, all, filters) : null;
}

function inputsFor(ctx: Ctx, datasetId: string, column: string, all: FilterStep[], filters: Array<FilterStep | null>): Promise<Partition[] | null> {
  const key = JSON.stringify([datasetId, column, all, filters]);
  let hit = ctx.inputs.get(key);
  if (!hit) {
    hit = loadInputs(ctx, datasetId, column, all, filters);
    ctx.inputs.set(key, hit);
  }
  return hit;
}

// ── the mirror of metrics.ts resolveDefinition ───────────────────────────────

async function operand(pass: Pass, datasetId: string, spec: { column: string; aggregation: MetricAggregation }, all: FilterStep[]): Promise<number | null> {
  const moves = spec.aggregation === 'count' ? [] : columnMoves(pass.ctx.drivers, spec.column);
  if (moves.length) {
    const parts = await inputsFor(pass.ctx, datasetId, spec.column, all, moves.map((m) => m.filter));
    if (parts) {
      if (!pass.nudge) moves.forEach((m, j) => { if (parts.some((p) => p.key[j] && p.pieces.n > 0)) pass.ctx.touched.add(m.index); });
      return foldPieces(applyColumnMoves(parts, moves, pass.nudge), spec.aggregation);
    }
  }
  const res = await computeCardMetric(pass.ctx.projectId, datasetId, spec, all, pass.ctx.params);
  return res.ok ? res.value : null;
}

async function resolveDefinition(pass: Pass, datasetId: string, definition: MetricDefinition, filters: FilterStep[], depth: number): Promise<number | null> {
  const ctx = pass.ctx;
  const all = resolveFilterParams(filters, ctx.params).steps.concat(ctx.scope);
  if (!isFormulaDefinition(definition)) {
    if (!definition.column) return null;
    return operand(pass, datasetId, definition, all);
  }
  if (depth > MAX_FORMULA_DEPTH) return null;
  const meta = await datasets.getDatasetMeta(ctx.projectId, datasetId);
  const columns = (meta ? meta.columns.map((c) => c.name) : []).concat(await relatedColumnNames(ctx.projectId, datasetId));
  const compiled = compileMetricFormula(bindFormulaText(definition.formula, ctx.params).text, columns);
  if (!compiled.ok) return null;
  const values = new Map<string, number | null>();
  for (const agg of compiled.program.aggregates) {
    values.set(agg.ref, await operand(pass, datasetId, { column: agg.column, aggregation: agg.aggregation }, all));
  }
  for (const ref of compiled.program.metricRefs) {
    const m = (await namesFor(ctx)).get(String(ref).toLowerCase());
    values.set(ref, m ? await metricValue(pass, m, depth + 1) : null);
  }
  return evaluateMetricFormula(compiled.program, values);
}

/** One metric's scenario value: its definition under the drivers, then any driver aimed at it. Memoised, cycle-guarded. */
async function metricValue(pass: Pass, metric: Metric, depth: number): Promise<number | null> {
  const key = metric.name.toLowerCase();
  if (pass.memo.has(key)) return pass.memo.get(key) ?? null;
  if (pass.stack.has(key)) return null;
  pass.stack.add(key);
  let raw: number | null;
  try {
    raw = await resolveDefinition(pass, metric.datasetId, metric.definition, metric.filters, depth);
  } finally {
    pass.stack.delete(key);
  }
  const moves = metricMoves(pass.ctx.drivers, metric.id);
  if (!pass.nudge) moves.forEach((m) => pass.ctx.touched.add(m.index));
  const v = applyMetricMoves(raw, moves, pass.nudge);
  pass.memo.set(key, v);
  return v;
}

async function evaluate(ctx: Ctx, metric: Metric, nudge: Nudge | null, memo?: Map<string, number | null>): Promise<number | null> {
  return metricValue({ ctx, nudge, memo: memo || new Map(), stack: new Set() }, metric, 0);
}

// ── figures, tornado, compare, card ──────────────────────────────────────────

function signed(delta: number | null, format: MetricFormat): string {
  if (delta === null) return '';
  const body = formatMetricValue(Math.abs(delta), format);
  const shown = format.kind === 'percent' ? body.replace(/%$/, ' pts') : body;
  return (delta > 0 ? '+' : delta < 0 ? '−' : '') + shown;
}

async function figures(ctx: Ctx, ids: string[]): Promise<Array<{ fig: ScenarioFigure; metric: Metric | null }>> {
  const memo = new Map<string, number | null>(); // one plain pass across every metric
  const out: Array<{ fig: ScenarioFigure; metric: Metric | null }> = [];
  for (const id of ids) {
    const m = await metricById(ctx, id);
    const base = m ? await resolveMetric(ctx.projectId, id, { filters: ctx.scope, params: ctx.params }) : null;
    if (!m || !base) {
      out.push({ metric: null, fig: {
        metricId: id, name: 'Missing metric', missing: true, baseline: null, baselineDisplay: '—', value: null, display: '—',
        delta: null, deltaDisplay: '', pct: null, tone: 'flat',
      } });
      continue;
    }
    const value = await evaluate(ctx, m, null, memo);
    const change = periodChange(value, base.value, m.direction);
    const fig: ScenarioFigure = {
      metricId: id, name: m.name, baseline: base.value, baselineDisplay: base.display, value,
      display: formatMetricValue(value, m.format), delta: change.delta, deltaDisplay: signed(change.delta, m.format),
      pct: m.format.kind === 'percent' ? null : change.pct, tone: change.tone,
    };
    if (m.direction) fig.direction = m.direction;
    out.push({ fig, metric: m });
  }
  return out;
}

async function driverInfo(ctx: Ctx): Promise<ScenarioDriverInfo[]> {
  const out: ScenarioDriverInfo[] = [];
  for (let i = 0; i < ctx.drivers.length; i++) {
    const d = ctx.drivers[i];
    let targetText: string;
    let label: string;
    if (isMetricTarget(d.target)) {
      const m = await metricById(ctx, d.target.metricId);
      label = driverLabel(d, m ? m.name : 'Missing metric');
      targetText = `The ${m ? m.name : 'missing'} metric`;
    } else {
      label = driverLabel(d);
      targetText = `Column ${d.target.column}, ` + (d.target.filter ? `rows ${filterWords(d.target.filter)}` : 'every row');
    }
    const info: ScenarioDriverInfo = { index: i, label, kind: d.kind, value: d.value, target: d.target, targetText, applied: ctx.touched.has(i) };
    if (d.param) info.param = d.param;
    out.push(info);
  }
  return out;
}

async function tornadoFor(ctx: Ctx, metric: Metric, value: number | null): Promise<ScenarioTornado> {
  const rows: Array<{ index: number; label: string; low: number | null; high: number | null }> = [];
  for (let i = 0; i < ctx.drivers.length; i++) {
    const d = ctx.drivers[i];
    const tm = isMetricTarget(d.target) ? await metricById(ctx, d.target.metricId) : null;
    rows.push({
      index: i,
      label: driverLabel(d, tm ? tm.name : 'Missing metric'),
      low: await evaluate(ctx, metric, { index: i, factor: 1 - TORNADO_STEP }),
      high: await evaluate(ctx, metric, { index: i, factor: 1 + TORNADO_STEP }),
    });
  }
  return {
    metricId: metric.id, name: metric.name, value, display: formatMetricValue(value, metric.format), step: TORNADO_STEP,
    bars: tornadoBars(rows).map((b) => ({ ...b, lowDisplay: formatMetricValue(b.low, metric.format), highDisplay: formatMetricValue(b.high, metric.format) })),
  };
}

/**
 * Every figure a scenario page shows: each base metric's baseline and scenario
 * value with the change, each driver in words, and the tornado for one metric.
 * `filters` must ALREADY be sanitized and parameter-bound (resolveMetric's contract).
 */
export async function computeScenario(
  projectId: string,
  sc: Pick<Scenario, 'id' | 'name' | 'baseMetricIds' | 'drivers'>,
  opts: { filters?: FilterStep[]; params?: ParamValues; focusMetricId?: string } = {},
): Promise<ScenarioResult> {
  const ctx = newCtx(projectId, opts.filters || [], opts.params || new Map(), sc.drivers);
  const rows = await figures(ctx, sc.baseMetricIds);
  // The asked-for metric; else the first the drivers actually move; else the first with a figure.
  const focus = rows.find((r) => r.metric && r.metric.id === opts.focusMetricId && r.fig.value !== null)
    || rows.find((r) => r.metric && r.fig.value !== null && r.fig.delta !== 0)
    || rows.find((r) => r.metric && r.fig.value !== null);
  const tornado = focus && focus.metric ? await tornadoFor(ctx, focus.metric, focus.fig.value) : null;
  return {
    ok: true, id: sc.id, name: sc.name, metrics: rows.map((r) => r.fig),
    drivers: await driverInfo(ctx), tornado, notes: [...ctx.notes],
  };
}

/** Baseline + up to four scenarios, side by side, over the union of their base metrics. */
// ponytail: `any` — a JSON envelope for the renderer, shaped below.
export async function compareScenarios(projectId: string, list: Scenario[]): Promise<any> {
  const ids: string[] = [];
  for (const s of list) for (const id of s.baseMetricIds) if (ids.indexOf(id) < 0) ids.push(id);
  const columns: Array<{ id: string; name: string; drivers: string[]; figs: ScenarioFigure[] }> = [];
  for (const s of list) {
    const ctx = newCtx(projectId, [], new Map(), s.drivers);
    columns.push({ id: s.id, name: s.name, drivers: (await driverInfo(ctx)).map((d) => d.label), figs: (await figures(ctx, ids)).map((r) => r.fig) });
  }
  const baseline = columns.length ? columns[0].figs : [];
  const cellsOf = (i: number) => columns.map((c) => {
    const f = c.figs[i];
    return { value: f.value, display: f.display, delta: f.delta, deltaDisplay: f.deltaDisplay, pct: f.pct, tone: f.tone };
  });
  return {
    ok: true,
    scenarios: columns.map((c) => ({ id: c.id, name: c.name, drivers: c.drivers })),
    rows: ids.map((id, i) => ({
      metricId: id, name: baseline[i] ? baseline[i].name : '', missing: baseline[i] ? !!baseline[i].missing : true,
      baseline: baseline[i] ? baseline[i].baseline : null, baselineDisplay: baseline[i] ? baseline[i].baselineDisplay : '—',
      direction: baseline[i] ? baseline[i].direction : undefined,
      cells: cellsOf(i),
      best: bestCell(cellsOf(i), baseline[i] ? baseline[i].direction : undefined),
    })),
  };
}

/**
 * The best column of a compare row (scenarioCompare.ts's rule, moved here so a
 * browser never ranks figures): only when the metric says which way is good,
 * among ≥ 2 scenarios, and only an outright winner — a tie is nobody's best.
 * −1 = none.
 */
export function bestCell(cells: Array<{ value: number | null }>, direction: 'up_good' | 'down_good' | undefined): number {
  if (!direction || cells.length < 2) return -1;
  let best = -1;
  cells.forEach((c, i) => {
    if (typeof c.value !== 'number') return;
    const b = best >= 0 ? cells[best].value : null;
    if (b === null || (direction === 'down_good' ? c.value < (b as number) : c.value > (b as number))) best = i;
  });
  if (best >= 0 && cells.some((c, i) => i !== best && c.value === cells[best].value)) return -1;
  return best;
}

/** One metric under a scenario, for a dashboard KPI card — its filters and parameters apply to both sides. */
export async function scenarioCardValue(projectId: string, sc: Scenario, metricId: string, filters: FilterStep[], params: ParamValues): Promise<ScenarioFigure | null> {
  const ctx = newCtx(projectId, filters, params, sc.drivers);
  const [row] = await figures(ctx, [metricId]);
  return row && row.metric ? row.fig : null;
}

/**
 * What a driver can aim at, for the editor: every column an aggregate of the
 * base metrics reads (through formulas and metric refs), the metrics involved,
 * and the datasets whose columns a driver's filter can use.
 */
// ponytail: `any` — a JSON envelope for the renderer, shaped below.
export async function scenarioTargets(projectId: string, baseMetricIds: string[]): Promise<any> {
  const ctx = newCtx(projectId, [], new Map(), []);
  const columns = new Map<string, { column: string; datasetId: string; metrics: string[] }>();
  const involved = new Map<string, Metric>();
  const visit = async (m: Metric, via: string, depth: number): Promise<void> => {
    if (involved.has(m.id) || depth > MAX_FORMULA_DEPTH) return;
    involved.set(m.id, m);
    const add = (column: string): void => {
      const key = m.datasetId + '|' + column;
      const hit = columns.get(key) || { column, datasetId: m.datasetId, metrics: [] };
      if (hit.metrics.indexOf(via) < 0) hit.metrics.push(via);
      columns.set(key, hit);
    };
    // `count` counts non-empty cells: no value driver moves it, so it offers no target.
    if (!isFormulaDefinition(m.definition)) { if (m.definition.column && m.definition.aggregation !== 'count') add(m.definition.column); return; }
    const meta = await datasets.getDatasetMeta(projectId, m.datasetId);
    const compiled = compileMetricFormula(m.definition.formula, meta ? meta.columns.map((c) => c.name) : []);
    if (!compiled.ok) return;
    for (const a of compiled.program.aggregates) if (a.aggregation !== 'count') add(a.column);
    for (const ref of compiled.program.metricRefs) {
      const r = (await namesFor(ctx)).get(String(ref).toLowerCase());
      if (r) await visit(r, via, depth + 1);
    }
  };
  for (const id of baseMetricIds) {
    const m = await metricById(ctx, id);
    if (m) await visit(m, m.name, 0);
  }
  const dsIds = new Set([...involved.values()].map((m) => m.datasetId));
  const dsList: Array<{ id: string; name: string; columns: Array<{ name: string; type: string }> }> = [];
  for (const id of dsIds) {
    const meta = await datasets.getDatasetMeta(projectId, id);
    if (meta) dsList.push({ id, name: meta.name, columns: meta.columns.map((c) => ({ name: c.name, type: c.type })) });
  }
  return {
    ok: true,
    columns: [...columns.values()],
    metrics: [...involved.values()].map((m) => ({ id: m.id, name: m.name })),
    datasets: dsList,
  };
}
