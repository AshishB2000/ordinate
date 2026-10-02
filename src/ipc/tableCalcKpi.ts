// A KPI card's "Calculate as" — MAIN PROCESS.
//
// A KPI shows ONE figure, so its grid is the card's own metric broken out by
// PERIOD: the calendar months of the dataset's first date column (the
// sparkline's choice of column, ipc/metrics), oldest first, under the
// dashboard's filters. The calc runs on that
// series (analysis/tableCalc.calcSequence) and the card shows the LATEST
// period's cell:
//
//   running_total     cumulative to the latest period
//   diff / pct_diff   the latest period against the one before it
//   rank / percentile the latest period among the periods
//   moving avg / sum  the trailing N periods ending at the latest
//   yoy               the latest period against the same period a year earlier
//   index             the latest period ÷ the first × 100
//
// and one kind that is not about periods at all:
//
//   pct_of_total      the card's figure ÷ the SAME figure with the dashboard's
//                     filters and controls removed — "this selection is 24.1% of
//                     all of it". A saved metric keeps its own definition
//                     filters, which are part of what the metric IS.
//
// A dataset with no date column has no periods: every kind but pct_of_total
// answers `reason: 'no_date_column'` and the Properties panel shows those kinds
// disabled, saying so. Nothing here is stored — recomputed on every render,
// through the same resolvers the card's own figure uses.

import { ipcMain } from 'electron';

import * as datasets from '../data/datasets';
import * as metrics from '../analysis/metrics';
import type { Metric } from '../analysis/metrics';
import { isFormulaDefinition } from '../analysis/metrics';
import { sanitizeDashboardFilters } from '../analysis/dashboards';
import type { MetricAggregation } from '../analysis/metricValue';
import { formatMetricValue } from '../analysis/metricFormat';
import { paramValues, resolveFilterParams } from '../analysis/params';
import type { ParamValues } from '../analysis/params';
import type { FilterStep } from '../data/transforms';
import { formatValue } from '../app/format';
import { CALC_KIND_NAMES, CALC_WINDOW_DEFAULT, calcParts, calcSequence, isMovingKind, isPercentKind, sanitizeTableCalc } from '../analysis/tableCalc';
import type { TableCalc } from '../analysis/tableCalc';
import { shiftBucketLabel } from '../analysis/dateIntel';
import { bucketRange } from '../analysis/driverScope';
import { activeWeekCal } from '../analysis/retailCalendar';
import type { DateGrain } from '../analysis/categoryKey';
import { computeCardMetric } from './dashboards';
import { resolveMetric } from './metrics';
import { vizDataFor } from './visuals';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface KpiCard { metricId?: string; datasetId?: string; column?: string; aggregation?: string; format?: string }

