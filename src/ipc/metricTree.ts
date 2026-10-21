// METRIC TREE over IPC — "why did this number move", one picture. MAIN PROCESS.
// docs/metric-tree/00-design.md.
//
// `metricTree:compute` answers the whole tree in one call: every metric node's
// current and previous figure through the KPI Compare (periods.compareMetric →
// resolveMetric → computeCardMetric), a split's segments through the chart door
// (./metricTreeSplit), a 12-month sparkline per node (metrics.resolveMetricSeries;
// a Live metric has none), and every contribution, share, residual and the lead
// branch from analysis/metricTreeMath. Every display string is formatted here
// by the metric's own format: the browser places them, it never computes one.
//
// The period: a scope that already carries a date range (a dashboard's filter)
// is used as it is; else `period` picks one on the root dataset's first date
// column — by default the newest CLOSED month in the data, the month the
// Metrics table's sparkline ends on (D9).

import { ipcMain } from './bus';

import * as metrics from '../analysis/metrics';
import type { Metric, MetricFormat } from '../analysis/metrics';
import * as datasets from '../data/datasets';
import * as versions from '../app/versions';
import type { FilterStep } from '../data/transforms';
import type { ParsedColumn } from '../data/parse';
import { sanitizeDashboardFilters } from '../analysis/dashboards';
import { paramValues, resolveFilterParams } from '../analysis/params';
import { describeCompare, sanitizeCompare, daysFromIso, isoFromDays } from '../analysis/dateIntel';
import type { PeriodSpec } from '../analysis/dateIntel';
import { compareScope, scopeRange } from '../analysis/periodScope';
import { rangeLabel, withoutDateBounds } from '../analysis/driverScope';
import { formatMetricValue } from '../analysis/metricFormat';
import { formatPercent } from '../app/format';
import { isLiveDatasetError } from '../data/liveDataset';
import { sanitizeTree, suggestBreakdowns, treeMetricIds } from '../analysis/metricTree';
import type { TreeNode, TreeRelation } from '../analysis/metricTree';
import { contributions, leadIndex, residualOf, shareOf } from '../analysis/metricTreeMath';
import * as msg from '../analysis/metricTreeMessages';
import { compareMetric } from './periods';
import { resolveMetricSeries } from './metrics';
import { liveCodeOf } from './liveRoute';
import { splitSegments, OTHER_KEY, SPLIT_MAX_VALUES } from './metricTreeSplit';
import { computeColumnSummariesResident } from '../engine/statsResident';
import { addTreeCard } from './metricTreeCard';
import { contentTag } from '../app/editConflict';

/** Months on a node's sparkline. */
const SPARK_POINTS = 12;

export type PeriodKey = 'latest_month' | 'latest_quarter' | 'last_month' | 'last_quarter' | 'last_30_days' | 'ytd' | 'custom';

export interface TreeNodeOut {
  key: string;
  kind: 'metric' | 'segment' | 'residual';
  name: string;
  metricId?: string;
  current: number | null;
  previous: number | null;
  change: number | null;
  pct: number | null;
  display: string;
  previousDisplay: string;
  changeDisplay: string;
  pctDisplay: string;
  /** Its contribution to its PARENT's change, in the parent's units. Absent on the root. */
  contribution?: number | null;
  contributionDisplay?: string;
  share?: number | null;
  shareDisplay?: string;
  /** A segment of a ratio metric: mix + rate = contribution. */
  mixDisplay?: string;
  rateDisplay?: string;
  direction?: 'up_good' | 'down_good';
  /** A month without a figure is null — a gap, never a zero. */
  spark: Array<number | null> | null;
  /** How this node breaks down: "Orders × Avg order value", "by region". */
  breakdown?: { kind: TreeRelation | 'split'; text: string };
  children: TreeNodeOut[];
  /** Why this node's parts have no contributions, or why it has no figure. */
  note?: string;
  /** On the branch that explains most of the change (D10). */
  lead?: boolean;
}

