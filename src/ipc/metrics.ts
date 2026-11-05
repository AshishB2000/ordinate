// Metrics IPC — list/get/save/update/duplicate/delete a Metric, plus the three
// reads that make a metric worth having: `metric:value` (the ONE app-computed
// figure under a scope), `metric:series` (that figure broken out by a column)
// and `metric:usage` (everything that points at it).
//
// THE NUMBER IS NEVER COMPUTED HERE FROM SCRATCH. Every figure bottoms out in
// `computeCardMetric` (src/ipc/dashboards.ts) — the same call a KPI card and an
// alert already make, resident fast path then JS fallback, already differential-
// tested against `metricValue.computeMetric`. A second resolver would be a
// second answer to "what is Revenue", which is the exact problem this layer
// exists to remove.
//
// ── Scope is FILTERS ─────────────────────────────────────────────────────────
// A dashboard's controls and a chart's click-selection are already compiled to
// `FilterStep[]` before they leave the renderer (dashboardFilters.controlSteps),
// so a scope with separate `controls`/`selection` fields would be three names
// for one thing and three places to sanitize. Scope is filters, and they are
// sanitized by `sanitizeDashboardFilters` — a security control, not a formatter —
// exactly as the metric-card handler does.
//
// ── Why a formula resolves its operands, not its ratios ─────────────────────
// `[Margin %]` under a West filter must be West's profit over West's revenue.
// So each operand is resolved UNDER THE SAME SCOPE and the expression runs on
// the results. Folding a stored ratio, or averaging per-row ratios, gives a
// number that is wrong in a way no one can see.

import { metricHidden } from '../analysis/columnHidden';
import { ipcMain } from './bus';
import { distinctFor } from './distinctFor';
import { isRowPolicyError } from '../data/rowAccess';
import { rowPolicyRefusal } from '../data/rowPolicyError';

import * as metrics from '../analysis/metrics';
import { withStatus } from '../analysis/statusStore';
import type { Metric, MetricDefinition } from '../analysis/metrics';
import { isFormulaDefinition } from '../analysis/metrics';
import { isNewerKind } from '../analysis/pendingKinds';
import { checkTarget, targetField } from './targetResolve';
import { formatMetricValue, describeDefinition } from '../analysis/metricFormat';
import { compileMetricFormula, evaluateMetricFormula } from '../analysis/metricFormula';
import { proposeMetrics } from '../analysis/metricAuto';
import { metricUsage } from '../analysis/metricUsage';
import { computeCardMetric } from './dashboards';
import { bindFormulaText, paramValues, resolveFilterParams } from '../analysis/params';
import type { ParamValues } from '../analysis/params';
import type { MetricAggregation } from '../analysis/metricValue';
import { sanitizeDashboardFilters } from '../analysis/dashboards';
import * as datasets from '../data/datasets';
import { periodPlan } from '../analysis/insightsAgg';
import type { FilterStep } from '../data/transforms';
import { manySideColumnNames, relatedColumnNames } from './relationships';
import * as versions from '../app/versions';
import * as trash from '../app/trash';
import { withAsOf } from '../data/asOf';
import { stampAsOf } from '../data/figureAsOf';
import { fxScope } from './fxQuery';
import { mergeFx } from '../analysis/fx';
import type { FxInfo } from '../analysis/fx';
import { formatMetric } from '../app/format';
import type { AsOf } from '../api/asOf';
import { liveCodeOf } from './liveRoute';
import { isLiveDatasetError, requireExtract } from '../data/liveDataset';
import { vizDataFor } from './visuals';
import { metricDate, metricScope, settleOnSave, settleOnUpdate } from '../analysis/metricTimeScope';
import { snapshotProblem } from '../analysis/snapshotGuards';
import { contentTag, isRecordChanged } from '../app/editConflict';
import { termHolding } from '../analysis/termNames';
import { termNameTaken } from '../data/termMessages';
import { ExternalMetricError } from '../analysis/externalMetric';
import { externalNoDuplicate } from '../analysis/externalMetricMessages';
import { isSharePath } from '../app/privacyStore';
import { kpiHidden } from '../publish/kpiPolicy';
import { baseName, checkPeriodDefinition, periodMetricValue } from './periodMetric';
import { periodSeries } from './periodChart';
import { checkFunnelDefinition, funnelMetricValue } from './funnelMetric';

