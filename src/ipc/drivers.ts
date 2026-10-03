// KEY DRIVERS over IPC — "Why did this change?". MAIN PROCESS.
//
// One question, three doors (a KPI's Compare, a line-chart point, an alert
// event — see analysis/driverScope), one answer: the change between two periods
// decomposed across every dimension with 2–200 members, ranked by explained
// variance, with the chosen dimension as a waterfall and an app-written caption.
//
// Every figure is app-computed: per-member aggregates come from the stored
// Parquet in place (engine/driversResident) or, when the bridge is down or the
// table is small, from the JS reference (analysis/driversJs) — differential-
// tested against each other. analysis/drivers does the arithmetic. The model is
// never on this path; "Ask the Assistant" hands it these figures through the
// facts ledger (ai/driversFacts) and nothing else.
//
// A big table runs as a JOB (app/jobs.ts), so the Jobs popover shows it and it
// can be cancelled; a small one answers inline.

import { ipcMain } from './bus';
import { randomUUID } from 'crypto';

import * as datasets from '../data/datasets';
import * as metrics from '../analysis/metrics';
import * as visuals from '../analysis/visuals';
import * as jobs from '../app/jobs';
import * as residentQuery from '../engine/residentQuery';
import * as trace from '../engine/residentTrace';
import type { Cell, FilterStep } from '../data/transforms';
import type { ParsedColumn } from '../data/parse';
import type { MetricFormat } from '../analysis/metrics';
import type { MetricAggregation } from '../analysis/metricValue';
import { formatMetricValue } from '../analysis/metricFormat';
import { formatCompact } from '../app/format';
import { sanitizeDashboardFilters } from '../analysis/dashboards';
import { paramValues, resolveFilterParams } from '../analysis/params';
import type { ParamValues } from '../analysis/params';
import { metricShape } from '../analysis/driverShape';
import type { DriverShape } from '../analysis/driverShape';
import {
  MAX_MEMBERS, MIN_MEMBERS, driversCaption, explainDimension, isOffsetting, leadMember, rankDimensions, totalsOf,
} from '../analysis/drivers';
import type { DimensionResult, MemberEffect, Totals } from '../analysis/drivers';
import { memberAggsJs, memberCountsJs } from '../analysis/driversJs';
import type { DriverQuery, MemberTable } from '../analysis/driversJs';
import { memberAggsResident, memberCountsResident } from '../engine/driversResident';
import {
  bucketRange, pathSteps, periodScopes, rangeLabel, sanitizeDriversSpec, withoutDateBounds,
} from '../analysis/driverScope';
import type { DriversSpec, PeriodScopes } from '../analysis/driverScope';
import * as alertStore from '../analysis/alertStore';
import { resolveMetric } from './metrics';
import { computeCardMetric } from './dashboards';
import { dateRangeSpan, duringClause, eventWhen, eventsDuring, periodSpan } from '../analysis/events'; // r8:events
import { projectEvents } from '../analysis/eventStore';
import { isoFromDays } from '../analysis/dateIntel';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Below this many rows the JS reference answers: hydrating a small table costs
 * less than the bridge round trip. The same threshold, for the same measured
 * reason, as the KPI card's own resident path (ipc/dashboards RESIDENT_MIN_ROWS).
 */
const RESIDENT_MIN_ROWS = 1_000;
/** From here a question runs as a visible, cancellable job. */
const JOB_ROWS = 250_000;
/** Members of the chosen dimension sent to the panel's table. */
const MEMBERS_SHOWN = 50;
/** Questions remembered for "Ask the Assistant" (by token). */
const TOKENS_KEPT = 50;

// ── Shapes ───────────────────────────────────────────────────────────────────

export interface MemberView {
  key: string;
  label: string;
  delta: number;
  deltaText: string;
  share: number | null;
  /** |delta| as a % of every member's |delta| — what reads when members offset. */
  moveShare: number;
  mix?: number;
  rate?: number;
  mixText?: string;
  rateText?: string;
  aText: string;
  bText: string;
}

