// The figures a chart DRAWS beyond its `{labels, series}` — computed ONCE, on
// the server, PURE (docs/chart-figures/00-design.md).
//
// A waterfall's running levels, a Pareto's order and cumulative share, a
// 100%-stacked chart's shares, a histogram's bins, a funnel's "% of top", a
// bullet's "% of target" and a calendar's one value per day used to be worked
// out in the browser (web/src/charts/shapes.ts, format.ts, build.ts), again for
// the caption (analysis/chartFigures.ts), and a third time, differently, by the
// published page. Now every drawer — the app, the caption, `/p/`, an embed —
// reads the `figures` block this file returns, and none of them adds,
// accumulates or rounds a figure.
//
// The reference is the in-app chart as it was: its answers were recorded into
// web/src/charts/__golden__/shapes.json before the math moved here, and
// scripts/test-chartShapes.ts holds this file to them with Object.is.
//
// `withFigures` attaches the block. Every door calls it as the LAST step before
// its reply leaves — after the Live/extract split and after every step that
// changes the series (table calculations, overlays, the Share policy) — so a
// figure is a pure function of the reply's own series and never says more than
// they do.

import type { FigureAsk } from './figureAsk';

export type StepKind = 'start' | 'up' | 'down' | 'total' | 'end';

/** One bar of a waterfall: drawn from `start` to `end`; `value` is its step; `src` its label's index (-1: a bridge end or the closing Total). */
export interface WaterfallStep { label: string; start: number; end: number; value: number; kind: StepKind; src: number }

export interface ChartFigures {
  waterfall?: { from: number; to: number; steps: WaterfallStep[] };
  /** `order`: label indices, largest first. `cumPct`: 0–100 over the positive values, in that order. */
  pareto?: { order: number[]; cumPct: number[]; count80: number; total: number; positives: number };
  /** Per series, per label: the share of the label's total, in percent (0–100), unrounded. */
  sharePct?: number[][];
  /** Per series: equal-width bins over its numbers (`from === to`: every value was the same). */
  histogram?: Array<Array<{ from: number; to: number; count: number }>>;
  /** Per series, per stage: the stage as a percent of the first; null when the first is 0. */
  funnel?: { ofTopPct: Array<Array<number | null>> };
  /** Per row: the value as a percent of its target; null without a value or a non-zero target. */
  bullet?: { ofTargetPct: Array<number | null> };
  /** One value per day (epoch days, UTC): labels that fall on one day are summed. */
  calendar?: { days: number[]; values: Array<number | null> };
}

type Cell = unknown;
interface SeriesLike { name?: string; values?: Cell[]; role?: string }
export interface ChartLike { labels?: Cell[]; series?: SeriesLike[]; figures?: ChartFigures; facets?: { panels?: ChartLike[] } }

const num = (v: Cell): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The series a drawer draws: the empty ones dropped, and a prior-period
 * overlay left out — none of the figure types draws one (web/src/charts/build.ts
 * chartSeries, CHART_OVERLAY_TYPES).
 */
function drawn(data: ChartLike): Array<{ name: string; values: Cell[] }> {
  const series = Array.isArray(data.series) ? data.series : [];
  return series
    .filter((s) => s && Array.isArray(s.values) && s.values.length > 0 && s.role !== 'overlay')
    .map((s) => ({ name: String(s.name || ''), values: s.values as Cell[] }));
}

// ── Waterfall ─────────────────────────────────────────────────────────────
// A category is a TOTAL when the `waterfallTotals` override names it or its
// label reads as one ("Total", "Subtotal", "Sub-total Q1", "Grand total"). A
// total is drawn from 0 at its own value — which resets the running level — or
// at the running level when the cell is empty. Labels are matched as stored (a
// month axis's "2023-01-01", not the "Jan 2023" it is drawn as).
const TOTAL_RE = /^(sub[ -]?|grand )?total\b/i;