/** How many distinct values of a breakout column are read before rolling up. */
const SERIES_SCAN = 2000;
/** A sparkline is a sparkline. Past this it is a chart, and the page has one. */
const SERIES_MAX_POINTS = 24;
/**
 * How deep `[A]` → `[B]` → `[C]` may go before a formula is assumed circular.
 *
 * The stack below already refuses a metric that references ITSELF, directly or
 * around a loop; this is the belt to that's braces — a legitimate chain of
 * derived metrics is two or three deep, and anything past ten is a mistake
 * nobody is going to debug from a "—".
 */
const MAX_FORMULA_DEPTH = 10;

/** One resolution's working state: a per-call memo so `[Profit] / [Revenue]`
 *  and a sibling metric that also uses Revenue cost one query, not two. */
export interface ResolveCtx {
  projectId: string;
  scope: FilterStep[];
  byName: Map<string, Metric> | null;
  memo: Map<string, number | null>;
  /** Lowercased names currently being resolved — the cycle guard. */
  stack: Set<string>;
  /** The dashboard's parameters at their current values — see analysis/params. */
  params: ParamValues;
  /** Set when any operand was money converted to the target currency (./fxQuery). */
  fx?: FxInfo;
  /** The oldest warehouse time of any LIVE operand (L2.4) — the figure's `asOf`. */
  asOf?: AsOf;
  /** When the caller asks: every column a figure was totalled from — what a Share policy judges (publish/kpiPolicy). */
  reads?: MetricRead[];
  /** D9: the scope as it came (a date control's period still marked) and the dataset `scope` was settled for, so a part on another dataset counts by its own date; unset when nothing was marked. */
  marked?: { filters: FilterStep[]; on: string };
  refused?: string; // why there is no figure: a part's dates disagree under a date control
  notes?: string[]; // the dashboard's glossary terms an operand left out (analysis/termExpand), once each; a period metric's why (./periodMetric)
  periodRange?: ResolvedMetric['periodRange']; // the days a period metric's window covered (./periodMetric), at the top only
}

/** A figure's notes: each operand's, once. */
function noteOf(ctx: ResolveCtx, notes: string[] | undefined): void {
  for (const n of notes ?? []) if (!(ctx.notes ??= []).includes(n)) ctx.notes.push(n);
}

/** One total a metric's figure was drawn from: a column (its own dataset's or a related one's) and its aggregation. */
export interface MetricRead { datasetId: string; column: string; aggregation: MetricAggregation }

/** The older of two live times: a figure is as old as its oldest operand. */
export function olderAsOf(a: AsOf | undefined, b: AsOf | undefined): AsOf | undefined {
  return !a ? b : !b ? a : b.at < a.at ? b : a;
}

/**
 * A figure as text, in the target currency when it was converted: a column
 * rollup becomes money; a formula keeps its own kind (a ratio of two converted
 * sums is still a ratio), and a currency-kind one takes the target's symbol.
 */
export function displayOf(value: number | null, format: metrics.MetricFormat, fx: FxInfo | undefined, simple: boolean): string {
  if (!fx || (!simple && format.kind !== 'currency')) return formatMetricValue(value, format);
  return formatMetric(value, { ...format, kind: 'currency', prefix: undefined }, fx.target);
}

async function namesFor(ctx: ResolveCtx): Promise<Map<string, Metric>> {
  if (!ctx.byName) ctx.byName = await metrics.metricsByName(ctx.projectId);
  return ctx.byName;
}

/**
 * The value of one DEFINITION — the shared core of `metric:value` and the
 * editor's live preview, which is why it takes a definition rather than a
 * record: the preview shows a figure for something not yet saved, and a second
 * code path for it would be a preview that can disagree with what gets saved.
 *
 * `filters` are the metric's OWN filters; `ctx.scope` is the dashboard's. Both
 * apply, metric-first, because "revenue excluding refunds, in the West" is one
 * filtered question and the order does not change the answer.
 */