export interface DimensionView {
  column: string;
  explained: number;
  memberCount: number;
  /** The members largely cancelled out (drivers.isOffsetting). */
  offsetting: boolean;
  members: MemberView[];
  waterfall: {
    start: number; end: number; startText: string; endText: string;
    steps: MemberView[];
    other: { delta: number; deltaText: string; count: number };
  };
}

export interface DriversResult {
  ok: true;
  token: string;
  metric: { name: string; kind: 'additive' | 'ratio' | 'none'; direction?: 'up_good' | 'down_good' };
  periods: { a: string; b: string; column: string };
  totals: { a: number | null; b: number | null; delta: number | null; pct: number | null; aText: string; bText: string; deltaText: string };
  /** Why nothing is decomposed, when nothing is. */
  unavailable?: string;
  dimensions: Array<{ column: string; explained: number; memberCount: number; lead: string | null }>;
  selected: DimensionView | null;
  /** "Revenue fell $412K" — the panel's title. */
  headline: string;
  caption: string;
  /** Project events during period A — named in the caption (analysis/events). r8:events */
  events?: Array<{ title: string; kind: string; when: string }>;
  path: Array<{ column: string; value: string; label: string }>;
  /** What "Alert me" pre-fills; null when the metric is not a column rollup. */
  alert: { datasetId: string; column: string; aggregation: string; metricId?: string; label: string; filters: FilterStep[]; periodColumn: string; direction: 'up' | 'down' } | null;
  spec: DriversSpec;
}

export type DriversReply = DriversResult | { ok: false; error: string };

// ── Formatting: main writes every figure's text ─────────────────────────────

interface Fmt {
  value: (v: number | null) => string;
  change: (v: number | null) => string;
}

function fmtFor(format: MetricFormat | null, kind: DriverShape['kind']): Fmt {
  const abs = (v: number): string => (format ? formatMetricValue(Math.abs(v), format) : formatCompact(Math.abs(v)));
  const points = !!format && format.kind === 'percent';
  return {
    value: (v) => (v === null ? '—' : format ? formatMetricValue(v, format) : formatCompact(v)),
    change: (v) => {
      if (v === null || !Number.isFinite(v)) return '—';
      // A change in a PERCENT is in points — the same rule the KPI's Compare uses.
      const body = points && kind !== 'none' ? abs(v).replace(/%$/, ' pts') : abs(v);
      return (v > 0 ? '+' : v < 0 ? '−' : '') + body;
    },
  };
}

function memberView(m: MemberEffect, f: Fmt, ratio: boolean, gross: number): MemberView {
  const v: MemberView = {
    key: m.key, label: m.label, delta: m.delta, deltaText: f.change(m.delta), share: m.share,
    moveShare: gross > 0 ? (Math.abs(m.delta) / gross) * 100 : 0,
    aText: ratio ? (m.a === null ? '—' : f.value(m.a)) : f.value(m.a),
    bText: ratio ? (m.b === null ? '—' : f.value(m.b)) : f.value(m.b),
  };
  if (m.mix !== undefined) { v.mix = m.mix; v.mixText = f.change(m.mix); }
  if (m.rate !== undefined) { v.rate = m.rate; v.rateText = f.change(m.rate); }
  return v;
}

function dimensionView(d: DimensionResult, f: Fmt, ratio: boolean, delta: number): DimensionView {
  const byKey = new Map(d.members.map((m) => [m.key, m]));
  let gross = 0;
  for (const m of d.members) gross += Math.abs(m.delta);
  return {
    column: d.column,
    explained: d.explained,
    memberCount: d.memberCount,
    offsetting: isOffsetting(d.members, delta),
    members: d.members.slice(0, MEMBERS_SHOWN).map((m) => memberView(m, f, ratio, gross)),
    waterfall: {
      start: d.waterfall.start,
      end: d.waterfall.end,
      startText: f.value(d.waterfall.start),
      endText: f.value(d.waterfall.end),
      steps: d.waterfall.steps.map((s) => memberView(byKey.get(s.key) as MemberEffect, f, ratio, gross)),
      other: { delta: d.waterfall.other.delta, deltaText: f.change(d.waterfall.other.delta), count: d.waterfall.other.count },
    },
  };
}