export interface KpiCalcResult {
  ok: boolean;
  error?: string;
  /** Set when the kind has nothing to run over. */
  reason?: 'no_date_column' | 'no_periods' | 'not_a_date_axis';
  kind?: string;
  value?: number | null;
  raw?: number | null;
  /** The calculated figure as the card shows it: "24.1%", "+12.3K", "#2". */
  text?: string;
  /** The line under it: "of total · 1.25M", "vs previous · 456.7K in 2024-12". */
  line?: string;
  /** The period the figure is for (periods kinds only). */
  period?: string;
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

interface Scope {
  projectId: string;
  metric: Metric | null;
  card: KpiCard;
  datasetId: string;
  params: ParamValues;
}

/** The card's figure under `filters` — exactly the resolver the card itself uses. */
async function figure(s: Scope, filters: FilterStep[]): Promise<number | null> {
  if (s.metric) {
    const r = await resolveMetric(s.projectId, s.metric.id, { filters, params: s.params });
    return r ? finite(r.value) : null;
  }
  const spec = { column: String(s.card.column || ''), aggregation: s.card.aggregation as MetricAggregation };
  const r = await computeCardMetric(s.projectId, s.datasetId, spec, filters, s.params);
  return r.ok ? finite(r.value) : null;
}

/** A formula metric is resolved once per period; past this many it is a chart, not a KPI. */
const FORMULA_PERIODS = 24;

/**
 * The figure per calendar MONTH of `dateCol`, oldest first — a KPI's periods.
 *
 * A column card, or a saved metric that is a column rolled up, groups ONCE
 * through the chart path (`vizDataFor`, resident first) with the metric's own
 * filters ANDed in: every month, one query. A FORMULA metric is only right
 * resolved per month (`[Profit] / [Revenue]` per month is each month's ratio),
 * so it takes the months from that same grouping and resolves each one.
 *
 * Not `resolveMetricSeries`: its distinct-date scan is clamped to 200 values by
 * `datasetPage.MAX_DISTINCT`, so two years of daily rows stop in month seven.
 * ponytail: a formula metric's series is its last FORMULA_PERIODS months, so a
 * running total there is cumulative over those.
 */
async function periodSeries(
  s: Scope, dateCol: string, filters: FilterStep[],
): Promise<{ labels: string[]; values: (number | null)[]; grain: DateGrain | null } | null> {
  const def = s.metric ? s.metric.definition : null;
  const formula = def !== null && isFormulaDefinition(def);
  const measure = def && !isFormulaDefinition(def)
    ? { column: def.column, aggregation: def.aggregation }
    : formula ? { column: dateCol, aggregation: 'count' as const }
      : { column: String(s.card.column || ''), aggregation: s.card.aggregation as MetricAggregation };
  const scoped = s.metric && !formula ? s.metric.filters.concat(filters) : filters;
  const reply = await vizDataFor(s.projectId, s.datasetId,
    { category: dateCol, values: [measure], grain: 'month' }, scoped, { params: s.params });
  if (!reply.ok || !reply.data.series[0]) return null;
  // Real months only: rows with no date form a blank bucket, which is not a period.
  // Under a week calendar the "months" are its periods (FY24 P03).
  const all = reply.data.labels.map(String);
  const keep = all.map((_, i) => i).filter((i) => (activeWeekCal() ? bucketRange(all[i], 'month') !== null : /^\d{4}-\d{2}$/.test(all[i])));
  const labels = keep.map((i) => all[i]);
  if (!formula || !s.metric) {
    const values = reply.data.series[0].values;
    return { labels, values: keep.map((i) => values[i] ?? null), grain: 'month' };
  }
  const months = labels.slice(-FORMULA_PERIODS);
  const values: (number | null)[] = [];
  for (const m of months) {
    // A period of a week calendar is not a substring of its dates: filter on its days.
    const days = activeWeekCal() ? bucketRange(m, 'month') : null;
    const step: FilterStep = days
      ? { type: 'filter', column: dateCol, op: 'period', period: { preset: 'custom', from: days.from, to: days.to } }
      : { type: 'filter', column: dateCol, op: 'contains', value: m };
    const r = await resolveMetric(s.projectId, s.metric.id, { filters: filters.concat([step]), params: s.params });
    values.push(r ? finite(r.value) : null);
  }
  return { labels: months, values, grain: 'month' };
}

/** The first date column — the sparkline's rule, so the card and the Metrics table agree. */
async function dateColumnOf(projectId: string, datasetId: string): Promise<string | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  const col = meta ? meta.columns.find((c) => c.type === 'date') : undefined;
  return col ? col.name : null;
}

async function scopeOf(projectId: string, card: KpiCard, rawParams: unknown): Promise<Scope | null> {
  const metric = card.metricId && UUID_RE.test(card.metricId) ? await metrics.getMetric(projectId, card.metricId) : null;
  const datasetId = metric ? metric.datasetId : String(card.datasetId || '');
  if (!UUID_RE.test(datasetId)) return null;
  if (!metric && (!card.column || !card.aggregation)) return null;
  return { projectId, metric, card, datasetId, params: paramValues(rawParams) };
}