export async function resolveDefinition(
  ctx: ResolveCtx,
  datasetId: string,
  definition: MetricDefinition,
  filters: FilterStep[],
  depth: number,
  name?: string, // the metric's, for the sentence refusing a layer's metric
): Promise<number | null> {
  // The metric's OWN filters may reference a dashboard parameter too; the
  // scope arrived already resolved by the handler.
  const all = resolveFilterParams(filters, ctx.params).steps.concat(ctx.scope);
  if (metrics.isExternalDefinition(definition)) throw new ExternalMetricError('pending', name ?? definition.external); // only its layer can answer it (part 7 b0)

  if (metrics.isPeriodDefinition(definition)) return periodMetricValue(ctx, datasetId, definition, all, depth); // its base under a rewritten scope
  if (metrics.isFunnelDefinition(definition)) return funnelMetricValue(ctx, datasetId, definition, filters, depth); // the grid's matching, the scope picking who enters (./funnelMetric)
  if (!isFormulaDefinition(definition)) {
    if (!definition.column) return null;
    ctx.reads?.push({ datasetId, column: definition.column, aggregation: definition.aggregation });
    const res = await computeCardMetric(ctx.projectId, datasetId, definition, all, ctx.params);
    ctx.fx = mergeFx(ctx.fx, res.fx);
    ctx.asOf = olderAsOf(ctx.asOf, res.asOf);
    noteOf(ctx, res.notes);
    return res.ok ? res.value : null;
  }

  if (depth > MAX_FORMULA_DEPTH) return null;

  const meta = await datasets.getDatasetMeta(ctx.projectId, datasetId);
  // A related dataset's columns too: `sum(revenue) / sum(target)` reaches Targets
  // through the project's relationships (computeCardMetric's join hook, or a many side's own KPI).
  const columns = (meta ? meta.columns.map((c) => c.name) : []).concat(await relatedColumnNames(ctx.projectId, datasetId), await manySideColumnNames(ctx.projectId, datasetId));
  // `[Revenue] * [[growth]]` — the parameter becomes a literal before parsing.
  const compiled = compileMetricFormula(bindFormulaText(definition.formula, ctx.params).text, columns);
  if (!compiled.ok) return null;

  const values = new Map<string, number | null>();

  // Aggregations over this metric's own dataset — `sum(revenue)`.
  for (const agg of compiled.program.aggregates) {
    ctx.reads?.push({ datasetId, column: agg.column, aggregation: agg.aggregation });
    const res = await computeCardMetric(
      ctx.projectId,
      datasetId,
      { column: agg.column, aggregation: agg.aggregation },
      all,
      ctx.params,
    );
    ctx.fx = mergeFx(ctx.fx, res.fx);
    ctx.asOf = olderAsOf(ctx.asOf, res.asOf);
    noteOf(ctx, res.notes);
    values.set(agg.ref, res.ok ? res.value : null);
  }

  // References to other metrics — `[Revenue]`. Each resolved under the SAME
  // scope, which is what makes a ratio of two metrics a ratio of two scoped
  // figures rather than a scoped ratio of two unscoped ones.
  for (const ref of compiled.program.metricRefs) {
    values.set(ref, await resolveByName(ctx, ref, depth + 1));
  }

  return evaluateMetricFormula(compiled.program, values);
}

/** One metric by NAME, memoized, cycle-guarded. An unknown name resolves to
 *  null — the formula then degrades to null too, rather than treating a typo as
 *  zero. */
async function resolveByName(ctx: ResolveCtx, name: string, depth: number): Promise<number | null> {
  const key = String(name).toLowerCase();
  if (ctx.memo.has(key)) return ctx.memo.get(key) ?? null;
  // A metric that references itself, directly or around a loop, has no value.
  // Without this the recursion below would not terminate.
  if (ctx.stack.has(key)) return null;

  const byName = await namesFor(ctx);
  const metric = byName.get(key);
  if (!metric) return null;

  ctx.stack.add(key);
  const outer = { scope: ctx.scope, marked: ctx.marked };
  let value: number | null = null;
  try {
    const m = outer.marked;
    const away = m && metric.datasetId !== m.on ? await metricScope(ctx.projectId, metric, m.filters) : null;
    if (away && !away.ok) ctx.refused ??= away.error;
    else {
      if (away && m) Object.assign(ctx, { scope: away.filters, marked: { filters: m.filters, on: metric.datasetId } });
      value = await resolveDefinition(ctx, metric.datasetId, metric.definition, metric.filters, depth, metric.name);
    }
  } finally {
    ctx.stack.delete(key);
    Object.assign(ctx, outer);
  }
  ctx.memo.set(key, value);
  return value;
}

