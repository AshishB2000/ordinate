// The data shapes behind five chart families — waterfall, bullet, calendar
// heatmap, radar and Pareto (the desktop's chartShapes.ts), as their plugins
// read them. DOM-free, and no figure is worked out here: a waterfall's levels,
// a Pareto's order and cumulative share and a calendar's one value per day are
// the SERVER's (src/analysis/chartShapes.ts, the reply's `figures`), only
// indexed and laid out; a radar's per-axis scaling and a bullet's bands are
// drawing geometry (their tooltips show the raw figure).

import type { ChartFigures } from '../../../src/analysis/chartShapes.ts';
import type { ChartTypeSpec } from './typeSpec';
import type { Cx } from './types';

/**
 * The figures in the drawn category order (Format → Sort reorders the categories by `order`, old index per new
 * position): every per-category array permuted the same way, and every label index a waterfall step or a Pareto
 * order holds remapped. Indexing, never a figure; the one place figures follow a sort.
 */
export function sortedFigures(f: ChartFigures, order: number[]): ChartFigures {
  const pick = <T,>(row: T[]): T[] => order.map((i) => row[i]);
  const at = new Map(order.map((was, now) => [was, now]));
  const moved = (i: number): number => (i >= 0 ? at.get(i) ?? -1 : -1);
  return {
    ...f,
    ...(f.sharePct ? { sharePct: f.sharePct.map(pick) } : {}),
    ...(f.funnel ? { funnel: { ofTopPct: f.funnel.ofTopPct.map(pick) } } : {}),
    ...(f.bullet ? { bullet: { ofTargetPct: pick(f.bullet.ofTargetPct) } } : {}),
    ...(f.waterfall ? { waterfall: { ...f.waterfall, steps: f.waterfall.steps.map((x) => ({ ...x, src: moved(x.src) })) } } : {}),
    ...(f.pareto ? { pareto: { ...f.pareto, order: f.pareto.order.map(moved) } } : {}),
  };
}

/** A type that draws the server's figures, without them: it draws nothing rather than work them out. */
export function figuresMissing(spec: ChartTypeSpec, f: ChartFigures): boolean {
  return (spec.isWaterfall && !f.waterfall) || (spec.isPareto && !f.pareto) || (spec.opts.pct === true && !f.sharePct)
    || (spec.isHistogram && !f.histogram) || (spec.isCalendar && !f.calendar);
}

/** One bar of a waterfall. `base` → `base + delta` is the bar; `running` is the level after it. */
export interface WaterfallShape {
  labels: string[];
  base: number[];
  delta: number[];
  kind: Array<'start' | 'up' | 'down' | 'total' | 'end'>;
  running: number[];
  /** Index into the INPUT labels, or -1 for a synthetic start/end bar. */
  src: number[];
  from: number;
  to: number;
}
export interface ParetoShape {
  labels: Cx[];
  values: Array<number | null>;
  cumPct: number[];
  count80: number;
  total: number;
  src: number[];
}
export interface CalendarCell { week: number; weekday: number; date: string; v: number | null }
export interface CalendarShape {
  cells: CalendarCell[];
  weeks: number;
  monthMarks: Array<{ week: number; label: string; month: number; year: number }>;
  min: number;
  max: number;
}
export interface RadarShape {
  axes: string[];
  datasets: Array<{ label: string; norm: Array<number | null>; raw: Array<number | null> }>;
  anyNegative: boolean;
}
export interface BulletRow { label: Cx; value: number | null; target: number | null; bands: [number, number, number] }
export interface BulletShape { rows: BulletRow[]; hasTarget: boolean; max: number }


const num = (v: Cx): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ── Waterfall ─────────────────────────────────────────────────────────────
// The SERVER's steps (src/analysis/chartShapes.ts), as the drawer and its
// plugins read them: a bar from `start` to `end`, its step, and the level after
// it. A step names its category by index, so a month reads as the axis draws it.
export function waterfallFromFigures(f: NonNullable<ChartFigures['waterfall']>, labels: Cx[]): WaterfallShape {
  const steps = f.steps;
  return {
    labels: steps.map((s) => (s.src >= 0 && s.src < labels.length ? String(labels[s.src]) : s.label)),
    base: steps.map((s) => s.start),
    delta: steps.map((s) => s.value),
    kind: steps.map((s) => s.kind),
    running: steps.map((s) => s.end),
    src: steps.map((s) => s.src),
    from: f.from,
    to: f.to,
  };
}

// ── Pareto ────────────────────────────────────────────────────────────────
// The server's order (largest first) and cumulative share; the bars are the
// reply's own values, read in that order.
export function paretoFromFigures(f: NonNullable<ChartFigures['pareto']>, labels: Cx[], values: Cx[]): ParetoShape {
  return { labels: f.order.map((i) => labels[i]), values: f.order.map((i) => num(values[i])), cumPct: f.cumPct, count80: f.count80, total: f.total, src: f.order };
}

// ── Calendar ──────────────────────────────────────────────────────────────
// The server's one value per day (epoch days, UTC; two labels on one day are
// summed there), laid out as week × weekday cells. Weeks start Monday (ISO),
// matching the day and week grains in src/analysis/categoryKey.ts. The week
// index runs on from the first date's Monday and does NOT restart at a new year.
const MS_DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// ponytail: a span past 20 years is refused (null → "couldn't draw"), not
// truncated — a stray 1900-01-01 would otherwise mean 45k cells.
const MAX_SPAN_DAYS = 366 * 20;

