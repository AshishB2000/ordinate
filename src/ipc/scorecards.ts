// Scorecards IPC — the record's CRUD, and the two reads that make one worth
// having: `scorecard:compute` (every row's figures for one period) and
// `scorecard:detail` (one metric's history with its target and a forecast, and
// its breakdown by the dataset's top dimension). MAIN PROCESS.
//
// EVERY FIGURE BOTTOMS OUT IN THE METRICS LAYER. A row's value for a period is
// `resolveMetric` under ONE filter — the metric dataset's date column limited to
// that period — so a scorecard's "Revenue, Dec 2024" is the same number a KPI
// card filtered to December shows. A formula metric is resolved per period too,
// never folded from its parts. Nothing is stored: the period picker steps back
// by recomputing.
//
// The ANCHOR is data-relative: the latest date in the rows' metric datasets,
// so a scorecard over last year's data opens on its last period rather than on
// an empty "this month". Every row reads the SAME calendar period.
//
// ponytail: one resolution per row per period (12 for the sparkline, memoised
// per call). A scorecard of dozens of metrics over a large table is seconds; a
// grouped query per metric is the upgrade if that ever shows.

import { ipcMain } from './bus';

import * as scorecards from '../analysis/scorecards';
import * as metrics from '../analysis/metrics';
import type { Metric } from '../analysis/metrics';
import * as datasets from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import { formatMetricValue, describeDefinition } from '../analysis/metricFormat';
import { formatNumber } from '../app/format';
import { getCalendar, todayIso } from '../analysis/dateIntel';
import { periodWindow, rowStatus, periodChange, rollupGroups, STATUS_WORDS } from '../analysis/scorecardModel';
import type { PeriodWindow, RowStatus, Scorecard, ScorecardRow, ScorePeriod, GroupRollup } from '../analysis/scorecardModel';
import { resolveOverlays } from '../analysis/analytics';
import type { ResolvedOverlay } from '../analysis/analytics';
import { forecastSeries } from '../analysis/forecast';
import { readDistinctPage, distinctValuesPageJs } from '../engine/datasetPage';
import * as alertStore from '../analysis/alertStore';
import * as analysis from '../analysis/analysis';
import * as visuals from '../analysis/visuals';
import * as comments from '../app/comments';
import { resolveMetric, resolveMetricSeries } from './metrics';
import { vizDataFor } from './visuals';
import * as reportSpec from '../analysis/reportSpec';
import * as versions from '../app/versions';

export interface ScoreRow {
  metricId: string;
  name: string;
  missing?: boolean;
  /** No date column: the figure is all-time and the row has no history. */
  undated?: boolean;
  value: number | null;
  display: string;
  target: number | null;
  targetDisplay: string;
  targetName?: string;
  attainment: number | null;
  status: RowStatus;
  previous: number | null;
  delta: number | null;
  deltaDisplay: string;
  pct: number | null;
  tone: 'good' | 'bad' | 'flat' | 'neutral';
  spark: Array<number | null>;
  sparkLabels: string[];
  owner?: string;
  group?: string;
  direction?: 'up_good' | 'down_good';
  alert?: { message: string; at: string };
  /** Open comment threads on the surfaces this metric appears on (feature: comments). */
  comments?: number;
  /** "87%" — the attainment as the page prints it; '' with no target. */
  attainmentDisplay: string;
  /** "+4.2%" — the change on the previous period as a percentage; '' when there is none. */
  pctDisplay: string;
}

export interface ScoreResult {
  ok: true;
  id: string;
  name: string;
  period: ScorePeriod;
  window: PeriodWindow & { offset: number };
  anchor: string;
  rows: ScoreRow[];
  groups: Array<GroupRollup & { share: number }>;
  /** How many rows are on track / at risk / off track / without a target. */
  counts: Record<RowStatus, number>;
}

/** "87%": attainment rounded to a whole percent (scorecardPage.ts). */
export function attainmentText(a: number | null): string {
  return a === null ? '' : formatNumber(Math.round(a), { decimals: 0 }) + '%';
}