export function newCtx(projectId: string, scope: FilterStep[], params: ParamValues = new Map()): ResolveCtx {
  return { projectId, scope, byName: null, memo: new Map(), stack: new Set(), params };
}

export interface ResolvedMetric {
  ok: boolean;
  id: string;
  name: string;
  value: number | null;
  /** The figure AS TEXT, formatted by the metric's own format. The renderer
   *  prints this rather than re-formatting — see metricFormat.ts's header. */
  display: string;
  format: metrics.MetricFormat;
  definitionText: string;
  direction?: 'up_good' | 'down_good';
  fx?: FxInfo;
  /** Set when an operand is LIVE: the warehouse's time (L2.4), kept by stampAsOf. */
  asOf?: AsOf;
  /** D9: the date a dashboard date control's period was moved onto (the tile's caption); why there is no figure when dates disagree under one. */
  periodOn?: string;
  refused?: string;
  notes?: string[]; // the dashboard's glossary terms the figure left out; why a period metric has none
  periodRange?: { from?: string; to?: string }; // a period metric's window: the days its figure covers
}

/**
 * The ONE app-computed figure for a saved metric, under a scope.
 *
 * EXPORTED for scripts/test-metrics.ts and for any main-process caller that
 * needs the same number a card shows (the same reason `computeCardMetric` and
 * `buildFacts` are exported). `filters` must ALREADY be sanitized.
 */
export async function resolveMetric(
  projectId: string,
  metricId: string,
  scope: { filters?: FilterStep[]; params?: ParamValues; reads?: MetricRead[] } = {},
): Promise<ResolvedMetric | null> {
  const metric = await metrics.getMetric(projectId, metricId);
  if (!metric) return null;
  const filters = Array.isArray(scope.filters) ? scope.filters : [];
  // D9: a date control's period on the date the metric counts by (no mark: the same filters, no read).
  const s = await metricScope(projectId, metric, filters);
  const ctx = newCtx(projectId, s.ok ? s.filters : [], scope.params);
  ctx.reads = scope.reads;
  if (s.ok && s.filters !== filters) ctx.marked = { filters, on: metric.datasetId };
  // Seeded so a self-reference inside this metric's own formula is caught by the
  // same guard that catches a loop between two of them.
  ctx.stack.add(metric.name.toLowerCase());
  const value = s.ok ? await resolveDefinition(ctx, metric.datasetId, metric.definition, metric.filters, 0, metric.name) : null;
  ctx.stack.delete(metric.name.toLowerCase());
  const out: ResolvedMetric = {
    ok: true,
    id: metric.id,
    name: metric.name,
    value,
    display: displayOf(value, metric.format, ctx.fx, metrics.isSimpleDefinition(metric.definition)),
    format: metric.format,
    definitionText: describeDefinition(metric, undefined, await baseName(projectId, metric.definition)),
  };
  if (metric.direction) out.direction = metric.direction;
  if (ctx.fx) out.fx = ctx.fx;
  if (ctx.asOf) out.asOf = ctx.asOf;
  if (s.ok && s.periodOn) out.periodOn = s.periodOn;
  if (ctx.notes) out.notes = ctx.notes;
  if (ctx.periodRange) out.periodRange = ctx.periodRange;
  const refused = s.ok ? ctx.refused : s.error;
  if (refused) out.refused = refused;
  return out;
}

/**
 * The figure for a definition that is NOT saved — `metric:preview`, and the
 * measure editor's check (./metricCheck.ts). The same resolver and formatter the
 * saved record will use. `self` is the name it will be saved under, so a formula
 * naming itself previews as it will resolve: no value. Throws `LiveFigureError`.
 */
export async function previewDefinition(projectId: string, datasetId: string, definition: unknown, filters: unknown, format: unknown, self?: string) {
  const def = metrics.sanitizeDefinition(definition);
  const own = sanitizeDashboardFilters(filters);
  const ctx = newCtx(projectId, []);
  if (self) ctx.stack.add(self.trim().toLowerCase());
  const value = await resolveDefinition(ctx, datasetId, def, own, 0);
  return {
    ok: true as const,
    value,
    display: displayOf(value, metrics.sanitizeFormat(format), ctx.fx, metrics.isSimpleDefinition(def)),
    ...(ctx.fx ? { fx: ctx.fx } : {}), ...(ctx.periodRange ? { periodRange: ctx.periodRange } : {}), ...(ctx.notes && isNewerKind(def) ? { notes: ctx.notes } : {}),
    ...(ctx.asOf ? { asOf: ctx.asOf } : {}),
    definitionText: describeDefinition({ definition: def, filters: own }, undefined, await baseName(projectId, def)),
  };
}