function waterfall(labels: Cell[], series: Array<{ name: string; values: Cell[] }>, totals?: string[]): NonNullable<ChartFigures['waterfall']> {
  const named = new Set((Array.isArray(totals) ? totals : []).map(String));
  const isTotal = (l: Cell): boolean => named.has(String(l)) || TOTAL_RE.test(String(l));
  const out = { from: 0, to: 0, steps: [] as WaterfallStep[] };
  // The level after a step: a rise or fall ends where it started plus itself; a total, start or end at itself.
  const push = (label: Cell, start: number, value: number, kind: StepKind, src: number): void => {
    out.steps.push({ label: String(label), start, end: kind === 'up' || kind === 'down' ? start + value : value, value, kind, src });
  };
  const s0: Cell[] = series[0] ? series[0].values : [];

  if (series.length >= 2) {
    // A BRIDGE: series[0] → series[1] (last year → this year), one step per
    // category. A total-labelled category would count its children twice, so
    // it is left out of both ends and of the steps.
    const s1 = series[1].values;
    const keep = labels.map((_, i) => i).filter((i) => !isTotal(labels[i]));
    for (const i of keep) { out.from += num(s0[i]) ?? 0; out.to += num(s1[i]) ?? 0; }
    push(series[0].name || 'Start', 0, out.from, 'start', -1);
    let running = out.from;
    for (const i of keep) {
      const d = (num(s1[i]) ?? 0) - (num(s0[i]) ?? 0);
      push(labels[i], running, d, d >= 0 ? 'up' : 'down', i);
      running += d;
    }
    push(series[1].name || 'End', 0, out.to, 'end', -1);
    return out;
  }

  let running = 0;
  labels.forEach((l, i) => {
    const v = num(s0[i]);
    if (isTotal(l)) {
      running = v ?? running;
      if (i === 0) out.from = running;
      push(l, 0, running, 'total', i);
      return;
    }
    const d = v ?? 0;
    push(l, running, d, d >= 0 ? 'up' : 'down', i);
    running += d;
  });
  if (labels.length && !isTotal(labels[labels.length - 1])) push('Total', 0, running, 'end', -1);
  out.to = running;
  return out;
}

// ── Pareto ────────────────────────────────────────────────────────────────
// Descending by value (stable, nulls last); the cumulative line runs over the
// POSITIVE values only, so a negative category can neither push the line past
// 100% nor drag it backwards. count80 is how many categories it takes for the
// cumulative share to reach 80% — 0 when there is nothing positive to share.
const REACH = 0.8 * (1 - 1e-12); // ponytail: 1e-12 absorbs float drift at an exact 80%

function pareto(labels: Cell[], values: Cell[]): NonNullable<ChartFigures['pareto']> {
  const rows = labels.map((_, i) => ({ v: num(values[i]), i }));
  rows.sort((a, b) => {
    if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : (a.v === null ? 1 : -1);
    return b.v - a.v || a.i - b.i;
  });
  let total = 0;
  let positives = 0;
  for (const r of rows) if (r.v !== null && r.v > 0) { total += r.v; positives += 1; }
  let cum = 0;
  let count80 = 0;
  const cumPct = rows.map((r, k) => {
    if (r.v !== null && r.v > 0) cum += r.v;
    if (!count80 && total > 0 && cum >= total * REACH) count80 = k + 1;
    return total > 0 ? (cum / total) * 100 : 0;
  });
  return { order: rows.map((r) => r.i), cumPct, count80, total, positives };
}

// ── 100%-stacked ──────────────────────────────────────────────────────────
// Each cell's share of its category's total across the series. Unrounded: the
// chart draws these and the formatter rounds what it prints. A category whose
// cells add up to 0 shares nothing (0 each).
function sharePct(labels: Cell[], series: Array<{ values: Cell[] }>): number[][] {
  const totals = labels.map((_, j) => series.reduce((sum, s) => sum + ((s.values[j] as number) || 0), 0));
  return series.map((s) => labels.map((_, j) => (totals[j] ? (Number(s.values[j]) / totals[j]) * 100 : 0)));
}

// ── Histogram ─────────────────────────────────────────────────────────────
// A series' numbers in ~√n equal-width bins (5–12); the largest lands in the last.
function histogram(values: Cell[]): Array<{ from: number; to: number; count: number }> {
  const nums = values.filter((v): v is number => typeof v === 'number');
  if (!nums.length) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const v of nums) { if (v < min) min = v; if (v > max) max = v; }
  if (min === max) return [{ from: min, to: min, count: nums.length }];
  const k = Math.min(12, Math.max(5, Math.ceil(Math.sqrt(nums.length))));
  const width = (max - min) / k;
  const counts: number[] = new Array<number>(k).fill(0);
  for (const v of nums) counts[Math.max(0, Math.min(k - 1, Math.floor((v - min) / width)))] += 1;
  return counts.map((count, i) => ({ from: min + i * width, to: min + (i + 1) * width, count }));
}

