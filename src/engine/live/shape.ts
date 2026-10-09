// Warehouse rows → the answer the resident layer returns — PURE.
// docs/live-data/00-plan.md L2.2.
//
// The compiler (./compile.ts) sends bucket IDS and measure PARTS back; this file
// turns them into exactly what `vizData.buildVizData` / `residentQuery`
// produce — `{labels, series}` plus the `CategoryInfo` — and a metric into
// `metricValue.computeMetric`'s number. Three things happen here and nowhere
// else on the live path:
//
//   LABELS are written by `analysis/categoryKey` (and retailCalendar's
//   weekLabel), from the bucket start: `2024-Q1`, `2024-W03`, `1.2K–2.4K`. SQL
//   never formats one, so the two paths cannot disagree about a label.
//
//   AVG is sum ÷ count, divided here. That is what keeps "Other", a retail
//   roll-up and a split exact: their parts add, and a mean of means never happens.
//
//   −0 BECOMES 0. An extract stores `String(cell)`, which writes −0 as '0', so
//   no extract figure is ever −0; a warehouse can return one (a min, a sum of
//   −0 cells). Normalising makes the two agree under `Object.is`.
//
// Rows are read POSITIONALLY against the statement's own column list, so an
// engine that changes an alias's case (Snowflake upper-cases unquoted ones)
// changes nothing here. A reply of the wrong width is refused, not guessed at.

import type { CategoryInfo, CivilDate, DateGrain } from '../../analysis/categoryKey';
import {
  CATEGORY_CAP, DATE_GRAINS, OTHER_NOTE, binLabel, binPlan, chooseGrain, civilFromDays, gregorianBucketLabel,
} from '../../analysis/categoryKey';
import { bucketStartOf, unitOfGrain, weekLabel } from '../../analysis/retailCalendar';
import type { WeekCal } from '../../analysis/retailCalendar';
import type { LiveColumn, LiveIR, LiveMeasure, LiveRefusal } from './liveSpec';
import { columnOf, refuse } from './liveSpec';
import type { CompiledQuery, LiveKey, Part } from './compile';
import { partsOf } from './compile';

/** What a runner hands back: one array per row, positional to `CompiledQuery.columns`. */
export type LiveRows = unknown[][];

export interface LiveSeries {
  name: string;
  values: (number | null)[];
}

/** A chart, in the resident layer's shape. `keys` are the group keys behind `labels`. */
export interface LiveChart {
  data: { labels: string[]; series: LiveSeries[] };
  category: CategoryInfo;
  /** The bucket id (epoch day / bin index) or text behind each label; null = the empty group. */
  keys: (string | number | null)[];
}

type Parts = Record<Part, number | null>;

// ── Reading values ───────────────────────────────────────────────────────────