/** The sentence a duplicate name is refused with — said by save, update and the editor's check alike. */
export function nameTakenMessage(name: unknown): string {
  return `A metric called "${String(name).trim()}" already exists.`;
}

/** Distinct values of a column, resident-first. Mirrors alertStore's own
 *  `distinctValues` — same two calls, same "null means we could not read it". */
async function distinctValues(projectId: string, datasetId: string, column: string): Promise<string[] | null> {
  try {
    // Under the caller's row access lock (./distinctFor): the periods their rows hold.
    const r = await distinctFor(projectId, datasetId, column, { limit: SERIES_SCAN, search: '' });
    return r ? r.values : null;
  } catch (err) {
    // D6: "no series" would be a silent blank for a Live dataset — its sparkline
    // is not routed (one statement per point; L2.4 log), so it refuses, typed. So does a row access refusal.
    if (isLiveDatasetError(err) || isRowPolicyError(err)) throw err;
    return null;
  }
}

/**
 * Every day a DATE column of bare ISO dates holds, from the chart door at day
 * grain. Not `distinctValues` alone: that reads the first 200 values seen
 * (datasetPage.MAX_DISTINCT), so two years of daily rows ended the sparkline in
 * their seventh month. A Live dataset still refuses, typed (as above).
 */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

async function dayLabels(projectId: string, datasetId: string, column: string): Promise<string[] | null> {
  requireExtract(await datasets.getDatasetMeta(projectId, datasetId));
  const r = await vizDataFor(projectId, datasetId, { category: column, grain: 'day', values: [{ column, aggregation: 'count' }] }, []);
  return r.ok ? r.data.labels.map(String) : null;
}

export interface MetricSeries {
  labels: string[];
  values: (number | null)[];
  display: string[];
}

/**
 * The metric, broken out by one column — the Metrics table's sparkline, and the
 * shape a chart consumes.
 *
 * Each point is a FULL resolution under that point's filter, not a group-by.
 * That costs one query per point where a simple metric could have had one
 * query total — and it is the only way a FORMULA metric is right per point,
 * because `[Profit] / [Revenue]` per month is each month's ratio, never the
 * year's. The point count is capped at SERIES_MAX_POINTS, so the ceiling is
 * bounded and small.
 *
 * ponytail: N+1 queries by design, capped at 24. If a metric page ever shows
 * hundreds of series at once, give the SIMPLE definition a single grouped query
 * (residentQuery.aggregateResident) and keep this path for formulas.
 *
 * Periods come from `insightsAgg.periodPlan`, so "by month" means exactly what
 * the Insights cards and the alert evaluator already mean by it — a third
 * definition of a period is two too many. That includes ending at the latest
 * CLOSED month: a half-finished one would plot as a collapse. A non-date column rolls up to itself,
 * which makes this "by region" without a second code path.
 */
export async function resolveMetricSeries(
  projectId: string,
  metricId: string,
  byColumn: string,
  scope: { filters?: FilterStep[]; /** Fewer than SERIES_MAX_POINTS (the metric tree's 12 months). */ points?: number } = {},
): Promise<MetricSeries | null> {
  const metric = await metrics.getMetric(projectId, metricId);
  if (!metric || !byColumn) return null;
  if (metrics.isPeriodDefinition(metric.definition)) return periodSeries(metric, byColumn, Array.isArray(scope.filters) ? scope.filters : [], scope.points); // a resolution per month (./periodChart)
  const meta = await datasets.getDatasetMeta(projectId, metric.datasetId);
  const isDate = !!meta && meta.columns.some((c) => c.name === byColumn && c.type === 'date');
  const raw = await distinctValues(projectId, metric.datasetId, byColumn);
  // The door's day labels are ISO, and a point filters the RAW cell by text (`=` / `contains`): they are
  // only the cells' own words when every cell is a bare ISO date. `1/5/2024` or a timestamp keeps the raw read.
  const labels = isDate && raw && raw.length && raw.every((v) => ISO_DAY.test(v)) ? await dayLabels(projectId, metric.datasetId, byColumn) : raw;
  if (!labels || !labels.length) return null;

  const plan = periodPlan(labels);
  const keys = plan.periods.slice(-Math.min(SERIES_MAX_POINTS, scope.points ?? SERIES_MAX_POINTS));
  if (!keys.length) return null;

  const base = Array.isArray(scope.filters) ? scope.filters : [];
  const out: MetricSeries = { labels: keys, values: [], display: [] };
  for (const key of keys) {
    const ctx = newCtx(projectId, base.concat([
      { type: 'filter', column: byColumn, op: plan.op, value: key } as FilterStep,
    ]));
    ctx.stack.add(metric.name.toLowerCase());
    const v = await resolveDefinition(ctx, metric.datasetId, metric.definition, metric.filters, 0, metric.name);
    out.values.push(v);
    out.display.push(displayOf(v, metric.format, ctx.fx, metrics.isSimpleDefinition(metric.definition)));
  }
  return out;
}