export async function kpiCalc(
  projectId: string, card: KpiCard, rawFilters: unknown, rawCalc: unknown, rawParams?: unknown,
): Promise<KpiCalcResult> {
  const calc: TableCalc | undefined = sanitizeTableCalc(rawCalc);
  if (!calc) return { ok: false, error: 'No table calculation' };
  const s = await scopeOf(projectId, card, rawParams);
  if (!s) return { ok: false, error: 'Dataset not found' };
  const filters = resolveFilterParams(sanitizeDashboardFilters(rawFilters), s.params).steps;

  let value: number | null;
  let raw: number | null;
  let period: string | undefined;
  if (calc.kind === 'pct_of_total') {
    raw = await figure(s, filters);
    const total = await figure(s, []);
    value = calcSequence('pct_of_total', [raw], { total })[0];
  } else {
    const dateCol = await dateColumnOf(projectId, s.datasetId);
    if (!dateCol) return { ok: true, kind: calc.kind, reason: 'no_date_column' };
    const series = await periodSeries(s, dateCol, filters);
    if (!series || !series.labels.length) return { ok: true, kind: calc.kind, reason: 'no_periods' };
    if (calc.kind === 'yoy' && !series.grain) return { ok: true, kind: calc.kind, reason: 'not_a_date_axis' };
    const grain = series.grain;
    const byLabel = new Map<string, number | null>();
    series.labels.forEach((l, i) => byLabel.set(l, finite(series.values[i])));
    const prior = calc.kind === 'yoy' && grain
      ? series.labels.map((l) => {
        const k = shiftBucketLabel(l, grain);
        return k !== null && byLabel.has(k) ? (byLabel.get(k) as number | null) : null;
      })
      : undefined;
    const out = calcSequence(calc.kind, series.values, { window: calc.window, prior });
    const last = series.labels.length - 1;
    value = out[last];
    raw = finite(series.values[last]);
    period = series.labels[last];
  }

  // The card's own format for anything in the metric's units; the kind's for
  // a share, a rank or an index.
  const inUnits = (v: number | null): string =>
    v === null ? '—' : s.metric ? formatMetricValue(v, s.metric.format) : formatValue(v, s.card.format || 'auto');
  const parts = calcParts(calc.kind, value, raw);
  const unitKind = !isPercentKind(calc.kind) && calc.kind !== 'index' && !calc.kind.startsWith('rank');
  const text = unitKind ? (calc.kind === 'diff' && value !== null && value > 0 ? '+' : '') + inUnits(value) : parts.value;
  const what = parts.suffix.trim() || CALC_KIND_NAMES[calc.kind].replace(/^an? /, '');
  const n = isMovingKind(calc.kind) ? ` (${calc.window ?? CALC_WINDOW_DEFAULT})` : '';
  const line = `${what}${n} · ${inUnits(raw)}${period ? ' in ' + period : ''}`;
  return { ok: true, kind: calc.kind, value, raw, text, line, ...(period ? { period } : {}) };
}

export function register(): void {
  ipcMain.handle('tableCalc:kpi', async (_e, { projectId, card, filters, calc, params }: any = {}) => {
    try {
      if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) return { ok: false, error: 'Invalid project' };
      return await kpiCalc(projectId, card && typeof card === 'object' ? card : {}, filters, calc, params);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to calculate' };
    }
  });

  // What the Properties panel needs to disable kinds honestly: is there a date column?
  ipcMain.handle('tableCalc:kpiOptions', async (_e, { projectId, card }: any = {}) => {
    try {
      if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) return { ok: false, error: 'Invalid project' };
      const s = await scopeOf(projectId, card && typeof card === 'object' ? card : {}, undefined);
      if (!s) return { ok: false, error: 'Dataset not found' };
      return { ok: true, dateColumn: await dateColumnOf(projectId, s.datasetId) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to read the dataset' };
    }
  });
}