/** "+4.2%" / "−12%": one decimal under 10%, none above, a real minus (scorecardPage.ts scRow). */
export function pctText(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return '';
  const a = Math.abs(pct);
  return (pct > 0 ? '+' : pct < 0 ? '−' : '') + formatNumber(a, { decimals: a < 10 ? 1 : 0 }) + '%';
}

/** Rows per status, and each group's on-track share for its meter — counted here, never in a page. */
export function scoreTallies(rows: Array<{ group?: string; status: RowStatus }>): { counts: Record<RowStatus, number>; groups: Array<GroupRollup & { share: number }> } {
  const counts: Record<RowStatus, number> = { good: 0, warn: 0, off: 0, none: 0 };
  for (const r of rows) counts[r.status] += 1;
  const groups = rollupGroups(rows).map((g) => ({ ...g, share: g.scored ? Math.round((g.onTrack / g.scored) * 100) : 0 }));
  return { counts, groups };
}

const SPARK = 12;
const HISTORY = 24;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** One call's working state: metrics, date columns, anchors and figures, each read once. */
interface Ctx {
  projectId: string;
  metrics: Map<string, Metric | null>;
  dateCols: Map<string, string | null>;
  memo: Map<string, number | null>;
}

function newCtx(projectId: string): Ctx {
  return { projectId, metrics: new Map(), dateCols: new Map(), memo: new Map() };
}

async function metricOf(ctx: Ctx, id: string): Promise<Metric | null> {
  if (!ctx.metrics.has(id)) ctx.metrics.set(id, await metrics.getMetric(ctx.projectId, id));
  return ctx.metrics.get(id) || null;
}

/** The dataset's first date column — the same choice metric:series makes for a sparkline. */
async function dateColOf(ctx: Ctx, datasetId: string): Promise<string | null> {
  if (!ctx.dateCols.has(datasetId)) {
    const meta = await datasets.getDatasetMeta(ctx.projectId, datasetId);
    const col = meta ? meta.columns.find((c) => c.type === 'date') : undefined;
    ctx.dateCols.set(datasetId, col ? col.name : null);
  }
  return ctx.dateCols.get(datasetId) || null;
}

/** The latest date with data in a date column, through the ordinary chart path (resident first). */
async function latestDate(projectId: string, datasetId: string, column: string): Promise<string | null> {
  const reply = await vizDataFor(projectId, datasetId,
    { category: column, values: [{ column, aggregation: 'count' }], grain: 'day' }, []).catch(() => null);
  if (!reply || !reply.ok) return null;
  const vals = reply.data.series[0] ? reply.data.series[0].values : [];
  for (let i = reply.data.labels.length - 1; i >= 0; i--) {
    if (finite(vals[i]) && (vals[i] as number) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(reply.data.labels[i]))) return String(reply.data.labels[i]);
  }
  return null;
}

function periodFilter(column: string, w: PeriodWindow): FilterStep {
  return { type: 'filter', column, op: 'period', period: { preset: 'custom', from: w.from, to: w.to } } as FilterStep;
}

/** A metric's figure over one window (or all-time when its dataset has no date column). */
async function figure(ctx: Ctx, metricId: string, w: PeriodWindow | null): Promise<number | null> {
  const m = await metricOf(ctx, metricId);
  if (!m) return null;
  const col = await dateColOf(ctx, m.datasetId);
  const key = `${metricId}|${col && w ? w.from + '|' + w.to : 'all'}`;
  if (ctx.memo.has(key)) return ctx.memo.get(key) as number | null;
  const r = await resolveMetric(ctx.projectId, metricId, { filters: col && w ? [periodFilter(col, w)] : [] }).catch(() => null);
  const v = r && finite(r.value) ? r.value : null;
  ctx.memo.set(key, v);
  return v;
}