/**
 * The date column a sparkline runs along, or null: the date the metric counts by (D9), else the first declared
 * date column — a dataset with two of them (ordered/shipped) and a metric that names neither has no app-knowable
 * "the" date, and the first one is at least the same choice every time rather than a different one per machine.
 */
async function sparkColumn(projectId: string, m: Metric): Promise<string | null> {
  const own = await metricDate(projectId, m);
  if (own) return own;
  const meta = await datasets.getDatasetMeta(projectId, m.datasetId);
  if (!meta) return null;
  const date = meta.columns.find((c) => c.type === 'date');
  return date ? date.name : null;
}

/**
 * Seed a project's metrics from its columns, once.
 *
 * Returns the existing list untouched when there is one — this is called on
 * every open of the Metrics tab, and a proposer that re-proposed would put back
 * every metric the user deleted. `datasetId` picks the dataset to read; with
 * none given it is the project's first, which is the only dataset a fresh
 * project has.
 */
async function ensureDefaults(projectId: string, datasetId?: string): Promise<metrics.MetricSummary[]> {
  const existing = await metrics.listMetrics(projectId);
  if (existing.length) return existing;

  const list = await datasets.listDatasets(projectId);
  const target = datasetId ? list.find((d) => d.id === datasetId) : list[0];
  if (!target) return existing;
  const meta = await datasets.getDatasetMeta(projectId, target.id);
  if (!meta || meta.live?.semanticPending) return existing; // a layer's dataset: sums over its dimensions would not be its metrics

  for (const input of proposeMetrics(target.id, meta.columns)) {
    await metrics.saveMetric(projectId, input);
  }
  return metrics.listMetrics(projectId);
}

/** A summary plus the two strings every surface shows beside it. */
async function decorate(projectId: string, list: metrics.MetricSummary[]): Promise<any[]> {
  const out: any[] = [];
  for (const s of list) {
    const ds = await datasets.getDatasetMeta(projectId, s.datasetId);
    out.push({
      ...s,
      datasetName: ds ? ds.name : null,
      definitionText: describeDefinition({ definition: s.definition, filters: [] }, undefined, await baseName(projectId, s.definition)),
      ...((await metricHidden(projectId, s.id)) ? { hidden: true } : {}), // it reads a column hidden from the caller (part 4, D19)
    });
  }
  return withStatus(projectId, 'metric', out);
}

/**
 * Is this name already a metric in this project?
 *
 * A duplicate NAME is refused, not disambiguated: a formula references a metric
 * by name, so two called "Revenue" would make `[Revenue]` mean whichever one
 * sorted first — a figure that changes when a record is renamed somewhere else
 * entirely. Exported for scripts/test-metrics.ts.
 */
export async function nameTaken(projectId: string, name: unknown, exceptId?: string): Promise<boolean> {
  return (await nameRefusal(projectId, name, exceptId)) !== null;
}

/** The sentence a name is refused with — another metric's, or a glossary term's name or alias (semantic D10) — or null. */
export async function nameRefusal(projectId: string, name: unknown, exceptId?: string): Promise<string | null> {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  const list = await metrics.listMetrics(projectId);
  if (list.some((m) => m.name.toLowerCase() === key && m.id !== exceptId)) return nameTakenMessage(name);
  const term = await termHolding(projectId, String(name));
  return term ? termNameTaken(String(name).trim(), term) : null;
}

