// The two periods a "Why did this change?" compares — MAIN PROCESS, PURE.
//
// A drivers question arrives from one of three places, and each names its two
// periods differently:
//
//   · a KPI card with Compare on  → the card's own filters, and the same filters
//     with the date range moved (periodScope.compareScope — the SAME call the
//     card's delta line makes, so the panel explains exactly that delta);
//   · a point on a line chart     → that point's date bucket against the one
//     before it on the axis, both inside the chart's own filters;
//   · an alert event              → the two most recent periods of the rule's
//     date column (alertStore's own definition, resolved in the IPC layer
//     because it needs the column's values).
//
// Whatever the source, the answer is two FILTER LISTS, A (now) and B (before),
// plus a drill PATH of `column = member` steps applied to both. Nothing here
// reads data or computes a figure.

import type { FilterStep } from '../data/transforms';
import type { ParsedColumn } from '../data/parse';
import type { MetricAggregation } from './metricValue';
import type { DateGrain } from './categoryKey';
import { civilFromDays, daysFromCivil, isDateGrain } from './categoryKey';
import { compareScope } from './periodScope';
import { daysFromIso, describeCompare, isoFromDays, sanitizeCompare } from './dateIntel';
import type { DateRange } from './dateIntel';

export type DriverCompare =
  | { mode: 'previous_period' | 'previous_year' }
  | { mode: 'custom'; from: string; to: string }
  | { mode: 'bucket'; column: string; label: string; prev: string; grain: DateGrain }
  | { mode: 'latest'; column: string };

export interface DriverPathStep {
  column: string;
  value: string;
}

export interface DriverMetricRef {
  metricId?: string;
  column?: string;
  aggregation?: MetricAggregation;
  label?: string;
}

/** A sanitized drivers question. Everything below is untrusted until it passes here. */
export interface DriversSpec {
  datasetId: string;
  metric: DriverMetricRef;
  filters: FilterStep[];
  compare: DriverCompare;
  path: DriverPathStep[];
  /** The dimension to show; absent → the best-ranked one. */
  dimension?: string;
}

export interface PeriodScopes {
  a: FilterStep[];
  b: FilterStep[];
  aLabel: string;
  bLabel: string;
  /** The date column the periods are cut on — what an alert would watch. */
  column: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGGS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max']);
/** A drill deeper than this has run out of dimensions worth reading. */
export const MAX_PATH = 4;
const MAX_TEXT = 500;

const str = (v: unknown, max = MAX_TEXT): string => (typeof v === 'string' ? v.slice(0, max) : '');

export function sanitizeCompareSpec(raw: unknown): DriverCompare | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.mode === 'bucket') {
    const column = str(o.column);
    const label = str(o.label, 40);
    const prev = str(o.prev, 40);
    if (!column || !label || !prev || !isDateGrain(o.grain)) return null;
    if (!bucketRange(label, o.grain) || !bucketRange(prev, o.grain)) return null;
    return { mode: 'bucket', column, label, prev, grain: o.grain };
  }
  if (o.mode === 'latest') {
    const column = str(o.column);
    return column ? { mode: 'latest', column } : null;
  }
  const cmp = sanitizeCompare(raw);
  if (!cmp) return null;
  if (cmp.mode === 'custom') return { mode: 'custom', from: cmp.from as string, to: cmp.to as string };
  return { mode: cmp.mode };
}

export function sanitizeMetricRef(raw: unknown): DriverMetricRef | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const out: DriverMetricRef = {};
  if (typeof o.metricId === 'string' && UUID_RE.test(o.metricId)) out.metricId = o.metricId;
  const column = str(o.column);
  if (column && typeof o.aggregation === 'string' && AGGS.has(o.aggregation)) {
    out.column = column;
    out.aggregation = o.aggregation as MetricAggregation;
  }
  const label = str(o.label, 120).trim();
  if (label) out.label = label;
  return out.metricId || out.column ? out : null;
}

export function sanitizePath(raw: unknown): DriverPathStep[] {
  const out: DriverPathStep[] = [];
  for (const s of Array.isArray(raw) ? raw : []) {
    if (!s || typeof s !== 'object') continue;
    const column = str((s as Record<string, unknown>).column);
    const v = (s as Record<string, unknown>).value;
    if (!column || typeof v !== 'string' || out.some((p) => p.column === column)) continue;
    out.push({ column, value: v.slice(0, MAX_TEXT) });
    if (out.length >= MAX_PATH) break;
  }
  return out;
}

/**
 * Everything except the filters, which the caller sanitizes with the
 * dashboard whitelist (dashboards.sanitizeDashboardFilters) — one sanitizer
 * for one shape.
 */
export function sanitizeDriversSpec(raw: unknown, filters: FilterStep[]): DriversSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const datasetId = typeof o.datasetId === 'string' && UUID_RE.test(o.datasetId) ? o.datasetId : '';
  const metric = sanitizeMetricRef(o.metric);
  const compare = sanitizeCompareSpec(o.compare);
  if (!datasetId || !metric || !compare) return null;
  const spec: DriversSpec = { datasetId, metric, filters, compare, path: sanitizePath(o.path) };
  const dimension = str(o.dimension);
  if (dimension) spec.dimension = dimension;
  return spec;
}

// ── Date buckets ─────────────────────────────────────────────────────────────

/**
 * A chart axis label (categoryKey.dateBucketLabel) → the inclusive dates it
 * covers. Weeks and days are both labelled by their first day; the grain says
 * which.
 */