export interface TreeReply {
  ok: true;
  root: TreeNodeOut;
  /** The tree as saved (or as previewed), for the editor. */
  tree: TreeNode | null;
  headline: string;
  period: { key: PeriodKey | 'scope'; label: string; from?: string; to?: string };
  prior: { label: string; from?: string; to?: string };
  compareLabel: string;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const sign = (v: number | null | undefined): string => (fin(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') : '');

/** |v| in the metric's units; a percent metric moves in points. */
function amount(v: number, format: MetricFormat): string {
  const text = formatMetricValue(Math.abs(v), format);
  return format.kind === 'percent' ? text.replace(/%$/, ' pts') : text;
}
const signedAmount = (v: number | null | undefined, format: MetricFormat): string => (fin(v) ? sign(v) + amount(v, format) : '—');
const pctText = (p: number | null | undefined): string => (fin(p) ? sign(p) + formatPercent(Math.abs(p) / 100, 1) : '');
/** A share of the parent's change: "73%", or "−44%" for a part that pushed against it. */
const shareText = (p: number | null | undefined): string => (fin(p) ? (p < 0 ? '−' : '') + formatPercent(Math.abs(p) / 100, 0) : '');
const pctOf = (cur: number | null, prev: number | null, format: MetricFormat): number | null =>
  format.kind !== 'percent' && fin(cur) && fin(prev) && prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null;

// ── The period ───────────────────────────────────────────────────────────────

/** A series label's month: `2024-12` (more than 24 days of data) or a day `2024-12-15` (fewer). */
const MONTH_RE = /^\d{4}-\d{2}(-\d{2})?$/;

/** The calendar months [first, last] as ISO dates. */
function monthsRange(first: string, last: string): { from: string; to: string } {
  const y = Number(last.slice(0, 4));
  const m = Number(last.slice(5, 7));
  const end = daysFromIso(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`) as number;
  return { from: `${first}-01`, to: isoFromDays(end - 1) };
}

/** The newest closed month's (or its whole quarter's) dates, from the root's series labels (months, or days when there are few). */
export function latestRange(months: string[], quarter: boolean): { from: string; to: string } | null {
  const closed = months.filter((l) => MONTH_RE.test(l)).map((l) => l.slice(0, 7));
  const last = closed[closed.length - 1];
  if (!last) return null;
  if (!quarter) return monthsRange(last, last);
  let y = Number(last.slice(0, 4));
  let m = Number(last.slice(5, 7));
  // The newest quarter that has closed: its last month at or before `last`.
  m -= m % 3;
  if (m === 0) {
    y -= 1;
    m = 12;
  }
  const end = `${y}-${String(m).padStart(2, '0')}`;
  const start = `${y}-${String(m - 2).padStart(2, '0')}`;
  return monthsRange(start, end);
}

function presetSpec(key: PeriodKey, custom: { from?: string; to?: string }): PeriodSpec | null {
  if (key === 'last_month' || key === 'last_quarter' || key === 'ytd') return { preset: key };
  if (key === 'last_30_days') return { preset: 'last_n_days', n: 30 };
  if (key === 'custom' && daysFromIso(custom.from) !== null && daysFromIso(custom.to) !== null) return { preset: 'custom', from: custom.from, to: custom.to };
  return null;
}

// ── One computation ─────────────────────────────────────────────────────────

interface Ctx {
  projectId: string;
  root: Metric;
  columns: ParsedColumn[];
  dateColumn: string;
  current: FilterStep[];
  previous: FilterStep[];
  /** The scope without its date bounds: what a sparkline runs under. */
  undated: FilterStep[];
  compare: { mode: string; from?: string; to?: string };
  rawParams: unknown;
  byId: Map<string, Metric | null>;
}

async function metricOf(ctx: Ctx, id: string): Promise<Metric | null> {
  if (!ctx.byId.has(id)) ctx.byId.set(id, await metrics.getMetric(ctx.projectId, id));
  return ctx.byId.get(id) ?? null;
}

/** A node's 12 closed months under the scope's other filters, or null (none, or Live). */
async function sparkOf(ctx: Ctx, metricId: string, extra: FilterStep[] = []): Promise<Array<number | null> | null> {
  try {
    const s = await resolveMetricSeries(ctx.projectId, metricId, ctx.dateColumn, { filters: ctx.undated.concat(extra), points: SPARK_POINTS });
    if (!s) return null;
    const pts = s.values.map((v) => (fin(v) ? v : null));
    return pts.filter(fin).length >= 2 ? pts : null;
  } catch (err) {
    if (isLiveDatasetError(err)) return null; // a Live sparkline is one statement per point: not drawn
    throw err;
  }
}

function blank(key: string, name: string, note: string): TreeNodeOut {
  return { key, kind: 'metric', name, current: null, previous: null, change: null, pct: null, display: '—', previousDisplay: '—', changeDisplay: '—', pctDisplay: '', spark: null, children: [], note };
}

/** Give each child its contribution to `parent`'s change, its share, and a residual row when the parts fall short. */
function credit(parent: TreeNodeOut, kids: TreeNodeOut[], contribs: number[], format: MetricFormat): void {
  kids.forEach((k, i) => {
    k.contribution = contribs[i];
    k.contributionDisplay = signedAmount(contribs[i], format);
    k.share = shareOf(contribs[i], parent.change);
    k.shareDisplay = shareText(k.share);
  });
  if (!fin(parent.change)) return;
  const r = residualOf(parent.change, contribs);
  if (r === null) return;
  const share = shareOf(r, parent.change);
  kids.push({
    key: `${parent.key}:residual`, kind: 'residual', name: msg.residual(),
    current: null, previous: null, change: null, pct: null, display: '', previousDisplay: '', changeDisplay: '', pctDisplay: '',
    contribution: r, contributionDisplay: signedAmount(r, format), share, shareDisplay: shareText(share),
    spark: null, children: [],
  });
}

async function metricNode(ctx: Ctx, spec: TreeNode, path: string): Promise<TreeNodeOut> {
  const key = path ? `${path}/${spec.id}` : spec.id;
  const m = await metricOf(ctx, spec.metricId);
  if (!m) return blank(key, '—', msg.partGone());
  if (m.datasetId !== ctx.root.datasetId) return { ...blank(key, m.name, msg.otherDataset(m.name)), metricId: m.id };
  const [r, spark] = await Promise.all([
    compareMetric(ctx.projectId, { metricId: m.id }, ctx.current, ctx.compare, ctx.rawParams),
    sparkOf(ctx, m.id),
  ]);
  const cur = fin(r.value) ? r.value : null;
  const prev = fin(r.previous) ? r.previous : null;
  const change = cur !== null && prev !== null ? cur - prev : null;
  const pct = pctOf(cur, prev, m.format);
  const node: TreeNodeOut = {
    key, kind: 'metric', name: m.name, metricId: m.id,
    current: cur, previous: prev, change, pct,
    display: r.display ?? formatMetricValue(cur, m.format),
    previousDisplay: r.previousDisplay ?? formatMetricValue(prev, m.format),
    changeDisplay: signedAmount(change, m.format), pctDisplay: pctText(pct),
    spark, children: [],
    ...(m.direction ? { direction: m.direction } : {}),
  };
  if (!r.ok) node.note = r.error;

  if (spec.relation && spec.children?.length) {
    const kids = await Promise.all(spec.children.map((c) => metricNode(ctx, c, key)));
    const names = kids.map((k, i) => (i === 0 ? '' : spec.relation === 'product' ? ' × ' : spec.relation === 'ratio' ? ' ÷ ' : spec.children?.[i].negative ? ' − ' : ' + ') + k.name);
    node.breakdown = { kind: spec.relation, text: (spec.relation === 'sum' && spec.children[0].negative ? '−' : '') + names.join('') };
    const res = contributions(spec.relation, kids.map((k, i) => ({ previous: k.previous, current: k.current, negative: !!spec.children?.[i].negative })));
    if (res.ok) credit(node, kids, res.contributions, m.format);
    else if (res.why === 'zero_denominator') node.note = msg.zeroDenominator(m.name);
    else {
      // The part with no figure says why itself when it is gone or elsewhere; the parent names it.
      const missing = kids.find((k) => k.current === null || k.previous === null);
      node.note = missing && missing.metricId ? msg.partMissing(missing.name) : msg.partGone();
    }
    node.children = kids;
  } else if (spec.split) {
    node.breakdown = { kind: 'split', text: msg.splitBy(spec.split) };
    const params = paramValues(ctx.rawParams);
    const res = await splitSegments(ctx.projectId, m, ctx.columns, spec.split, { current: ctx.current, previous: ctx.previous }, params);
    if (!res.ok) {
      node.note = res.error;
    } else {
      const kids = await Promise.all(res.segments.map(async (s): Promise<TreeNodeOut> => {
        const segChange = fin(s.current) && fin(s.previous) ? s.current - s.previous : null;
        const segPct = pctOf(s.current, s.previous, m.format);
        // The blank segment is every empty cell — null, '' or whitespace — as its figures were.
        const filter = (s.key === '' ? { type: 'filter', column: spec.split, op: 'is_empty' } : { type: 'filter', column: spec.split, op: '=', value: s.key }) as FilterStep;
        return {
          key: `${key}:${s.key === OTHER_KEY ? 'other' : JSON.stringify(s.key)}`, kind: 'segment', name: s.label,
          current: s.current, previous: s.previous, change: segChange, pct: segPct,
          display: formatMetricValue(s.current, m.format), previousDisplay: formatMetricValue(s.previous, m.format),
          changeDisplay: signedAmount(segChange, m.format), pctDisplay: pctText(segPct),
          ...(s.mix !== undefined ? { mixDisplay: signedAmount(s.mix, m.format), rateDisplay: signedAmount(s.rate, m.format) } : {}),
          spark: s.rest ? null : await sparkOf(ctx, m.id, [filter]),
          children: [],
          ...(m.direction ? { direction: m.direction } : {}),
        };
      }));
      credit(node, kids, res.segments.map((s) => s.contribution), m.format);
      node.children = kids;
    }
  }
  return node;
}

/** Mark the branch that explains most of the change, root down (D10). */
function markLead(node: TreeNodeOut): void {
  node.lead = true;
  const i = leadIndex(node.children.map((c) => (c.kind === 'residual' ? null : (c.contribution ?? null))), node.change);
  if (i >= 0) markLead(node.children[i]);
}

function headlineOf(root: TreeNodeOut, compareLabel: string, format: MetricFormat): string {
  if (!fin(root.change)) return msg.noFigure(root.name, compareLabel);
  if (root.change === 0) return msg.flat(root.name, compareLabel);
  const change = amount(root.change, format);
  const pct = fin(root.pct) ? formatPercent(Math.abs(root.pct) / 100, 1) : '';
  const head = root.change > 0
    ? (pct ? msg.rose(root.name, change, pct, compareLabel) : msg.roseBy(root.name, change, compareLabel))
    : (pct ? msg.fell(root.name, change, pct, compareLabel) : msg.fellBy(root.name, change, compareLabel));
  const first = root.children.find((c) => c.lead);
  if (!first) return head;
  const deeper = first.children.find((c) => c.lead);
  const tail = first.shareDisplay
    ? (deeper ? msg.leadByLedBy(first.name, first.shareDisplay, deeper.name) : msg.leadBy(first.name, first.shareDisplay))
    : msg.leadOnly(first.name);
  return `${head} ${tail}`;
}

export interface ComputeInput {
  filters?: unknown;
  period?: { key?: unknown; from?: unknown; to?: unknown };
  compare?: unknown;
  params?: unknown;
  /** An unsaved tree to preview (the editor): sanitized exactly as a save would. */
  tree?: unknown;
}

/** `tag`: the stored tag of the tree this answer was computed from — the tree editor's base (src/app/editConflict.ts). */
export type ComputeReply = (TreeReply | { ok: false; error: string; code?: string; reason?: string }) & { tag?: string };

export async function computeTree(projectId: string, metricId: string, input: ComputeInput = {}): Promise<ComputeReply> {
  // ONE read: the tree on screen and its tag must be the same record's, or a save landing between two reads would let
  // the editor's next save, built on the older tree, pass the compare.
  const t = await metrics.readMetric(projectId, metricId, 'metricTree');
  if (!t) return { ok: false, error: msg.metricGone() };
  return { ...(await computeFor(projectId, t.rec, input)), tag: t.tag };
}

async function computeFor(projectId: string, root: Metric, input: ComputeInput): Promise<ComputeReply> {
  const meta = await datasets.getDatasetMeta(projectId, root.datasetId);
  if (!meta) return { ok: false, error: msg.noDateColumn(root.name), code: 'no_date' };

  const tree = input.tree !== undefined ? sanitizeTree(input.tree, root.id) : (root.tree ?? null);
  const compare = sanitizeCompare(input.compare) ?? { mode: 'previous_period' as const };
  const params = paramValues(input.params);
  let filters = resolveFilterParams(sanitizeDashboardFilters(input.filters), params).steps;
  // The date the scope already ranges over (a dashboard filtered on its ship date), else the first:
  // the period, its comparison and every sparkline run along the same column.
  const dateColumn = (!input.period && scopeRange(filters, meta.columns)?.column) || meta.columns.find((c) => c.type === 'date')?.name;
  if (!dateColumn) return { ok: false, error: msg.noDateColumn(root.name), code: 'no_date' };
  const ctx: Ctx = {
    projectId, root, columns: meta.columns, dateColumn, current: [], previous: [], undated: withoutDateBounds(filters, dateColumn),
    compare, rawParams: input.params, byId: new Map([[root.id, root]]),
  };

  const asked = typeof input.period?.key === 'string' ? (input.period.key as PeriodKey) : null;
  let key: PeriodKey | 'scope' = 'scope';
  if (asked || !scopeRange(filters, meta.columns)) {
    key = asked ?? 'latest_month';
    let spec = presetSpec(key, { from: input.period?.from as string, to: input.period?.to as string });
    if (!spec) {
      const months = key === 'latest_quarter' || key === 'latest_month' ? await sparkMonths(ctx) : null;
      const r = months ? latestRange(months, key === 'latest_quarter') : null;
      // No closed month to read (a Live metric, or no data yet): the calendar's.
      spec = r ? { preset: 'custom', ...r } : { preset: key === 'latest_quarter' ? 'last_quarter' : 'last_month' };
    }
    filters = ctx.undated.concat([{ type: 'filter', column: dateColumn, op: 'period', period: spec } as FilterStep]);
  }
  const moved = compareScope(filters, meta.columns, compare);
  const range = scopeRange(filters, meta.columns);
  if (!moved || !range) return { ok: false, error: msg.noDateColumn(root.name), code: 'no_date' };
  ctx.current = filters;
  ctx.previous = moved.filters;

  const node = await metricNode(ctx, tree ?? { id: root.id, metricId: root.id }, '');
  markLead(node);
  const compareLabel = describeCompare(compare.mode);
  return {
    ok: true,
    root: node,
    tree,
    headline: headlineOf(node, compareLabel, root.format),
    period: { key, label: rangeLabel(range.range), ...range.range },
    prior: { label: rangeLabel(moved.prior), ...moved.prior },
    compareLabel,
  };
}

/** The root's closed months (its sparkline's labels), or null for a Live metric. */
async function sparkMonths(ctx: Ctx): Promise<string[] | null> {
  try {
    return (await resolveMetricSeries(ctx.projectId, ctx.root.id, ctx.dateColumn, { filters: ctx.undated, points: SPARK_POINTS }))?.labels ?? null;
  } catch (err) {
    if (isLiveDatasetError(err)) return null;
    throw err;
  }
}

/**
 * The text columns a split may use: 2–50 values when the stored Parquet can
 * say (the chart door folds past 50), every text column when it cannot (Live —
 * the compute then refuses a wide one with its sentence).
 */
async function splitColumns(projectId: string, datasetId: string): Promise<string[]> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  const text = (meta?.columns ?? []).filter((c) => c.type === 'text').map((c) => c.name);
  const src = await datasets.residentSource(projectId, datasetId).catch(() => null);
  const stats = src ? await computeColumnSummariesResident(src) : null;
  if (!stats) return text;
  const distinct = new Map(stats.map((c) => [c.name, c.distinct ?? 0]));
  return text.filter((c) => (distinct.get(c) ?? 0) >= 2 && (distinct.get(c) ?? 0) <= SPLIT_MAX_VALUES);
}

/** Save (or clear, with null) a metric's tree. Every child must be a metric on the root's dataset. `base`: the
 *  metric's tag the editor opened with — stale is ERECORDCHANGED (src/app/editConflict.ts); `tag` is the next base. */
export async function saveTree(projectId: string, id: string, raw: unknown, base?: unknown): Promise<{ ok: true; metric: Metric; tag: string } | { ok: false; error: string }> {
  const before = await metrics.getMetric(projectId, id);
  if (!before) return { ok: false, error: msg.metricGone() };
  const tree = raw === null ? null : sanitizeTree(raw, id);
  if (tree) {
    for (const mid of treeMetricIds(tree)) {
      const m = mid === id ? before : await metrics.getMetric(projectId, mid);
      if (!m) return { ok: false, error: msg.partGone() };
      if (m.datasetId !== before.datasetId) return { ok: false, error: msg.otherDataset(m.name) };
    }
  }
  const m = await metrics.updateMetric(projectId, id, { tree }, base, 'metricTree');
  if (!m) return { ok: false, error: msg.metricGone() };
  await versions.record(projectId, 'metric', m, { before });
  return { ok: true, metric: m, tag: contentTag('metricTree', m) };
}

export function register(): void {
  ipcMain.handle('metricTree:compute', async (_e, { projectId, id, ...input }: any = {}) => { // any: contract-checked
    try {
      return await computeTree(projectId, id, input);
    } catch (err: any) { // any: a figure path's throw
      return { ok: false, error: err?.message || 'Failed to compute the tree', ...liveCodeOf(err) };
    }
  });

  ipcMain.handle('metricTree:save', async (_e, { projectId, id, base, tree }: any = {}) => saveTree(projectId, id, tree, base)); // any: contract-checked
  ipcMain.handle('metricTree:addToDashboard', async (_e, { projectId, id, analysisId, name }: any = {}) => addTreeCard(projectId, id, analysisId, name)); // any: contract-checked

  // The editor's starting points: breakdowns read from formulas, the metrics a part may be, the columns a split may use.
  ipcMain.handle('metricTree:suggest', async (_e, { projectId, id }: any = {}) => { // any: contract-checked
    const self = await metrics.getMetric(projectId, id);
    if (!self) return { ok: false, error: msg.metricGone() };
    const list = (await metrics.listMetrics(projectId)).filter((m) => m.datasetId === self.datasetId);
    const plain = list.map((m) => ({ id: m.id, name: m.name, datasetId: m.datasetId, ...('formula' in m.definition ? { formula: m.definition.formula } : {}) }));
    // Per metric: any node of the tree may be broken down, and each gets its own.
    const suggestions: Record<string, ReturnType<typeof suggestBreakdowns>> = {};
    for (const m of plain) {
      const found = suggestBreakdowns(m, plain);
      if (found.length) suggestions[m.id] = found;
    }
    return {
      ok: true,
      suggestions,
      metrics: list.map((m) => ({ id: m.id, name: m.name })),
      columns: await splitColumns(projectId, self.datasetId),
    };
  });
}