export function register() {
  ipcMain.handle('metric:list', async (_e, { projectId }: any = {}) => {
    try {
      const list = await metrics.listMetrics(projectId);
      return { ok: true, metrics: await decorate(projectId, list) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to list metrics' };
    }
  });

  // Separate from `metric:list` on purpose: listing must never write, and the
  // Metrics tab is not the only thing that lists.
  ipcMain.handle('metric:ensureDefaults', async (_e, { projectId, datasetId }: any = {}) => {
    try {
      const list = await ensureDefaults(projectId, datasetId);
      return { ok: true, metrics: await decorate(projectId, list) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to propose metrics' };
    }
  });

  ipcMain.handle('metric:get', async (_e, { projectId, id }: any = {}) => {
    const t = await metrics.readMetric(projectId, id);
    if (!t) return { ok: false, error: 'Metric not found' };
    const timeColumnGone = !!t.rec.timeColumn && !(await metricDate(projectId, t.rec)); // counts as unset (./metricTimeScope); the editor says so
    return { ok: true, metric: t.rec, definitionText: describeDefinition(t.rec, undefined, await baseName(projectId, t.rec.definition)), tag: t.tag, ...(timeColumnGone ? { timeColumnGone } : {}) }; // tag: the metric dialog's base
  });

  ipcMain.handle('metric:save', async (_e, { projectId, input }: any = {}) => {
    try {
      const raw = input && typeof input === 'object' ? input : {};
      // `field`: which box of the editor the sentence belongs beside.
      const taken = await nameRefusal(projectId, raw.name);
      if (taken) return { ok: false, error: taken, field: 'name' };
      const per = (await checkPeriodDefinition(projectId, raw.datasetId, raw.definition, raw.timeColumn)) ?? (await checkFunnelDefinition(projectId, raw.datasetId, raw.definition)); if (per) return { ok: false, ...per };
      const snap = await snapshotProblem(projectId, raw.datasetId, raw.definition);
      if (snap) return { ok: false, error: snap, field: 'snapshot' };
      const when = await settleOnSave(projectId, raw);
      if ('error' in when) return { ok: false, error: when.error, field: 'timeColumn' };
      const tg = await checkTarget(projectId, { ...raw, id: '', name: String(raw.name), definition: metrics.sanitizeDefinition(raw.definition), ...when }, raw.target); if (tg) return { ok: false, ...tg };
      const m = await metrics.saveMetric(projectId, {
        ...raw,
        filters: sanitizeDashboardFilters(raw.filters),
        ...when,
      });
      if (!m) return { ok: false, error: 'Could not save the metric. Check the dataset still exists.' };
      await versions.record(projectId, 'metric', m);
      return { ok: true, metric: m };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to save the metric' };
    }
  });

  // `base`: the editor's content tag — a stale copy is 409 record_changed (src/app/editConflict.ts); `tag` is the next base.
  ipcMain.handle('metric:update', async (_e, { projectId, id, base, patch }: any = {}) => {
    try {
      const raw = patch && typeof patch === 'object' ? patch : {};
      const taken = raw.name !== undefined ? await nameRefusal(projectId, raw.name, id) : null;
      if (taken) return { ok: false, error: taken, field: 'name' };
      const before = await metrics.getMetric(projectId, id);
      const per = before && (raw.definition !== undefined || raw.timeColumn !== undefined) ? (await checkPeriodDefinition(projectId, before.datasetId, raw.definition ?? before.definition, raw.timeColumn)) ?? (await checkFunnelDefinition(projectId, before.datasetId, raw.definition ?? before.definition)) : null; if (per) return { ok: false, ...per };
      const snap = before ? await snapshotProblem(projectId, before.datasetId, raw.definition) : null;
      if (snap) return { ok: false, error: snap, field: 'snapshot' };
      const when = before ? await settleOnUpdate(projectId, before, raw) : {};
      if ('error' in when) return { ok: false, error: when.error, field: 'timeColumn' };
      const next = { ...raw, ...when };
      const tg = before && raw.target ? await checkTarget(projectId, { ...before, ...next, definition: next.definition !== undefined ? metrics.sanitizeDefinition(next.definition) : before.definition }, raw.target) : null; if (tg) return { ok: false, ...tg };
      if (raw.filters !== undefined) next.filters = sanitizeDashboardFilters(raw.filters);
      const m = await metrics.updateMetric(projectId, id, next, base);
      if (!m) return { ok: false, error: 'Metric not found' };
      await versions.record(projectId, 'metric', m, { before });
      return { ok: true, metric: m, tag: contentTag('metric', m) };
    } catch (err: any) {
      if (isRecordChanged(err)) throw err; // the route's 409
      return { ok: false, error: err?.message || 'Failed to update the metric' };
    }
  });

  ipcMain.handle('metric:duplicate', async (_e, { projectId, id }: any = {}) => {
    const src = await metrics.getMetric(projectId, id);
    if (src && metrics.isExternalDefinition(src.definition)) return { ok: false, error: externalNoDuplicate(src.name) }; // a second copy of a layer's definition
    const m = await metrics.duplicateMetric(projectId, id);
    return m ? { ok: true, metric: m } : { ok: false, error: 'Metric not found' };
  });

  ipcMain.handle('metric:delete', async (_e, { projectId, id }: any = {}) => {
    const done = await trash.trashRecord(projectId, 'metric', id); // to the Trash
    return done.ok ? { ok: true } : { ok: false, error: 'Could not delete the metric' };
  });

  // `asOf` (view state, data/asOf.ts): every dataset read as of that time.
  // `share` (server-side callers only — a report, a send; the contract has no such field): the figure is about to
  // LEAVE the app, so the Share policy judges the columns it was totalled from (publish/kpiPolicy), as visual:data's does.
  ipcMain.handle('metric:value', async (_e, { projectId, id, filters, params, asOf, currency, share }: any = {}) => withAsOf(projectId, asOf, () => fxScope(currency, async () => {
    try {
      const values = paramValues(params);
      const bound = resolveFilterParams(sanitizeDashboardFilters(filters), values);
      const leaving = isSharePath(share) && share !== 'bundle';
      const reads: MetricRead[] = [];
      const res = await resolveMetric(projectId, id, { filters: bound.steps, params: values, ...(leaving ? { reads } : {}) });
      if (!res) return { ok: false, error: 'Metric not found' };
      const hidden = leaving ? await kpiHidden(projectId, reads, share) : '';
      if (hidden) return { ok: false, error: hidden, hiddenByPolicy: true, name: res.name };
      // Dated by the metric's dataset (L0.2, data/figureAsOf), inside the as-of scope.
      const dated = await stampAsOf(res, projectId, [(await metrics.getMetric(projectId, id))?.datasetId]);
      if (!res.refused) Object.assign(dated, await targetField(projectId, id, bound.steps, res.value)); // part 5, D14: the server's, graded
      return bound.errors.length ? { ...dated, paramErrors: bound.errors } : dated;
    } catch (err: any) {
      if (isRowPolicyError(err)) return rowPolicyRefusal(err.reason); // typed, so a tile never shows its stored column instead
      return { ok: false, error: err?.message || 'Failed to compute the metric', ...liveCodeOf(err) };
    }
  })));

  /**
   * The editor's live preview: a figure for a definition that has NOT been
   * saved. Same resolver, same formatter, so what the preview shows is what the
   * record will produce.
   */
  ipcMain.handle('metric:preview', async (_e, { projectId, datasetId, definition, filters, format }: any = {}) => {
    try {
      return await previewDefinition(projectId, datasetId, definition, filters, format);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to preview the metric', ...liveCodeOf(err) };
    }
  });

  ipcMain.handle('metric:series', async (_e, { projectId, id, column, filters }: any = {}) => {
    try {
      const m = await metrics.getMetric(projectId, id);
      if (!m) return { ok: false, error: 'Metric not found' };
      const by = typeof column === 'string' && column ? column : await sparkColumn(projectId, m);
      // No date column is not an error — it is a metric with no sparkline, and
      // the cell stays blank.
      if (!by) return { ok: true, series: null };
      const series = await resolveMetricSeries(projectId, id, by, { filters: sanitizeDashboardFilters(filters) });
      return { ok: true, series, column: by };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to compute the series' };
    }
  });

  ipcMain.handle('metric:usage', async (_e, { projectId, id }: any = {}) => {
    try {
      return { ok: true, usage: await metricUsage(projectId, id) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to read usage' };
    }
  });
}