export function bucketRange(label: string, grain: DateGrain): DateRange | null {
  const s = String(label);
  let first: number | null = null;
  let next: number | null = null;
  if (grain === 'year') {
    if (!/^\d{4}$/.test(s)) return null;
    first = daysFromCivil(Number(s), 1, 1);
    next = daysFromCivil(Number(s) + 1, 1, 1);
  } else if (grain === 'quarter') {
    const m = /^(\d{4})-Q([1-4])$/.exec(s);
    if (!m) return null;
    const y = Number(m[1]);
    const q = Number(m[2]);
    first = daysFromCivil(y, 3 * q - 2, 1);
    next = q === 4 ? daysFromCivil(y + 1, 1, 1) : daysFromCivil(y, 3 * q + 1, 1);
  } else if (grain === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(s);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    first = daysFromCivil(y, mo, 1);
    next = mo === 12 ? daysFromCivil(y + 1, 1, 1) : daysFromCivil(y, mo + 1, 1);
  } else {
    first = daysFromIso(s);
    if (first === null) return null;
    next = first + (grain === 'week' ? 7 : 1);
  }
  return { from: isoFromDays(first), to: isoFromDays(next - 1) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mar 2024", "Q1 2024", "2024", "Mar 3 – Apr 2, 2024" — how a period reads in a header. */
export function rangeLabel(r: DateRange | null | undefined): string {
  if (!r) return '';
  const f = daysFromIso(r.from);
  const t = daysFromIso(r.to);
  const day = (d: number, withYear: boolean): string => {
    const c = civilFromDays(d);
    return `${MONTHS[c.m - 1]} ${c.d}` + (withYear ? `, ${c.y}` : '');
  };
  if (f === null && t === null) return 'All dates';
  if (f === null) return 'Until ' + day(t as number, true);
  if (t === null) return 'Since ' + day(f, true);
  const fc = civilFromDays(f);
  const tc = civilFromDays(t);
  const lastOfMonth = civilFromDays(t + 1).d === 1;
  if (fc.d === 1 && lastOfMonth) {
    const months = (tc.y - fc.y) * 12 + (tc.m - fc.m) + 1;
    if (months === 1) return `${MONTHS[fc.m - 1]} ${fc.y}`;
    if (months === 3 && (fc.m - 1) % 3 === 0) return `Q${(fc.m - 1) / 3 + 1} ${fc.y}`;
    if (months === 12 && fc.m === 1) return String(fc.y);
    return `${MONTHS[fc.m - 1]} – ${MONTHS[tc.m - 1]} ${tc.y}` + (fc.y !== tc.y ? ` (from ${fc.y})` : '');
  }
  if (f === t) return day(f, true);
  return `${day(f, fc.y !== tc.y)} – ${day(t, true)}`;
}

function periodStep(column: string, r: DateRange): FilterStep {
  const period: FilterStep['period'] = { preset: 'custom' };
  if (r.from) period.from = r.from;
  if (r.to) period.to = r.to;
  return { type: 'filter', column, op: 'period', period };
}

/** The drill path as filters: one `=` per step, `is_empty` for the blank member. */
export function pathSteps(path: DriverPathStep[]): FilterStep[] {
  return path.map((p) => (p.value === ''
    ? { type: 'filter', column: p.column, op: 'is_empty' }
    : { type: 'filter', column: p.column, op: '=', value: p.value }) as FilterStep);
}

/**
 * A and B for every mode except `latest`, which needs the date column's values
 * and is resolved by the caller. `reason` is a sentence for the panel.
 */
export function periodScopes(spec: DriversSpec, columns: ParsedColumn[]): PeriodScopes | { reason: string } {
  const path = pathSteps(spec.path);
  const c = spec.compare;
  if (c.mode === 'bucket') {
    const col = columns.find((x) => x.name === c.column);
    if (!col || col.type === 'number') return { reason: `"${c.column}" is not a date column of this dataset.` };
    const ra = bucketRange(c.label, c.grain) as DateRange;
    const rb = bucketRange(c.prev, c.grain) as DateRange;
    // A date column is cut by the bucket's dates; a TEXT period key ("2024-03",
    // a calculated month field) is its own label, so it is matched exactly.
    const cut = (label: string, r: DateRange): FilterStep => (col.type === 'date'
      ? periodStep(c.column, r)
      : { type: 'filter', column: c.column, op: '=', value: label });
    return {
      a: spec.filters.concat([cut(c.label, ra)], path),
      b: spec.filters.concat([cut(c.prev, rb)], path),
      aLabel: rangeLabel(ra),
      bLabel: rangeLabel(rb),
      column: c.column,
    };
  }
  if (c.mode === 'latest') return { reason: 'The latest periods are read from the data.' };
  const moved = compareScope(spec.filters, columns, c);
  if (!moved) {
    return { reason: 'There is no date range in scope to compare — add a date filter or a date control first.' };
  }
  return {
    a: spec.filters.concat(path),
    b: moved.filters.concat(path),
    aLabel: moved.range.from || moved.range.to ? rangeLabel(moved.range) : 'Now',
    bLabel: rangeLabel(moved.prior) || describeCompare(c.mode),
    column: moved.column,
  };
}

/** The scope minus its bounds on the period column — what an alert should watch. */
export function withoutDateBounds(filters: FilterStep[], column: string): FilterStep[] {
  const BOUNDS = new Set(['period', '>=', '>', '<=', '<']);
  return filters.filter((s) => !(s && s.column === column && BOUNDS.has(s.op)));
}

/** What a waterfall TILE stores (visuals.sanitizeEncoding): the question, never its figures. */
export interface DriversEncoding {
  metric: DriverMetricRef;
  compare: DriverCompare;
  path: DriverPathStep[];
}

export function sanitizeDriversEncoding(raw: unknown): DriversEncoding | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const metric = sanitizeMetricRef(o.metric);
  const compare = sanitizeCompareSpec(o.compare);
  return metric && compare ? { metric, compare, path: sanitizePath(o.path) } : null;
}