// ── The computation ──────────────────────────────────────────────────────────

interface Source {
  columns: ParsedColumn[];
  rowCount: number;
  resident: residentQuery.ResidentSource | null;
  rows?: { columns: ParsedColumn[]; rows: Cell[][] } | null;
}

async function sourceFor(projectId: string, datasetId: string): Promise<Source | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return null;
  let resident: residentQuery.ResidentSource | null = null;
  try {
    if (meta.resident && meta.rowCount >= RESIDENT_MIN_ROWS && residentQuery.isResident()) {
      resident = await datasets.residentSource(projectId, datasetId);
    }
  } catch (_) {
    resident = null;
  }
  return { columns: meta.columns, rowCount: meta.rowCount, resident };
}

async function hydrated(projectId: string, datasetId: string, src: Source): Promise<{ columns: ParsedColumn[]; rows: Cell[][] } | null> {
  if (src.rows === undefined) {
    const ds = await datasets.getDataset(projectId, datasetId);
    src.rows = ds ? { columns: ds.columns, rows: ds.rows } : null;
  }
  return src.rows;
}

async function counts(projectId: string, datasetId: string, src: Source, q: { a: FilterStep[]; b: FilterStep[] }, cands: string[]): Promise<Map<string, number>> {
  if (src.resident) {
    const fast = await memberCountsResident(src.resident, q, cands);
    if (fast) { trace.record('drivers', 'resident'); return fast; }
    trace.record('drivers', 'failed', 'member counts');
  } else trace.record('drivers', 'skipped');
  const t = await hydrated(projectId, datasetId, src);
  return t ? memberCountsJs(t.columns, t.rows, q, cands) : new Map();
}

async function aggs(projectId: string, datasetId: string, src: Source, q: DriverQuery, dims: string[]): Promise<MemberTable | null> {
  if (src.resident) {
    const fast = await memberAggsResident(src.resident, q, dims);
    if (fast) { trace.record('drivers', 'resident'); return fast; }
    trace.record('drivers', 'failed', `member aggregates, ${dims.length} dims`);
  } else trace.record('drivers', 'skipped');
  const t = await hydrated(projectId, datasetId, src);
  return t ? memberAggsJs(t.columns, t.rows, q, dims) : null;
}

/** Every dimension of one level: candidates → 2–200 members → effects, ranked. */
async function level(
  projectId: string, datasetId: string, src: Source, shape: DriverShape,
  a: FilterStep[], b: FilterStep[], exclude: Set<string>,
): Promise<{ totals: Totals; ranked: DimensionResult[] } | null> {
  if (shape.kind === 'none') return null;
  const opCols = new Set(shape.operands.map((o) => o.column));
  const cands = src.columns.filter((c) => c.type === 'text' && !exclude.has(c.name) && !opCols.has(c.name)).map((c) => c.name);
  const n = await counts(projectId, datasetId, src, { a, b }, cands);
  const dims = cands.filter((c) => { const k = n.get(c) ?? 0; return k >= MIN_MEMBERS && k <= MAX_MEMBERS; });
  const table = await aggs(projectId, datasetId, src, { operands: shape.operands, a, b }, dims);
  if (!table) return null;
  const totals = totalsOf(shape, table.totals.a, table.totals.b);
  const results: DimensionResult[] = [];
  const present = (vals: Array<number | null>): boolean => vals.some((v) => v !== null && v !== 0);
  for (const d of table.dims) {
    // A column that only re-labels the two periods (a month-name field: "Nov"
    // is all before, "Dec" all after) explains nothing — no member is in both.
    if (!d.members.some((m) => present(m.a) && present(m.b))) continue;
    const r = explainDimension(shape, d, totals, table.totals);
    if (r) results.push(r);
  }
  return { totals, ranked: rankDimensions(results, src.columns.map((c) => c.name)) };
}