/** The anchor every row reads from: the latest dated row across the metrics' datasets, else today. */
async function anchorFor(ctx: Ctx, rows: ScorecardRow[]): Promise<string> {
  let best = '';
  const seen = new Set<string>();
  for (const r of rows) {
    const m = await metricOf(ctx, r.metricId);
    if (!m || seen.has(m.datasetId)) continue;
    seen.add(m.datasetId);
    const col = await dateColOf(ctx, m.datasetId);
    const d = col ? await latestDate(ctx.projectId, m.datasetId, col) : null;
    if (d && d > best) best = d;
  }
  return best || todayIso();
}

function signedDisplay(delta: number | null, m: Metric): string {
  if (delta === null) return '';
  const body = formatMetricValue(Math.abs(delta), m.format);
  const shown = m.format.kind === 'percent' ? body.replace(/%$/, ' pts') : body;
  return (delta > 0 ? '+' : delta < 0 ? '−' : '') + shown;
}

/** The newest alert event fired by a rule watching this metric. */
function latestAlertFor(file: { rules: any[]; events: any[] } | null, metricId: string): { message: string; at: string } | undefined {
  if (!file) return undefined;
  const ruleIds = new Set(file.rules.filter((r) => r && r.metric && r.metric.metricId === metricId).map((r) => r.id));
  let best: any = null;
  for (const e of file.events) if (ruleIds.has(e.ruleId) && (!best || String(e.at) > String(best.at))) best = e;
  return best ? { message: String(best.message || ''), at: String(best.at || '') } : undefined;
}

/**
 * metricId → OPEN comment threads on the surfaces it appears on: the KPI cards
 * that show it (a thread on a card targets the card id) and the visuals that
 * plot it. A scorecard row has no comment target of its own — the discussion
 * about a number happens where the number is shown, and this counts it there.
 */
async function openCommentCounts(projectId: string, metricIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!metricIds.length) return out;
  const res = await comments.list(projectId).catch(() => null);
  const open = res && res.ok ? res.comments.filter((c) => !c.resolvedAt && !c.deletedAt) : [];
  if (!open.length) return out;
  const surfaces = new Map<string, Set<string>>(); // metricId → 'card:<id>' / 'visual:<id>'
  const add = (m: string | undefined, key: string): void => {
    if (!m || metricIds.indexOf(m) < 0) return;
    if (!surfaces.has(m)) surfaces.set(m, new Set());
    (surfaces.get(m) as Set<string>).add(key);
  };
  for (const a of await analysis.listAnalyses(projectId).catch(() => [])) {
    const rec = await analysis.getAnalysis(projectId, a.id).catch(() => null);
    for (const sheet of rec ? rec.sheets : []) {
      for (const card of sheet.cards || []) add(card.metric && card.metric.metricId, 'card:' + card.id);
    }
  }
  for (const v of await visuals.listVisuals(projectId).catch(() => [])) {
    const rec = await visuals.getVisual(projectId, v.id).catch(() => null);
    for (const m of rec ? rec.encoding.values : []) add(m.metricId, 'visual:' + v.id);
  }
  for (const [m, keys] of surfaces) {
    const n = open.filter((c) => keys.has(c.target.kind + ':' + c.target.id)).length;
    if (n) out.set(m, n);
  }
  return out;
}

/**
 * Every row of a scorecard for the period `offset` steps back from the anchor.
 * EXPORTED for buildFacts (the Assistant reads the same figures the page shows)
 * and for scripts/test-scorecards.ts.
 */