// ── Funnel ────────────────────────────────────────────────────────────────
// Each stage's size (its magnitude) as a percent of the first stage's.
function ofTop(values: Cell[]): Array<number | null> {
  const vals = values.map((v) => (typeof v === 'number' ? Math.abs(v) : 0));
  const top = vals[0] || 0;
  return vals.map((v) => (top ? (v / top) * 100 : null));
}

// ── Bullet ────────────────────────────────────────────────────────────────
// A row's target is the SECOND measure when there is one, else the fixed
// `bulletTarget`; its value as a percent of that target, when both exist and
// the target is not 0.
function ofTarget(labels: Cell[], series: Array<{ values: Cell[] }>, fixed?: number): Array<number | null> {
  const vals = series[0] ? series[0].values : [];
  const tgts = series[1] ? series[1].values : null;
  return labels.map((_, i) => {
    const value = num(vals[i]);
    const target = tgts ? num(tgts[i]) : num(fixed);
    return value !== null && target ? (value / target) * 100 : null;
  });
}

// ── Calendar ──────────────────────────────────────────────────────────────
// 'YYYY-MM-DD' or an ISO datetime: the CALENDAR DATE AS WRITTEN is the day (no
// timezone shift), as an epoch day in UTC. Two labels on one day are SUMMED —
// right for sum and count, not avg; the builder forces the day grain for this
// type, so it only bites raw data.
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/;
const MS_DAY = 86400000;

export function epochDay(label: Cell): number | null {
  const m = DAY_RE.exec(String(label == null ? '' : label).trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  // Rejects 2023-02-30 and month 13 instead of letting Date roll them over.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(dt.getTime() / MS_DAY);
}

function calendar(labels: Cell[], values: Cell[]): NonNullable<ChartFigures['calendar']> {
  const byDay = new Map<number, number | null>();
  labels.forEach((l, i) => {
    const day = epochDay(l);
    if (day === null) return;
    const v = num(values[i]);
    const prev = byDay.has(day) ? (byDay.get(day) as number | null) : null;
    byDay.set(day, v === null ? prev : (prev ?? 0) + v);
  });
  return { days: [...byDay.keys()], values: [...byDay.values()] };
}

// ── The block ─────────────────────────────────────────────────────────────

/** The figures `type` draws over `data`, or null for a type that has none (or nothing to draw). */
export function chartShapes(type: string, data: ChartLike, ask: Omit<FigureAsk, 'chartType'> = {}): ChartFigures | null {
  const labels = Array.isArray(data && data.labels) ? (data.labels as Cell[]) : [];
  const series = drawn(data || {});
  if (!series.length) return null;
  switch (type) {
    case 'waterfall': return { waterfall: waterfall(labels, series, ask.waterfallTotals) };
    case 'pareto': return { pareto: pareto(labels, series[0].values) };
    case 'pct_stacked_column':
    case 'pct_stacked_bar': return { sharePct: sharePct(labels, series) };
    case 'histogram': return { histogram: series.map((s) => histogram(s.values)) };
    case 'funnel':
    case 'event_funnel': return { funnel: { ofTopPct: series.map((s) => ofTop(s.values)) } };
    case 'bullet': return { bullet: { ofTargetPct: ofTarget(labels, series, ask.bulletTarget) } };
    case 'calendar': return { calendar: calendar(labels, series[0].values) };
    default: return null;
  }
}

/**
 * `data` with the figures `ask` draws added to any it already carries (a
 * capture suggests several types over one table), on each small-multiple
 * panel too. Unchanged without an ask. The figures come from `data`'s own
 * series, so call it after the last step that changes them.
 */
export function withChartFigures<T>(data: T, ask: FigureAsk | null): T {
  if (!ask || !data || typeof data !== 'object') return data;
  const d = data as ChartLike;
  const figures = chartShapes(ask.chartType, d, ask);
  const panels = d.facets && Array.isArray(d.facets.panels) ? d.facets.panels : null;
  return {
    ...data,
    ...(figures ? { figures: { ...(d.figures || {}), ...figures } } : {}),
    ...(panels ? { facets: { ...d.facets, panels: panels.map((p) => withChartFigures(p, ask)) } } : {}),
  };
}

/** A chart reply with its figures (./figureAsk): the last step of every door. */
export function withFigures<R>(reply: R, ask: FigureAsk | null): R {
  const r = reply as { ok?: boolean; data?: unknown } | null;
  return ask && r && r.ok && r.data ? ({ ...r, data: withChartFigures(r.data, ask) } as R) : reply;
}
