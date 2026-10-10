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

import { ipcMain } from './bus';

import * as metrics from '../analysis/metrics';
import type { Metric, MetricDefinition } from '../analysis/metrics';
import { isFormulaDefinition } from '../analysis/metrics';
import { formatMetricValue, describeDefinition } from '../analysis/metricFormat';
import { compileMetricFormula, evaluateMetricFormula } from '../analysis/metricFormula';
import { proposeMetrics } from '../analysis/metricAuto';
import { metricUsage } from '../analysis/metricUsage';
import { computeCardMetric } from './dashboards';
import { bindFormulaText, paramValues, resolveFilterParams } from '../analysis/params';
import type { ParamValues } from '../analysis/params';
import { sanitizeDashboardFilters } from '../analysis/dashboards';
import * as datasets from '../data/datasets';
import { readDistinctPage, distinctValuesPageJs } from '../engine/datasetPage';
import { periodPlan, orderPeriods } from '../analysis/insightsAgg';
import type { FilterStep } from '../data/transforms';
import { relatedColumnNames } from './relationships';
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
import { isLiveDatasetError } from '../data/liveDataset';

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
interface ResolveCtx {
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
}

/** The older of two live times: a figure is as old as its oldest operand. */
function olderAsOf(a: AsOf | undefined, b: AsOf | undefined): AsOf | undefined {
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
async function resolveDefinition(
  ctx: ResolveCtx,
  datasetId: string,
  definition: MetricDefinition,
  filters: FilterStep[],
  depth: number,
): Promise<number | null> {
  // The metric's OWN filters may reference a dashboard parameter too; the
  // scope arrived already resolved by the handler.
  const all = resolveFilterParams(filters, ctx.params).steps.concat(ctx.scope);

  if (!isFormulaDefinition(definition)) {
    if (!definition.column) return null;
    const res = await computeCardMetric(ctx.projectId, datasetId, definition, all, ctx.params);
    ctx.fx = mergeFx(ctx.fx, res.fx);
    ctx.asOf = olderAsOf(ctx.asOf, res.asOf);
    return res.ok ? res.value : null;
  }

  if (depth > MAX_FORMULA_DEPTH) return null;

  const meta = await datasets.getDatasetMeta(ctx.projectId, datasetId);
  // A related dataset's columns too: `sum(revenue) / sum(target)` reaches Targets
  // through the project's relationships, resolved by computeCardMetric's join hook.
  const columns = (meta ? meta.columns.map((c) => c.name) : []).concat(await relatedColumnNames(ctx.projectId, datasetId));
  // `[Revenue] * [[growth]]` — the parameter becomes a literal before parsing.
  const compiled = compileMetricFormula(bindFormulaText(definition.formula, ctx.params).text, columns);
  if (!compiled.ok) return null;

  const values = new Map<string, number | null>();

  // Aggregations over this metric's own dataset — `sum(revenue)`.
  for (const agg of compiled.program.aggregates) {
    const res = await computeCardMetric(
      ctx.projectId,
      datasetId,
      { column: agg.column, aggregation: agg.aggregation },
      all,
      ctx.params,
    );
    ctx.fx = mergeFx(ctx.fx, res.fx);
    ctx.asOf = olderAsOf(ctx.asOf, res.asOf);
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
  let value: number | null;
  try {
    value = await resolveDefinition(ctx, metric.datasetId, metric.definition, metric.filters, depth);
  } finally {
    ctx.stack.delete(key);
  }
  ctx.memo.set(key, value);
  return value;
}

function newCtx(projectId: string, scope: FilterStep[], params: ParamValues = new Map()): ResolveCtx {
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
  scope: { filters?: FilterStep[]; params?: ParamValues } = {},
): Promise<ResolvedMetric | null> {
  const metric = await metrics.getMetric(projectId, metricId);
  if (!metric) return null;
  const ctx = newCtx(projectId, Array.isArray(scope.filters) ? scope.filters : [], scope.params);
  // Seeded so a self-reference inside this metric's own formula is caught by the
  // same guard that catches a loop between two of them.
  ctx.stack.add(metric.name.toLowerCase());
  const value = await resolveDefinition(ctx, metric.datasetId, metric.definition, metric.filters, 0);
  ctx.stack.delete(metric.name.toLowerCase());
  const out: ResolvedMetric = {
    ok: true,
    id: metric.id,
    name: metric.name,
    value,
    display: displayOf(value, metric.format, ctx.fx, !isFormulaDefinition(metric.definition)),
    format: metric.format,
    definitionText: describeDefinition(metric),
  };
  if (metric.direction) out.direction = metric.direction;
  if (ctx.fx) out.fx = ctx.fx;
  if (ctx.asOf) out.asOf = ctx.asOf;
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
    display: displayOf(value, metrics.sanitizeFormat(format), ctx.fx, !isFormulaDefinition(def)),
    ...(ctx.fx ? { fx: ctx.fx } : {}),
    ...(ctx.asOf ? { asOf: ctx.asOf } : {}),
    definitionText: describeDefinition({ definition: def, filters: own }),
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
    const src = await datasets.residentSource(projectId, datasetId);
    if (src) {
      const fast = await readDistinctPage(src, column, { limit: SERIES_SCAN, search: '' });
      if (fast) return fast.values;
    }
    const ds = await datasets.getDataset(projectId, datasetId);
    if (!ds) return null;
    return distinctValuesPageJs(ds.columns, ds.rows, column, { limit: SERIES_SCAN, search: '' }).values;
  } catch (err) {
    // D6: "no series" would be a silent blank for a Live dataset — its sparkline
    // is not routed (one statement per point; L2.4 log), so it refuses, typed.
    if (isLiveDatasetError(err)) throw err;
    return null;
  }
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
 * definition of a period is two too many. A non-date column rolls up to itself,
 * which makes this "by region" without a second code path.
 */
export async function resolveMetricSeries(
  projectId: string,
  metricId: string,
  byColumn: string,
  scope: { filters?: FilterStep[] } = {},
): Promise<MetricSeries | null> {
  const metric = await metrics.getMetric(projectId, metricId);
  if (!metric || !byColumn) return null;
  const labels = await distinctValues(projectId, metric.datasetId, byColumn);
  if (!labels || !labels.length) return null;

  const plan = periodPlan(labels);
  const keys = orderPeriods(Array.from(new Set(labels.map((l) => plan.of(l))))).slice(-SERIES_MAX_POINTS);
  if (!keys.length) return null;

  const base = Array.isArray(scope.filters) ? scope.filters : [];
  const out: MetricSeries = { labels: keys, values: [], display: [] };
  for (const key of keys) {
    const ctx = newCtx(projectId, base.concat([
      { type: 'filter', column: byColumn, op: plan.op, value: key } as FilterStep,
    ]));
    ctx.stack.add(metric.name.toLowerCase());
    const v = await resolveDefinition(ctx, metric.datasetId, metric.definition, metric.filters, 0);
    out.values.push(v);
    out.display.push(displayOf(v, metric.format, ctx.fx, !isFormulaDefinition(metric.definition)));
  }
  return out;
}

/**
 * The date column a sparkline runs along, or null.
 *
 * First declared date column: a dataset with two of them (ordered/shipped) has
 * no app-knowable "the" date, and the first one is at least the same choice
 * every time rather than a different one per machine.
 */
async function sparkColumn(projectId: string, datasetId: string): Promise<string | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
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
  if (!meta) return existing;

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
      definitionText: describeDefinition({ definition: s.definition, filters: [] }),
    });
  }
  return out;
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
  const key = String(name || '').trim().toLowerCase();
  if (!key) return false;
  const list = await metrics.listMetrics(projectId);
  return list.some((m) => m.name.toLowerCase() === key && m.id !== exceptId);
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
    const m = await metrics.getMetric(projectId, id);
    if (!m) return { ok: false, error: 'Metric not found' };
    return { ok: true, metric: m, definitionText: describeDefinition(m) };
  });

  ipcMain.handle('metric:save', async (_e, { projectId, input }: any = {}) => {
    try {
      const raw = input && typeof input === 'object' ? input : {};
      // `field`: which box of the editor the sentence belongs beside.
      if (await nameTaken(projectId, raw.name)) return { ok: false, error: nameTakenMessage(raw.name), field: 'name' };
      const m = await metrics.saveMetric(projectId, {
        ...raw,
        filters: sanitizeDashboardFilters(raw.filters),
      });
      if (!m) return { ok: false, error: 'Could not save the metric — check the dataset still exists.' };
      await versions.record(projectId, 'metric', m);
      return { ok: true, metric: m };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to save the metric' };
    }
  });

  ipcMain.handle('metric:update', async (_e, { projectId, id, patch }: any = {}) => {
    try {
      const raw = patch && typeof patch === 'object' ? patch : {};
      if (raw.name !== undefined && (await nameTaken(projectId, raw.name, id))) return { ok: false, error: nameTakenMessage(raw.name), field: 'name' };
      const next = { ...raw };
      if (raw.filters !== undefined) next.filters = sanitizeDashboardFilters(raw.filters);
      const before = await metrics.getMetric(projectId, id);
      const m = await metrics.updateMetric(projectId, id, next);
      if (!m) return { ok: false, error: 'Metric not found' };
      await versions.record(projectId, 'metric', m, { before });
      return { ok: true, metric: m };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to update the metric' };
    }
  });

  ipcMain.handle('metric:duplicate', async (_e, { projectId, id }: any = {}) => {
    const m = await metrics.duplicateMetric(projectId, id);
    return m ? { ok: true, metric: m } : { ok: false, error: 'Metric not found' };
  });

  ipcMain.handle('metric:delete', async (_e, { projectId, id }: any = {}) => {
    const done = await trash.trashRecord(projectId, 'metric', id); // to the Trash
    return done.ok ? { ok: true } : { ok: false, error: 'Could not delete the metric' };
  });

  // `asOf` (view state, data/asOf.ts): every dataset read as of that time.
  ipcMain.handle('metric:value', async (_e, { projectId, id, filters, params, asOf, currency }: any = {}) => withAsOf(projectId, asOf, () => fxScope(currency, async () => {
    try {
      const values = paramValues(params);
      const bound = resolveFilterParams(sanitizeDashboardFilters(filters), values);
      const res = await resolveMetric(projectId, id, { filters: bound.steps, params: values });
      if (!res) return { ok: false, error: 'Metric not found' };
      // Dated by the metric's dataset (L0.2, data/figureAsOf), inside the as-of scope.
      const dated = await stampAsOf(res, projectId, [(await metrics.getMetric(projectId, id))?.datasetId]);
      return bound.errors.length ? { ...dated, paramErrors: bound.errors } : dated;
    } catch (err: any) {
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
      const by = typeof column === 'string' && column ? column : await sparkColumn(projectId, m.datasetId);
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