export async function computeScorecard(projectId: string, sc: Scorecard, offset = 0): Promise<ScoreResult> {
  const ctx = newCtx(projectId);
  const cal = getCalendar();
  const anchor = await anchorFor(ctx, sc.rows);
  const off = Math.max(0, Math.floor(offset) || 0);
  const windows: PeriodWindow[] = [];
  for (let k = SPARK - 1; k >= 0; k--) {
    const w = periodWindow(anchor, sc.period, off + k, cal);
    if (w) windows.push(w);
  }
  const current = windows[windows.length - 1] || { from: anchor, to: anchor, label: anchor };
  let alerts: { rules: any[]; events: any[] } | null = null;
  try { alerts = await alertStore.load(projectId); } catch (_) { alerts = null; }
  const talk = await openCommentCounts(projectId, sc.rows.map((r) => r.metricId));

  const rows: ScoreRow[] = [];
  for (const def of sc.rows) {
    const m = await metricOf(ctx, def.metricId);
    if (!m) {
      rows.push({
        metricId: def.metricId, name: 'Missing metric', missing: true, value: null, display: '—', target: null,
        targetDisplay: '', attainment: null, status: 'none', previous: null, delta: null, deltaDisplay: '', pct: null,
        tone: 'flat', spark: [], sparkLabels: [], owner: def.owner, group: def.group, attainmentDisplay: '', pctDisplay: '',
      });
      continue;
    }
    const dated = !!(await dateColOf(ctx, m.datasetId));
    const spark: Array<number | null> = [];
    if (dated) for (const w of windows) spark.push(await figure(ctx, m.id, w));
    const value = dated ? spark[spark.length - 1] ?? null : await figure(ctx, m.id, null);
    const previous = dated && spark.length > 1 ? spark[spark.length - 2] : null;
    let target: number | null = null;
    let targetName: string | undefined;
    if (finite(def.target)) target = def.target;
    else if (def.target && typeof def.target === 'object') {
      const tm = await metricOf(ctx, def.target.metricId);
      target = tm ? await figure(ctx, tm.id, current) : null;
      targetName = tm ? tm.name : 'Missing metric';
    }
    const { status, attainment } = rowStatus(value, target, def.thresholds, m.direction);
    const change = periodChange(value, previous, m.direction);
    const row: ScoreRow = {
      metricId: m.id, name: m.name, value, display: formatMetricValue(value, m.format),
      target, targetDisplay: target === null ? '' : formatMetricValue(target, m.format), attainment, status,
      previous, delta: change.delta, deltaDisplay: signedDisplay(change.delta, m), pct: change.pct, tone: change.tone,
      spark, sparkLabels: dated ? windows.map((w) => w.label) : [],
      attainmentDisplay: attainmentText(attainment), pctDisplay: pctText(change.pct),
    };
    if (!dated) row.undated = true;
    if (targetName) row.targetName = targetName;
    if (def.owner) row.owner = def.owner;
    if (def.group) row.group = def.group;
    if (m.direction) row.direction = m.direction;
    const alert = latestAlertFor(alerts, m.id);
    if (alert) row.alert = alert;
    const threads = talk.get(m.id);
    if (threads) row.comments = threads;
    rows.push(row);
  }
  return {
    ok: true, id: sc.id, name: sc.name, period: sc.period,
    window: { ...current, offset: off }, anchor, rows, ...scoreTallies(rows),
  };
}

/** The dataset's top dimension: its first text column with 2–50 distinct values. */
async function topDimension(projectId: string, datasetId: string): Promise<string | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return null;
  const texts = meta.columns.filter((c) => c.type === 'text').slice(0, 12);
  const src = await datasets.residentSource(projectId, datasetId).catch(() => null);
  let ds: Awaited<ReturnType<typeof datasets.getDataset>> | undefined;
  for (const c of texts) {
    let values: string[] | null = null;
    if (src) { const r = await readDistinctPage(src, c.name, { limit: 51 }); values = r ? r.values : null; }
    if (values === null) {
      if (ds === undefined) ds = await datasets.getDataset(projectId, datasetId);
      values = ds ? distinctValuesPageJs(ds.columns, ds.rows, c.name, { limit: 51, search: '' }).values : [];
    }
    if (values.length >= 2 && values.length <= 50) return c.name;
  }
  return null;
}

/**
 * One metric's page: 24 periods of history ending at the chosen one, drawn with
 * the row's target and a forecast as Analytics overlays (analysis/analytics —
 * the SAME resolved shape the builder's charts carry), and the chosen period
 * broken out by the dataset's top dimension.
 */
