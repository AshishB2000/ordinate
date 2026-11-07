// A metric's target under a scope (semantic layer part 5, D12–D14) — MAIN PROCESS. The plan is another metric over a
// plan dataset (or a fixed figure); the arithmetic of periods is analysis/targetMath. The server decides the target,
// the attainment and the status, and says in a sentence why there is none: React prints what it is sent.
//
//   - Additive across time: Σ over periods of target × days covered ÷ days in the period (whole periods resolved
//     together, at most three plan resolutions). Any other metric: the plan over the covered range widened to whole
//     periods, never pro-rated; a fixed figure holds at any scope.
//   - Every scope filter but the date bounds must apply to the plan the way a filter already applies (its own column,
//     or a related table's), else NO target — never the unfiltered plan, which the engine would give silently.
//   - Row rules must restrict the actuals and the plan, or neither.

import * as metrics from '../analysis/metrics';
import type { Metric } from '../analysis/metrics';
import { metricsByName } from '../analysis/metrics';
import type { MetricTargetSpec } from '../analysis/metricTarget';
import { metricDate, metricScope } from '../analysis/metricTimeScope';
import { additivityOf } from '../analysis/additivity';
import { formatMetricValue } from '../analysis/metricFormat';
import { defaultThresholds, rowStatus } from '../analysis/scorecardModel';
import type { RowStatus } from '../analysis/scorecardModel';
import { fixedTarget, periodParts, planAsks, widened } from '../analysis/targetMath';
import type { PeriodPart } from '../analysis/targetMath';
import * as msg from '../analysis/targetMessages';
import { scopeRange } from '../analysis/periodScope';
import { windowedScope } from '../analysis/periodMath';
import { getCalendar, todayIso } from '../analysis/dateIntel';
import { resolveColumnOwner } from '../analysis/joinPlan';
import { listRelationships } from '../analysis/relationships';
import { expandTerms } from '../analysis/termExpand';
import { formatNumber } from '../app/format';
import * as datasets from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import { isRowPolicyError, rowLockFor } from '../data/rowAccess';
import { isLiveFigureError } from '../engine/live/liveFigureError';
import { TermNotExpandedError } from '../data/termStep';
import { infoFor } from './relationships';
import * as ipcMetrics from './metrics';
import type { MetricRead } from './metrics';
import { baseOf } from './periodMetric';
import { kpiHidden } from '../publish/kpiPolicy';
import type { Outgoing } from '../publish/dashboardData';
import type { SharePath } from '../app/privacyStore';