const weekdayOf = (day: number): number => (((day + 3) % 7) + 7) % 7; // 0 = Monday; 1970-01-01 was a Thursday
const isoOf = (day: number): string => new Date(day * MS_DAY).toISOString().slice(0, 10);

export function calendarCells(f: NonNullable<ChartFigures['calendar']>): CalendarShape | null {
  const byDay = new Map<number, number | null>(f.days.map((d, i) => [d, f.values[i] ?? null]));
  if (!byDay.size) return null;
  let lo = Infinity, hi = -Infinity;
  for (const d of byDay.keys()) { if (d < lo) lo = d; if (d > hi) hi = d; }
  if (hi - lo > MAX_SPAN_DAYS) return null;

  const monday = lo - weekdayOf(lo);
  const weekOf = (day: number): number => Math.floor((day - monday) / 7);
  const cells: CalendarCell[] = [];
  const monthMarks: CalendarShape['monthMarks'] = [];
  let min = Infinity, max = -Infinity;
  for (let d = lo; d <= hi; d++) {
    const iso = isoOf(d);
    const v = byDay.has(d) ? byDay.get(d)! : null;
    if (v !== null) { if (v < min) min = v; if (v > max) max = v; }
    cells.push({ week: weekOf(d), weekday: weekdayOf(d), date: iso, v });
    if (d === lo || iso.slice(8) === '01') {
      const month = +iso.slice(5, 7) - 1;
      monthMarks.push({ week: weekOf(d), label: MONTHS[month], month, year: +iso.slice(0, 4) });
    }
  }
  if (min === Infinity) { min = 0; max = 0; }
  return { cells, weeks: weekOf(hi) + 1, monthMarks, min, max };
}

// How to wrap the continuous week strip into horizontal BANDS for a box of
// availW × availH px. Two years of days as one strip is a 105-column barcode
// 60px tall; the same weeks in three bands of 35 fill the box with cells
// three times the size. A band is a line break, not a restart: the week index
// stays continuous. More bands only when they buy ≥10% bigger cells.
// `gapRows` is the space between bands (room for month names), in cell rows.
export function calendarBands(weeks: number, availW: number, availH: number, gapRows: number, maxCell = 30):
  { bands: number; perRow: number; rows: number } {
  const shape = (perRow: number) => {
    const bands = Math.ceil(weeks / perRow);
    return { bands, perRow, rows: bands * 7 + (bands - 1) * gapRows };
  };
  let best = shape(Math.max(1, weeks));
  if (!(availW > 0 && availH > 0) || weeks < 1) return best;
  let bestCell = Math.min(availW / best.perRow, availH / best.rows, maxCell);
  for (let k = 2; k <= Math.min(6, weeks); k++) {
    const next = shape(Math.ceil(weeks / k));
    const cell = Math.min(availW / next.perRow, availH / next.rows, maxCell);
    if (cell > bestCell * 1.1) { best = next; bestCell = cell; }
  }
  return best;
}

// ── Radar ─────────────────────────────────────────────────────────────────
// Axes are the MEASURES (at most six) and each category is one polygon (at
// most eight — past that a radar is a scribble). Measures carry different
// units, so each axis is scaled by its own largest magnitude: v / max|v|,
// 0..1 (or -1..1 with a negative), and 0 on an axis whose values are all 0.
// The raw figure rides along for the tooltip — a normalised 0.83 is not a
// number anyone should be shown.
const RADAR_AXES = 6;
const RADAR_ROWS = 8;

export function radarShape(labels: Cx[], series: Cx[]): RadarShape {
  const axes = series.slice(0, RADAR_AXES);
  const rows = labels.slice(0, RADAR_ROWS);
  let anyNegative = false;
  const scale = axes.map((s) => {
    let m = 0;
    rows.forEach((_, i) => {
      const v = num(s.values[i]);
      if (v === null) return;
      if (v < 0) anyNegative = true;
      if (Math.abs(v) > m) m = Math.abs(v);
    });
    return m;
  });
  const datasets = rows.map((l, i) => {
    const raw = axes.map((s) => num(s.values[i]));
    const norm = raw.map((v, j) => (v === null ? null : scale[j] ? v / scale[j] : 0));
    return { label: String(l), norm, raw };
  });
  return { axes: axes.map((s) => String(s.name || '')), datasets, anyNegative };
}

// ── Bullet ────────────────────────────────────────────────────────────────
// One row per category: the value, its target (the SECOND measure when there
// is one, else the fixed `target` — the `bulletTarget` override — else none),
// and three qualitative bands at 60 / 90 / 120% of that target. A row with no
// positive target is banded against the largest |value| on the chart instead,
// and draws no target tick.
export function bulletShape(labels: Cx[], series: Cx[], target?: number | null): BulletShape {
  const vals: Cx[] = (series[0] && series[0].values) || [];
  const tgts: Cx[] | null = series[1] ? series[1].values || [] : null;
  const fixed = num(target);
  let peak = 0;
  const base = labels.map((label, i) => {
    const value = num(vals[i]);
    if (value !== null && Math.abs(value) > peak) peak = Math.abs(value);
    return { label, value, target: tgts ? num(tgts[i]) : fixed };
  });
  let max = 0;
  const rows = base.map((r) => {
    const ref = r.target !== null && r.target > 0 ? r.target : peak;
    const bands: [number, number, number] = [ref * 0.6, ref * 0.9, ref * 1.2];
    max = Math.max(max, bands[2], r.value ?? 0, r.target ?? 0);
    return { label: r.label, value: r.value, target: r.target, bands };
  });
  return { rows, hasTarget: rows.some((r) => r.target !== null), max };
}