export async function scorecardDetail(projectId: string, sc: Scorecard, metricId: string, offset = 0): Promise<any> {
  const ctx = newCtx(projectId);
  const m = await metricOf(ctx, metricId);
  if (!m) return { ok: false, error: 'Metric not found' };
  const def = sc.rows.find((r) => r.metricId === metricId);
  const cal = getCalendar();
  const anchor = await anchorFor(ctx, sc.rows);
  const off = Math.max(0, Math.floor(offset) || 0);
  const col = await dateColOf(ctx, m.datasetId);
  const windows: PeriodWindow[] = [];
  if (col) for (let k = HISTORY - 1; k >= 0; k--) { const w = periodWindow(anchor, sc.period, off + k, cal); if (w) windows.push(w); }
  const current = windows[windows.length - 1] || null;
  const values: Array<number | null> = [];
  for (const w of windows) values.push(await figure(ctx, m.id, w));

  let target: number | null = null;
  if (def && finite(def.target)) target = def.target;
  else if (def && def.target && typeof def.target === 'object') target = await figure(ctx, def.target.metricId, current);

  const data: { labels: string[]; series: Array<{ name: string; values: Array<number | null> }>; analytics: ResolvedOverlay[] } =
    { labels: windows.map((w) => w.label), series: [{ name: m.name, values }], analytics: [] };
  if (target !== null) {
    data.analytics.push(...resolveOverlays(data, [{ id: 'target', kind: 'target', value: { type: 'constant', value: target } }],
      { category: { kind: 'date', grain: 'month' } }));
  }
  if (values.filter(finite).length >= 3) {
    let fc = forecastSeries(values, { method: 'holt_winters', horizon: 3, season: 'auto' });
    if ('error' in fc) fc = forecastSeries(values, { method: 'linear', horizon: 3, season: 0 });
    if (!('error' in fc)) {
      const labels: string[] = [];
      for (let k = 1; k <= fc.values.length; k++) { const w = periodWindow(anchor, sc.period, off - k, cal); labels.push(w ? w.label : `+${k}`); }
      const last = fc.values.length - 1;
      data.analytics.push({
        id: 'forecast', kind: 'forecast', series: 0, label: 'Forecast',
        text: `${formatMetricValue(fc.values[last], m.format)} by ${labels[last]} (80%: ${formatMetricValue(fc.lo[last], m.format)}–${formatMetricValue(fc.hi[last], m.format)})`,
        forecast: { ...fc, labels },
      });
    }
  }

  let breakdown: { dimension: string; labels: string[]; values: Array<number | null>; display: string[] } | null = null;
  const dim = await topDimension(projectId, m.datasetId);
  if (dim) {
    const s = await resolveMetricSeries(projectId, m.id, dim, { filters: col && current ? [periodFilter(col, current)] : [] }).catch(() => null);
    if (s) {
      const order = s.labels.map((_, i) => i).sort((a, b) => (s.values[b] ?? -Infinity) - (s.values[a] ?? -Infinity)).slice(0, 12);
      breakdown = { dimension: dim, labels: order.map((i) => s.labels[i]), values: order.map((i) => s.values[i]), display: order.map((i) => s.display[i]) };
    }
  }
  const value = values.length ? values[values.length - 1] : await figure(ctx, m.id, null);
  const { status, attainment } = rowStatus(value, target, def ? def.thresholds : undefined, m.direction);
  return {
    ok: true,
    metric: { id: m.id, name: m.name, datasetId: m.datasetId, definition: m.definition, definitionText: describeDefinition(m), format: m.format, direction: m.direction },
    window: current ? { ...current, offset: off } : null,
    value, display: formatMetricValue(value, m.format),
    target, targetDisplay: target === null ? '' : formatMetricValue(target, m.format),
    attainment, attainmentDisplay: attainmentText(attainment), status, statusWord: STATUS_WORDS[status],
    series: data, breakdown, dateColumn: col,
  };
}