export interface TargetResult {
  value: number | null;
  display: string;
  attainment: number | null;
  attainmentDisplay: string;
  status: RowStatus;
  /** How the target was worked out ("1.2M for Nov 2024, pro-rated to Nov 20"). */
  how?: string;
  /** Why there is no target. */
  none?: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (iso: string): string => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const BOUNDS = new Set(['>=', '>', '<=', '<']);

const noTarget = (none: string): TargetResult => ({ value: null, display: '', attainment: null, attainmentDisplay: '', status: 'none', none });

/** The date bounds of the metric's own date column: the dates the plan is matched on, so not filters the plan must apply. */
const isDateBound = (s: FilterStep, dateCol: string): boolean => !!dateCol && s.column === dateCol && (s.op === 'period' || BOUNDS.has(s.op));

/** The scope's other filters, as the plan applies them, or the sentence naming what it lacks. */
async function planFilters(projectId: string, planDs: string, scope: FilterStep[], dateCol: string): Promise<FilterStep[] | string> {
  let steps: FilterStep[];
  try {
    const x = await expandTerms(projectId, planDs, scope);
    if (x.notes.length) return msg.targetPlanTerm();
    steps = x.steps;
  } catch (err) {
    if (err instanceof TermNotExpandedError) return msg.targetPlanTerm();
    throw err;
  }
  const own = new Set(((await datasets.getDatasetMeta(projectId, planDs))?.columns ?? []).map((c) => c.name));
  const rels = await listRelationships(projectId);
  const ids = new Set([planDs]);
  for (const r of rels) { ids.add(r.from.datasetId); ids.add(r.to.datasetId); }
  const infos = new Map<string, NonNullable<Awaited<ReturnType<typeof infoFor>>>>();
  for (const id of ids) { const i = await infoFor(projectId, id); if (i) infos.set(id, i); }
  const out: FilterStep[] = [];
  for (const s of steps) {
    if (isDateBound(s, dateCol)) continue;
    const applies = !s.via && !s.datasetId && (own.has(s.column) || resolveColumnOwner(planDs, s.column, rels, infos) !== null);
    if (!applies) return msg.targetPlanLacks(s.column);
    out.push(s);
  }
  return out;
}

const bounds = (column: string, r: { from?: string; to?: string }): FilterStep[] => [
  ...(r.from ? [{ type: 'filter', column, op: '>=', value: r.from } as FilterStep] : []),
  ...(r.to ? [{ type: 'filter', column, op: '<=', value: r.to } as FilterStep] : []),
];

/** True when the caller's row rules treat the actuals' dataset and the plan's alike (both locked, or neither). Throws RowPolicyError. */
async function rulesAgree(projectId: string, a: string, b: string): Promise<boolean> {
  return (await rowLockFor(projectId, a) === null) === (await rowLockFor(projectId, b) === null);
}

/** What a scope makes of a target: the closed range it covers and the `per` periods in it. */
interface Frame { filters: FilterStep[]; dateCol: string; adds: boolean; range?: { from?: string; to?: string }; parts: PeriodPart[] }

/**
 * A period metric's target is its base's over the days its figure covers (the window, as ./periodMetric draws it),
 * added up as the base adds up: a YTD target is the pro-rated sum of the monthly plan. One that compares periods has none.
 */
async function periodFrame(projectId: string, m: Metric, filters: FilterStep[]): Promise<{ judged: Metric; filters: FilterStep[] } | string> {
  if (!metrics.isPeriodDefinition(m.definition)) return { judged: m, filters };
  if (m.definition.compare) return msg.targetOnCompare();
  const found = await baseOf(projectId, m.datasetId, m.definition);
  if ('error' in found) return found.error;
  return { judged: found.base, filters: windowedScope(filters, found.date, m.definition.window, todayIso(), getCalendar()).filters };
}

/** The frame, a fixed figure that holds at any scope, or the sentence naming why there is no target. */
async function frameOf(projectId: string, m: Metric, spec: MetricTargetSpec, scope: FilterStep[]): Promise<{ frame: Frame } | { fixed: number } | string> {
  const s = await metricScope(projectId, m, scope);
  if (!s.ok) return s.error;
  const p = await periodFrame(projectId, m, s.filters);
  if (typeof p === 'string') return p;
  const dateCol = await metricDate(projectId, m);
  const byName = await metricsByName(projectId);
  const columns = (await datasets.getDatasetMeta(projectId, m.datasetId))?.columns ?? [];
  const adds = additivityOf(p.judged, columns, byName).time;
  if (adds && !spec.per) return msg.targetNeedsPer();
  if (!adds && 'value' in spec.source) return { fixed: spec.source.value }; // a fixed figure holds at any scope
  const cal = getCalendar();
  const found = dateCol ? scopeRange(p.filters, [{ name: dateCol, type: 'date' }])?.range : undefined;
  const today = todayIso();
  const range = found ? { from: found.from, to: found.to && found.to < today ? found.to : today } : undefined;
  const closed = range && range.from && range.to && range.from <= range.to ? { from: range.from, to: range.to } : null;
  if (adds && !closed) return msg.targetPickPeriod();
  const parts = closed && spec.per ? periodParts(closed, spec.per, cal) : [];
  if (adds && !parts.length) return msg.targetPickPeriod();
  return { frame: { filters: p.filters, dateCol, adds, range, parts } };
}

/** The plan metric a frame is matched to, its date, and the scope's filters as the plan applies them; or the sentence naming why not. */
async function planCtx(projectId: string, m: Metric, plan: Metric | null, f: Frame): Promise<{ plan: Metric; planDate: string; filters: FilterStep[] } | string> {
  if (!plan) return msg.targetPlanGone();
  const planDate = await metricDate(projectId, plan);
  if (!planDate && (f.adds || f.range)) return msg.targetPlanNoDate(plan.name);
  if (!(await rulesAgree(projectId, m.datasetId, plan.datasetId))) return msg.targetRowRules();
  const filters = await planFilters(projectId, plan.datasetId, f.filters, f.dateCol);
  return typeof filters === 'string' ? filters : { plan, planDate, filters };
}

async function targetFigure(projectId: string, m: Metric, spec: MetricTargetSpec, scope: FilterStep[]): Promise<{ value: number | null; how?: string } | string> {
  const fr = await frameOf(projectId, m, spec, scope);
  if (typeof fr === 'string') return fr;
  if ('fixed' in fr) return { value: fr.fixed };
  const { adds, range, parts } = fr.frame;
  if ('value' in spec.source) return { value: fixedTarget(spec.source.value, parts), ...howOf(m, spec.source.value, parts) };

  const pc = await planCtx(projectId, m, await metrics.getMetric(projectId, spec.source.metricId), fr.frame);
  if (typeof pc === 'string') return pc;
  const { plan, planDate, filters } = pc;
  const ask = async (r: { from?: string; to?: string }): Promise<number | null> =>
    (await ipcMetrics.resolveMetric(projectId, plan.id, { filters: [...filters, ...bounds(planDate, r)] }))?.value ?? null;
  if (!adds) return { value: await ask(parts.length ? widened(parts) : (range ?? {})) }; // widened to whole periods, never pro-rated
  let total: number | null = null;
  let single: number | null = null;
  const asks = planAsks(parts);
  for (const a of asks) {
    const v = await ask(a);
    if (v !== null) total = (total ?? 0) + v * a.fraction;
    single = v;
  }
  return { value: total, ...(asks.length === 1 && single !== null ? howOf(m, single, parts) : {}) };
}

/**
 * The plan behind `m`'s target under `scope`, for a chart that splits it by a column (the plan's own column of that
 * name): the plan metric, the filters it takes, and the resolutions to make, each with the share that counts. A fixed
 * figure that doesn't add up is the same for every bar; any other target that can't be split says why (`''`: not worth a note).
 */
export async function targetPlan(projectId: string, m: Metric, scope: FilterStep[]): Promise<{ plan: Metric; planDatasetId: string; planDate: string; filters: FilterStep[]; asks: Array<{ from?: string; to?: string; fraction: number }> } | { fixed: number } | { none: string }> {
  const spec = m.target;
  if (!spec) return { none: '' };
  try {
    const fr = await frameOf(projectId, m, spec, scope);
    if (typeof fr === 'string') return { none: fr };
    if ('fixed' in fr) return fr;
    if ('value' in spec.source) return { none: '' }; // a fixed figure for a metric that adds up is for the whole, not for each bar
    const { adds, range, parts } = fr.frame;
    const pc = await planCtx(projectId, m, await metrics.getMetric(projectId, spec.source.metricId), fr.frame);
    if (typeof pc === 'string') return { none: pc };
    const asks = adds ? planAsks(parts) : [{ ...(parts.length ? widened(parts) : (range ?? {})), fraction: 1 }];
    return { plan: pc.plan, planDatasetId: pc.plan.datasetId, planDate: pc.planDate, filters: pc.filters, asks };
  } catch (err) {
    if (isRowPolicyError(err)) return { none: msg.targetRowRules() };
    if (isLiveFigureError(err)) return { none: err.message };
    throw err;
  }
}

/** "1.2M for Nov 2024, pro-rated to Nov 20": one period only (a span has no single full figure). */
function howOf(m: Metric, full: number, parts: ReturnType<typeof periodParts>): { how?: string } {
  if (parts.length !== 1) return {};
  const [p] = parts;
  const shown = formatMetricValue(full, m.format);
  return { how: p.covered === p.days ? msg.targetHowWhole(shown, p.label) : msg.targetHowProRated(shown, p.label, dayLabel(isoEnd(p))) };
}

/** The last day the range covers of a part (its first day plus the covered days). */
function isoEnd(p: { from: string; covered: number }): string {
  const d = new Date(`${p.from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + p.covered - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * The target of `m` under `scope`, with the attainment and status of `value` against it; null when `m` has none. A
 * target the row rules or the scope make unanswerable is `none` + the sentence, never a thrown tile.
 */
export async function metricTarget(projectId: string, m: Metric, scope: FilterStep[], value: number | null): Promise<TargetResult | null> {
  const spec = m.target;
  if (!spec) return null;
  let fig: Awaited<ReturnType<typeof targetFigure>>;
  try {
    fig = await targetFigure(projectId, m, spec, scope);
  } catch (err) {
    if (isRowPolicyError(err)) return noTarget(msg.targetRowRules());
    if (isLiveFigureError(err)) return noTarget(err.message);
    throw err;
  }
  if (typeof fig === 'string') return noTarget(fig);
  const target = fig.value;
  const { status, attainment } = rowStatus(value, target, spec.thresholds ?? defaultThresholds(m.direction), m.direction);
  return {
    value: target,
    display: target === null ? '' : formatMetricValue(target, m.format),
    attainment,
    attainmentDisplay: attainment === null ? '' : `${formatNumber(Math.round(attainment), { decimals: 0 })}%`,
    status,
    ...(fig.how ? { how: fig.how } : {}),
  };
}

/** `metricTarget` for a metric by id (null when it is gone or has no target). */
export async function targetFor(projectId: string, metricId: string, scope: FilterStep[], value: number | null): Promise<TargetResult | null> {
  const m = await metrics.getMetric(projectId, metricId);
  return m ? metricTarget(projectId, m, scope, value) : null;
}

/** `{ target }` to spread into a reply, or nothing: a metric with no target adds no key. */
export async function targetField(projectId: string, metricId: string, scope: FilterStep[], value: number | null, hidden = ''): Promise<{ target?: TargetResult }> {
  if (hidden) return { target: noTarget(hidden) }; // `hidden`: targetHidden's words, on a way out
  const target = await targetFor(projectId, metricId, scope, value);
  return target ? { target } : {};
}

/** Every column the plan behind `m`'s target is totalled from (the resolver's own `reads`); none for a fixed figure. */
export async function planReads(projectId: string, m: Pick<Metric, 'target'>): Promise<MetricRead[]> {
  const source = m.target?.source;
  if (!source || !('metricId' in source)) return [];
  const reads: MetricRead[] = [];
  // Resolved for its columns alone. A plan that cannot be resolved gives no target either; the columns it reached are still collected.
  await ipcMetrics.resolveMetric(projectId, source.metricId, { reads }).catch(() => undefined);
  return reads;
}

/**
 * On a way out (publish/kpiPolicy): the Share policy's words when `metricId`'s target is drawn from a column the policy
 * drops, else ''. Every target that leaves — a tile's, a scorecard row's, metric_value's, a chart's line, an alert's
 * post — is judged on its plan's columns here, as a KPI totalled from them is.
 */
export async function targetHidden(projectId: string, metricId: string, via: Outgoing | SharePath | undefined): Promise<string> {
  if (!via) return '';
  const m = await metrics.getMetric(projectId, metricId);
  return m?.target ? kpiHidden(projectId, await planReads(projectId, m), via) : '';
}

/** Why a target may not be saved on `m`, beside the Target box, or null. */
export async function checkTarget(projectId: string, m: Pick<Metric, 'id' | 'name' | 'datasetId' | 'definition' | 'timeColumn'>, t: unknown): Promise<{ error: string; field: 'target' } | null> {
  const spec = t && typeof t === 'object' ? (t as MetricTargetSpec) : null;
  if (!spec) return null;
  const refuse = (error: string): { error: string; field: 'target' } => ({ error, field: 'target' });
  const period = metrics.isPeriodDefinition(m.definition) ? m.definition : null;
  if (period?.compare) return refuse(msg.targetOnCompare());
  const columns = (await datasets.getDatasetMeta(projectId, m.datasetId))?.columns ?? [];
  // A period metric's target adds up as its base does (periodFrame); a base that is gone is the period check's to say.
  const judged = (period && (await metrics.getMetric(projectId, period.base))) || m;
  // shortcut: the metric's own filters don't change whether it adds up, so none are passed; read them in if one ever does
  const adds = additivityOf({ ...judged, filters: [] }, columns, await metricsByName(projectId)).time;
  if (adds && !spec.per) return refuse(msg.targetNeedsPer());
  if (spec.per && !(await metricDate(projectId, m))) return refuse(msg.targetNeedsDate());
  if ('metricId' in spec.source) {
    const plan = await metrics.getMetric(projectId, spec.source.metricId);
    if (!plan) return refuse(msg.targetPlanGone());
    if (plan.id === m.id) return refuse(msg.targetOwnPlan());
    if (!(await metricDate(projectId, plan))) return refuse(msg.targetPlanNoDate(plan.name));
  }
  return null;
}