async function latestScopes(projectId: string, spec: DriversSpec, column: string): Promise<PeriodScopes | { reason: string }> {
  const periods = await alertStore.recentPeriods(projectId, spec.datasetId, column);
  if (!periods) return { reason: `"${column}" has fewer than two periods to compare.` };
  const [prev, now] = periods.keys;
  const path = pathSteps(spec.path);
  const step = (key: string): FilterStep => ({ type: 'filter', column, op: periods.op, value: key } as FilterStep);
  const pretty = (key: string): string => rangeLabel(bucketRange(key, key.length === 7 ? 'month' : 'day')) || key;
  const span = periodSpan(now); // r8:events
  const aRange = span ? { from: isoFromDays(span.from), to: isoFromDays(span.to) } : undefined;
  return { a: spec.filters.concat([step(now)], path), b: spec.filters.concat([step(prev)], path), aLabel: pretty(now), bLabel: pretty(prev), column, aRange };
}

const tokens = new Map<string, { projectId: string; spec: DriversSpec; params: unknown }>();

function remember(projectId: string, spec: DriversSpec, params: unknown): string {
  const token = randomUUID();
  tokens.set(token, { projectId, spec, params });
  while (tokens.size > TOKENS_KEPT) tokens.delete(tokens.keys().next().value as string);
  return token;
}

/** A remembered question, for the Assistant's facts. */
export function recall(projectId: string, token: string): { spec: DriversSpec; params: unknown } | null {
  const t = tokens.get(token);
  return t && t.projectId === projectId ? { spec: t.spec, params: t.params } : null;
}

/**
 * The whole answer for one sanitized question. EXPORTED for the facts builder,
 * the waterfall tile and scripts/test-drivers.ts.
 */