/** A numeric cell as a JS number. Drivers hand numbers back as numbers, strings or bigints. */
export function toNumber(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

/** −0 → 0; see the header. */
function plusZero(n: number): number {
  return n === 0 ? 0 : n;
}

/** `vizData.numOrNull`: only a finite number reaches a chart. */
function finiteOrNull(n: number | null): number | null {
  return n !== null && Number.isFinite(n) ? plusZero(n) : null;
}

function emptyParts(): Parts {
  return { s: null, c: null, n: null, x: null };
}

/** Folding a part into a running total: counts and sums add, min/max stay min/max. */
function addPart(acc: Parts, p: Part, v: number | null): void {
  if (v === null) return;
  const cur = acc[p];
  if (cur === null) acc[p] = v;
  else if (p === 's' || p === 'c') acc[p] = cur + v;
  else if (p === 'n') acc[p] = v < cur ? v : cur;
  else acc[p] = v > cur ? v : cur;
}

/** One measure's figure from its parts — `transforms.aggregate`'s formula, applied to totals. */
export function measureValue(m: LiveMeasure, parts: Parts): number | null {
  switch (m.aggregation) {
    case 'sum': return parts.s;
    case 'count': return parts.c === null ? 0 : parts.c;
    case 'min': return parts.n;
    case 'max': return parts.x;
    default: return parts.c !== null && parts.c > 0 && parts.s !== null ? parts.s / parts.c : null;
  }
}

/** `vizData.measureLabel`, over a measure already coerced from 'none' to 'sum'. */
export function measureName(m: LiveMeasure): string {
  return m.aggregation === 'count' ? m.column : `${m.aggregation} of ${m.column}`;
}

function columnIndex(query: CompiledQuery): Map<string, number> {
  const idx = new Map<string, number>();
  query.columns.forEach((c, i) => idx.set(c, i));
  return idx;
}

function badWidth(rows: LiveRows, query: CompiledQuery): boolean {
  return !Array.isArray(rows) || rows.some((r) => !Array.isArray(r) || r.length !== query.columns.length);
}

function textOrEmpty(raw: unknown): string {
  return raw == null ? '' : String(raw);
}

// ── One number ───────────────────────────────────────────────────────────────

/**
 * `metricValue.computeMetric`'s number. Unlike a chart value, ±Infinity is kept
 * (a left fold can overflow there too, and `residentQuery.metricNumber` keeps
 * it); NaN is null.
 */
export function shapeMetric(rows: LiveRows, query: CompiledQuery, ir: LiveIR): number | null | LiveRefusal {
  if (badWidth(rows, query) || rows.length !== 1 || ir.measures.length !== 1) return refuse('rowShape');
  const m = ir.measures[0];
  const idx = columnIndex(query);
  const parts = emptyParts();
  for (const p of partsOf(m)) parts[p] = toNumber(rows[0][idx.get(`o_m0${p}`)!]);
  const v = measureValue(m, parts);
  return v === null || Number.isNaN(v) ? null : plusZero(v);
}

// ── The probes ───────────────────────────────────────────────────────────────

/** min/max → the bin geometry, through the SAME `binPlan` the extract calls. */
export function readBinRange(rows: LiveRows, query: CompiledQuery, bins?: number): LiveKey | LiveRefusal {
  if (badWidth(rows, query) || rows.length !== 1) return refuse('rowShape');
  const lo = finiteOrNull(toNumber(rows[0][0]));
  const hi = finiteOrNull(toNumber(rows[0][1]));
  return { kind: 'bins', ...binPlan(lo, hi, bins) };
}

/** Distinct buckets per grain → `chooseGrain`. An unreadable count coarsens past its grain. */
export function readGrain(rows: LiveRows, query: CompiledQuery): DateGrain | LiveRefusal {
  if (badWidth(rows, query) || rows.length !== 1) return refuse('rowShape');
  const counts = {} as Record<DateGrain, number>;
  DATE_GRAINS.forEach((g, i) => { counts[g] = toNumber(rows[0][i]) ?? Infinity; });
  return chooseGrain(counts);
}

/** The MAX(day) row → the latest civil date per column (null: the column holds no date). */
export function readLatest(rows: LiveRows, query: CompiledQuery, names: string[]): Record<string, CivilDate | null> | LiveRefusal {
  if (badWidth(rows, query) || rows.length !== 1 || names.length !== query.columns.length) return refuse('rowShape');
  const out: Record<string, CivilDate | null> = {};
  names.forEach((n, i) => {
    const day = toNumber(rows[0][i]);
    out[n] = day === null || !Number.isFinite(day) ? null : civilFromDays(day);
  });
  return out;
}

// ── The chart ────────────────────────────────────────────────────────────────

interface Group {
  key: unknown;
  /** Per series key (JSON), the measure parts. */
  cells: Map<string, Parts[]>;
}

interface SeriesSlot {
  rank: number;
  name: string;
}

function seriesName(raw: unknown, numeric: boolean): string {
  if (raw == null) return '';
  if (!numeric) return String(raw);
  const n = toNumber(raw);
  return n === null ? '' : String(plusZero(n));
}

function categoryInfo(key: LiveKey, grain: DateGrain | undefined, folded: boolean): CategoryInfo {
  if (key.kind === 'bins') return { kind: 'number', binned: true };
  if (key.kind === 'text') return folded ? { kind: 'text', note: OTHER_NOTE } : { kind: 'text' };
  return { kind: 'date', grain: grain! };
}

/**
 * The chart rows → `{labels, series}` + `CategoryInfo`. A split by a number
 * column names each series by the number's JS spelling, as the extract's
 * `String(cell)` does.
 */
export function shapeChart(
  rows: LiveRows,
  query: CompiledQuery,
  ir: LiveIR,
  key: LiveKey,
  columns: LiveColumn[],
): LiveChart | LiveRefusal {
  if (badWidth(rows, query)) return refuse('rowShape');
  const numericSeries = !!ir.series && columnOf(columns, ir.series)?.type === 'number';
  const idx = columnIndex(query);
  const ms = ir.measures;
  const split = idx.has('o_s');
  const read = (r: unknown[], name: string): unknown => r[idx.get(name)!];

  // Groups in statement order (the category rank), series by their own rank.
  let groups: Group[] = [];
  const byKey = new Map<string, Group>();
  const series = new Map<string, SeriesSlot>();
  let folded = false;
  for (const r of rows) {
    const g = read(r, 'o_g');
    const gk = JSON.stringify(g ?? null);
    let grp = byKey.get(gk);
    if (!grp) {
      grp = { key: g ?? null, cells: new Map() };
      byKey.set(gk, grp);
      groups.push(grp);
    }
    const sRaw = split ? read(r, 'o_s') : null;
    const sk = JSON.stringify(sRaw ?? null);
    if (split && !series.has(sk)) series.set(sk, { rank: toNumber(read(r, 'o_sr')) ?? 0, name: seriesName(sRaw, numericSeries) });
    const parts = ms.map((m, i) => {
      const p = emptyParts();
      for (const pt of partsOf(m)) p[pt] = toNumber(read(r, `o_m${i}${pt}`));
      return p;
    });
    grp.cells.set(sk, parts);
    if (idx.has('o_nc') && (toNumber(read(r, 'o_nc')) ?? 0) > CATEGORY_CAP) folded = true;
  }

  let grain: DateGrain | undefined = key.kind === 'date' ? key.grain : undefined;
  let label: (k: unknown) => string;
  if (key.kind === 'days') {
    const rolled = rollUp(groups, key.weekCal, key.grain);
    groups = rolled.groups;
    grain = rolled.grain;
    label = rolled.label;
  } else if (key.kind === 'date') {
    label = (k) => (k == null ? '' : gregorianBucketLabel(toNumber(k)!, key.grain));
  } else if (key.kind === 'bins') {
    label = (k) => (k == null ? '' : binLabel(toNumber(k)!, key.lo, key.width, key.bins, key.hi));
  } else {
    label = textOrEmpty;
  }

  // A split's top N is cut here (./compile.ts says why); groups are in rank order.
  if (split && ir.top !== undefined && key.kind !== 'days') groups = groups.slice(0, ir.top);

  const labels = groups.map((g) => label(g.key));
  const keys = groups.map((g) => (g.key == null ? null : key.kind === 'text' ? String(g.key) : toNumber(g.key)));
  let out: LiveSeries[];
  if (split) {
    const order = [...series.entries()].sort((a, b) => a[1].rank - b[1].rank);
    out = order.map(([sk, slot]) => ({
      name: slot.name,
      values: groups.map((g) => {
        const cell = g.cells.get(sk);
        return cell ? finiteOrNull(measureValue(ms[0], cell[0])) : null;
      }),
    }));
  } else {
    out = ms.map((m, i) => ({
      name: measureName(m),
      values: groups.map((g) => {
        const cell = g.cells.get('null');
        return cell ? finiteOrNull(measureValue(m, cell[i])) : null;
      }),
    }));
  }
  return { data: { labels, series: out }, category: categoryInfo(key, grain, folded), keys };
}

/**
 * Days → the week calendar's buckets (D: "the warehouse groups by day and our
 * code rolls days up"). Exact because every part re-aggregates: sums and counts
 * add, minima and maxima compose, and an average is divided only afterwards.
 * With no grain asked for, the grain is chosen from the days present — the same
 * distinct-bucket count `vizData.defaultGrain` takes over the same dates.
 */
function rollUp(
  days: Group[],
  wc: WeekCal,
  asked: DateGrain | undefined,
): { groups: Group[]; grain: DateGrain; label: (k: unknown) => string } {
  const present = days.map((g) => toNumber(g.key)).filter((d): d is number => d !== null);
  const bucketOf = (day: number, g: DateGrain): number => (g === 'day' ? day : bucketStartOf(day, unitOfGrain(g)!, wc));
  let grain = asked;
  if (!grain) {
    const counts = {} as Record<DateGrain, number>;
    for (const g of DATE_GRAINS) counts[g] = new Set(present.map((d) => bucketOf(d, g))).size;
    grain = chooseGrain(counts);
  }
  const gr = grain;
  const buckets = new Map<string, Group>();
  for (const day of days) {
    const d = toNumber(day.key);
    const b = d === null ? null : bucketOf(d, gr);
    const bk = JSON.stringify(b);
    let into = buckets.get(bk);
    if (!into) {
      into = { key: b, cells: new Map() };
      buckets.set(bk, into);
    }
    for (const [sk, parts] of day.cells) {
      let acc = into.cells.get(sk);
      if (!acc) {
        acc = parts.map(() => emptyParts());
        into.cells.set(sk, acc);
      }
      parts.forEach((p, i) => {
        for (const pt of ['s', 'c', 'n', 'x'] as Part[]) addPart(acc![i], pt, p[pt]);
      });
    }
  }
  // Time order; the empty bucket last, as the SQL orders a NULL key.
  const groups = [...buckets.values()].sort((a, b) => {
    if (a.key === null || b.key === null) return a.key === null ? (b.key === null ? 0 : 1) : -1;
    return (a.key as number) - (b.key as number);
  });
  const label = (k: unknown): string => {
    if (k == null) return '';
    return gr === 'day' ? gregorianBucketLabel(k as number, 'day') : weekLabel(k as number, unitOfGrain(gr)!, wc);
  };
  return { groups, grain: gr, label };
}