/**
 * A computed, self-contained snapshot — every figure already formatted — for a
 * page that prints a scorecard without re-reading the stores: a report's
 * scorecard page (the desktop's reportScorecard.ts, through `scorecard:snapshot`).
 * A published site builds its own from computeScorecard (src/publish/scorecardData.ts).
 */
export async function scorecardSnapshot(projectId: string, id: string, offset = 0): Promise<ScoreResult | null> {
  const sc = await scorecards.getScorecard(projectId, id);
  return sc ? computeScorecard(projectId, sc, offset) : null;
}

export function register(): void {
  ipcMain.handle('scorecard:list', async (_e, { projectId }: any = {}) => scorecards.listScorecards(String(projectId || '')));
  ipcMain.handle('scorecard:get', async (_e, { projectId, id }: any = {}) => scorecards.getScorecard(String(projectId || ''), String(id || '')));
  ipcMain.handle('scorecard:create', async (_e, { projectId, name, period, rows, description }: any = {}) => {
    const sc = await scorecards.saveScorecard(String(projectId || ''), { name, period, rows, description });
    return sc ? { ok: true, scorecard: sc } : { ok: false, error: 'Could not create the scorecard.' };
  });
  ipcMain.handle('scorecard:update', async (_e, { projectId, id, patch }: any = {}) => {
    const sc = await scorecards.updateScorecard(String(projectId || ''), String(id || ''), patch || {});
    return sc ? { ok: true, scorecard: sc } : { ok: false, error: 'Scorecard not found.' };
  });
  ipcMain.handle('scorecard:duplicate', async (_e, { projectId, id }: any = {}) => {
    const sc = await scorecards.duplicateScorecard(String(projectId || ''), String(id || ''));
    return sc ? { ok: true, scorecard: sc } : { ok: false, error: 'Scorecard not found.' };
  });
  ipcMain.handle('scorecard:delete', async (_e, { projectId, id }: any = {}) =>
    ({ ok: await scorecards.deleteScorecard(String(projectId || ''), String(id || '')) }));
  ipcMain.handle('scorecard:compute', async (_e, { projectId, id, offset }: any = {}) => {
    try {
      const sc = await scorecards.getScorecard(String(projectId || ''), String(id || ''));
      return sc ? await computeScorecard(sc.projectId, sc, Number(offset) || 0) : { ok: false, error: 'Scorecard not found.' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not compute the scorecard.' };
    }
  });
  ipcMain.handle('scorecard:detail', async (_e, { projectId, id, metricId, offset }: any = {}) => {
    try {
      if (typeof metricId !== 'string' || !UUID_RE.test(metricId)) return { ok: false, error: 'Metric not found' };
      const sc = await scorecards.getScorecard(String(projectId || ''), String(id || ''));
      return sc ? await scorecardDetail(sc.projectId, sc, metricId, Number(offset) || 0) : { ok: false, error: 'Scorecard not found.' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not compute the metric.' };
    }
  });
  ipcMain.handle('scorecard:snapshot', async (_e, { projectId, id, offset }: any = {}) =>
    scorecardSnapshot(String(projectId || ''), String(id || ''), Number(offset) || 0));
  /** Scorecards export THROUGH reports: a report whose page is this scorecard, no dashboard behind it. */
  ipcMain.handle('scorecard:createReport', async (_e, { projectId, id }: any = {}) => {
    const pid = String(projectId || '');
    const sc = await scorecards.getScorecard(pid, String(id || ''));
    if (!sc) return { ok: false, error: 'Scorecard not found.' };
    const report = await reportSpec.saveReport(pid, {
      analysisId: '', scorecardId: sc.id, name: sc.name + ' report', format: 'pdf',
      pages: [{ kind: 'cover', include: true, layout: 'full' }, { kind: 'scorecard', scorecardId: sc.id, include: true, layout: 'full' }],
      cover: { title: sc.name, logo: true }, includeFilters: false,
    });
    if (report) await versions.record(pid, 'report', report);
    return report ? { ok: true, report } : { ok: false, error: 'Could not create the report.' };
  });
}