export async function driversFor(projectId: string, spec: DriversSpec, rawParams?: unknown): Promise<DriversReply> {
  // The renderer's payload, or values a caller already resolved (a tile's render).
  const params: ParamValues = rawParams instanceof Map ? (rawParams as ParamValues) : paramValues(rawParams);
  const src = await sourceFor(projectId, spec.datasetId);
  if (!src) return { ok: false, error: 'Dataset not found' };
  const metric = spec.metric.metricId ? await metrics.getMetric(projectId, spec.metric.metricId) : null;
  if (spec.metric.metricId && !metric && !spec.metric.column) return { ok: false, error: 'That metric no longer exists.' };
  if (metric && metric.datasetId !== spec.datasetId) return { ok: false, error: 'That metric lives on another dataset.' };
  const def = metric ? metric.definition : { column: spec.metric.column as string, aggregation: spec.metric.aggregation as MetricAggregation };
  const name = spec.metric.label || (metric ? metric.name : `${spec.metric.aggregation} of ${spec.metric.column}`);
  const shape = metricShape(spec.datasetId, src.columns, def, metric ? metric.filters : [], await metrics.metricsByName(projectId), params, metric?.name);
  const f = fmtFor(metric ? metric.format : null, shape.kind);

  const scopes = spec.compare.mode === 'latest' ? await latestScopes(projectId, spec, spec.compare.column) : periodScopes(spec, src.columns);
  if ('reason' in scopes) return { ok: false, error: scopes.reason };

  const exclude = new Set(spec.path.map((p) => p.column).concat([scopes.column]));
  const top = await level(projectId, spec.datasetId, src, shape, scopes.a, scopes.b, exclude);
  const totals: Totals = top ? top.totals : { a: null, b: null, delta: null };
  const ranked = top ? top.ranked : [];
  const selectedDim = ranked.find((d) => d.column === spec.dimension) || ranked[0] || null;
  const ratio = shape.kind === 'ratio';

  let unavailable: string | undefined;
  if (shape.kind === 'none') unavailable = shape.reason;
  else if (totals.a === null || totals.b === null) unavailable = 'There is no figure in one of the two periods, so there is no change to explain.';
  else if (!ranked.length) unavailable = 'No dimension has between 2 and 200 values in these periods, so there is nothing to break the change down by.';

  // A metric that cannot be split still gets its two figures in the header,
  // from the metrics layer itself — the same numbers the card shows.
  if (shape.kind === 'none') {
    const at = async (filters: FilterStep[]): Promise<number | null> => {
      if (metric) return (await resolveMetric(projectId, metric.id, { filters, params }))?.value ?? null;
      const r = await computeCardMetric(projectId, spec.datasetId, def as { column: string; aggregation: MetricAggregation }, filters, params);
      return r.ok ? r.value : null;
    };
    const a = await at(scopes.a);
    const b = await at(scopes.b);
    totals.a = a;
    totals.b = b;
    totals.delta = a !== null && b !== null ? a - b : null;
  }

  const fullName = name + (spec.path.length ? ' in ' + spec.path.map((p) => p.value || '(blank)').join(' › ') : '');
  const deltaWords = f.change(totals.delta).replace(/^[+−]/, '');
  const headline = totals.delta !== null
    ? driversCaption({ metric: fullName, delta: totals.delta, deltaText: deltaWords, top: null, lead: null }).replace(/\.$/, '')
    : fullName;

  // The caption's second clause: inside the lead member, the next dimension's lead.
  let caption = '';
  if (totals.delta !== null && !unavailable && selectedDim) {
    const lead = leadMember(selectedDim.members, totals.delta);
    let next: { label: string; deltaText: string } | null = null;
    if (lead) {
      const deeper = spec.path.concat([{ column: selectedDim.column, value: lead.key }]);
      const inner = await level(projectId, spec.datasetId, src, shape,
        scopes.a.concat(pathSteps(deeper.slice(-1))), scopes.b.concat(pathSteps(deeper.slice(-1))),
        new Set(deeper.map((p) => p.column).concat([scopes.column])));
      const best = inner && inner.ranked[0];
      const sub = best ? leadMember(best.members, totals.delta) : null;
      if (sub) next = { label: sub.label, deltaText: f.change(sub.delta) };
    }
    caption = driversCaption({
      metric: fullName,
      delta: totals.delta,
      deltaText: deltaWords,
      top: lead ? { label: lead.label, share: lead.share, deltaText: f.change(lead.delta) } : null,
      lead: next,
      offsetting: isOffsetting(selectedDim.members, totals.delta),
    });
  }

  const colRollup = metric && !('formula' in metric.definition) ? metric.definition : (!metric ? def : null);
  const alert = colRollup && 'column' in colRollup && colRollup.column
    ? {
        datasetId: spec.datasetId,
        column: colRollup.column,
        aggregation: colRollup.aggregation,
        ...(metric ? { metricId: metric.id } : {}),
        label: name,
        filters: withoutDateBounds(spec.filters, scopes.column).concat(pathSteps(spec.path)),
        periodColumn: scopes.column,
        direction: (totals.delta !== null && totals.delta > 0 ? 'up' : 'down') as 'up' | 'down',
      }
    : null;

  // A change that landed during a project event says so — dates matched by the app. r8:events
  const during = eventsDuring(await projectEvents(projectId), dateRangeSpan(scopes.aRange), spec.datasetId, scopes.a);
  if (caption && during.length) caption = caption.replace(/\.$/, '') + duringClause(during) + '.';

  const stored: DriversSpec = selectedDim ? { ...spec, dimension: selectedDim.column } : spec;
  const out: DriversResult = {
    ok: true,
    token: remember(projectId, stored, rawParams),
    metric: { name, kind: shape.kind, ...(metric && metric.direction ? { direction: metric.direction } : {}) },
    periods: { a: scopes.aLabel, b: scopes.bLabel, column: scopes.column },
    totals: {
      a: totals.a, b: totals.b, delta: totals.delta,
      pct: totals.delta !== null && totals.b ? (totals.delta / Math.abs(totals.b)) * 100 : null,
      aText: f.value(totals.a), bText: f.value(totals.b), deltaText: f.change(totals.delta),
    },
    dimensions: ranked.map((d) => {
      const lead = totals.delta !== null ? leadMember(d.members, totals.delta) : null;
      return { column: d.column, explained: d.explained, memberCount: d.memberCount, lead: lead ? lead.label : null };
    }),
    selected: selectedDim && !unavailable && totals.delta !== null ? dimensionView(selectedDim, f, ratio, totals.delta) : null,
    headline,
    caption,
    path: spec.path.map((p) => ({ ...p, label: p.value === '' ? '(blank)' : p.value })),
    alert,
    spec: stored,
  };
  if (unavailable) out.unavailable = unavailable;
  if (during.length) out.events = during.map((e) => ({ title: e.title, kind: e.kind, when: eventWhen(e) }));
  return out;
}

/** `driversFor`, as a visible job when the table is big. */
async function runDrivers(projectId: string, spec: DriversSpec, rawParams: unknown): Promise<DriversReply> {
  const meta = await datasets.getDatasetMeta(projectId, spec.datasetId);
  if (!meta || meta.rowCount < JOB_ROWS) return driversFor(projectId, spec, rawParams);
  const job = jobs.submit({
    kind: 'analysis',
    label: 'Explaining a change' + (spec.metric.label ? ' in ' + spec.metric.label : ''),
    projectId,
    datasetId: spec.datasetId,
    cancellable: true,
    silent: true,
    run: async (ctx) => {
      ctx.progress(0.1, `${meta.rowCount.toLocaleString('en-US')} rows`);
      const r = await driversFor(projectId, spec, rawParams);
      ctx.checkCancelled();
      return r;
    },
    resultOf: (r) => ({ message: r.ok ? r.caption || 'Explained' : r.error }),
  });
  try {
    return await job.done;
  } catch (err: any) {
    return { ok: false, error: err?.name === 'JobCancelled' ? 'Cancelled.' : err?.message || 'Could not explain the change.' };
  }
}

/** A request from the renderer → a sanitized spec (filters with params resolved). */
function specFrom(raw: any): { spec: DriversSpec; params: unknown } | null {
  if (!raw || typeof raw !== 'object') return null;
  const params = paramValues(raw.params);
  const filters = resolveFilterParams(sanitizeDashboardFilters(raw.filters), params).steps;
  const spec = sanitizeDriversSpec(raw, filters);
  return spec ? { spec, params: raw.params } : null;
}

/** An alert rule → the question its event raises: the latest two periods. */
async function specFromAlert(projectId: string, ruleId: string): Promise<DriversSpec | null> {
  const file = await alertStore.load(projectId);
  const rule = file.rules.find((r) => r.id === ruleId);
  if (!rule) return null;
  const meta = await datasets.getDatasetMeta(projectId, rule.datasetId);
  if (!meta) return null;
  const column = rule.change?.periodColumn || (meta.columns.find((c) => c.type === 'date') || { name: '' }).name;
  if (!column) return null;
  return {
    datasetId: rule.datasetId,
    metric: {
      column: rule.metric.column, aggregation: rule.metric.aggregation,
      ...(rule.metric.metricId ? { metricId: rule.metric.metricId } : {}),
      label: rule.metric.label || rule.name,
    },
    filters: sanitizeDashboardFilters(rule.metric.filters || []),
    compare: { mode: 'latest', column },
    path: [],
  };
}

// ── The waterfall tile ───────────────────────────────────────────────────────

/** The labels a tile's first and last bars carry — fixed, so its stored totals override always matches. */
export const TILE_START = 'Previous total';
export const TILE_END = 'Current total';

/**
 * A drivers encoding's chart data, for `visual:data` and every consumer of
 * vizDataFor (reports, publish, export): recomputed from the spec each time,
 * under the sheet's filters — never stored.
 */
export async function driversVizData(
  projectId: string, datasetId: string, enc: { drivers?: unknown; category?: string }, filters: FilterStep[], params?: unknown,
): Promise<{ ok: true; data: { labels: string[]; series: Array<{ name: string; values: Array<number | null> }> }; recommendedShape: string; warnings: string[] } | { ok: false; error: string }> {
  const d = enc.drivers && typeof enc.drivers === 'object' ? (enc.drivers as Record<string, unknown>) : null;
  if (!d) return { ok: false, error: 'Not a drivers tile' };
  const spec = sanitizeDriversSpec({ ...d, datasetId, dimension: enc.category }, filters);
  if (!spec) return { ok: false, error: 'This drivers tile is incomplete.' };
  const r = await driversFor(projectId, spec, params);
  if (!r.ok) return { ok: false, error: r.error };
  if (!r.selected) return { ok: false, error: r.unavailable || 'Nothing to explain in these periods.' };
  const w = r.selected.waterfall;
  const labels = [TILE_START, ...w.steps.map((s) => s.label)];
  const values: Array<number | null> = [w.start, ...w.steps.map((s) => s.delta)];
  if (w.other.count > 0) { labels.push(`Other (${w.other.count})`); values.push(w.other.delta); }
  labels.push(TILE_END);
  values.push(w.end);
  return { ok: true, data: { labels, series: [{ name: r.metric.name, values }] }, recommendedShape: 'categorical', warnings: [] };
}

async function addTile(projectId: string, spec: DriversSpec, name: string): Promise<{ ok: true; visual: any } | { ok: false; error: string }> {
  if (!spec.dimension) return { ok: false, error: 'Pick a dimension first.' };
  const m = spec.metric;
  const measure: Record<string, unknown> = { column: m.column || '', aggregation: m.aggregation || 'sum' };
  if (m.metricId) measure.metricId = m.metricId;
  const visual = await visuals.saveVisual(projectId, {
    name,
    datasetId: spec.datasetId,
    chartType: 'waterfall',
    encoding: {
      category: spec.dimension,
      values: [measure],
      drivers: { metric: spec.metric, compare: spec.compare, path: spec.path },
    },
    overrides: { waterfallTotals: [TILE_START, TILE_END] },
    // No filters of its own: a tile follows the sheet it sits on, so moving
    // the dashboard's date control moves the periods it compares.
    filters: [],
  });
  return visual ? { ok: true, visual } : { ok: false, error: 'Could not save the tile.' };
}

export function register(): void {
  ipcMain.handle('drivers:explain', async (_e, { projectId, request }: any = {}) => {
    try {
      if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) return { ok: false, error: 'Invalid project' };
      const got = specFrom(request);
      if (!got) return { ok: false, error: 'Nothing to explain' };
      return await runDrivers(projectId, got.spec, got.params);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not explain the change.' };
    }
  });

  ipcMain.handle('drivers:explainAlert', async (_e, { projectId, ruleId }: any = {}) => {
    try {
      if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) return { ok: false, error: 'Invalid project' };
      const spec = typeof ruleId === 'string' && UUID_RE.test(ruleId) ? await specFromAlert(projectId, ruleId) : null;
      if (!spec) return { ok: false, error: 'That alert has no dated data to compare.' };
      return await runDrivers(projectId, spec, undefined);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not explain the alert.' };
    }
  });

  ipcMain.handle('drivers:addTile', async (_e, { projectId, request, name }: any = {}) => {
    try {
      if (typeof projectId !== 'string' || !UUID_RE.test(projectId)) return { ok: false, error: 'Invalid project' };
      const got = specFrom(request);
      if (!got) return { ok: false, error: 'Nothing to add' };
      const title = typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : 'Why it changed';
      return await addTile(projectId, got.spec, title);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not add the tile.' };
    }
  });
}
