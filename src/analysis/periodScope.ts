// Moving a SCOPE to another period — MAIN PROCESS, PURE.
//
// Two features ask the same question of a filter list: "which dates does this
// cover, and what are the same filters over a different stretch of time?"
//
//   · a KPI card's Compare ("vs same period last year") resolves its metric a
//     second time under the moved scope, and shows the difference;
//   · a line/column chart's Period overlay draws the moved scope's series as a
//     muted second line, aligned bucket by bucket.
//
// Both are SECOND RESOLUTIONS through the ordinary paths — nothing here
// computes a figure, and nothing is stored. This file only rewrites filters.
//
// The date range in scope is read from the filters themselves: a `period` step
// (resolved against today, like every evaluator does), or `>=`/`>`/`<=`/`<`
// bounds holding an ISO date on a DATE column. The first column carrying any of
// them is THE date column; all its bounds intersect into one range. Filters on
// other columns ride along untouched, which is what makes the comparison
// "the same slice, earlier".

import type { FilterStep } from '../data/transforms';
import type { DateGrain } from './categoryKey';
import { daysFromIso, isoFromDays, resolvePeriodNow, shiftRange, todayIso } from './dateIntel';
import type { CompareMode, DateRange } from './dateIntel';

export interface ScopeColumn {
  name: string;
  type: string;
}

export interface MovedScope {
  column: string;
  /** The range the scope covers now. Either end may be open. */
  range: DateRange;
  /** The comparison range. */
  prior: DateRange;
  /** The same filters with the date column's bounds replaced by `prior`. */
  filters: FilterStep[];
}

const BOUND_OPS = new Set(['>=', '>', '<=', '<']);

function isDateBound(s: FilterStep, types: Map<string, string>): boolean {
  return (
    BOUND_OPS.has(s.op) && types.get(s.column) === 'date' && daysFromIso(s.value) !== null
  );
}

/** The date column in scope and the range its bounds intersect to, or null. */
export function scopeRange(filters: FilterStep[], columns: ScopeColumn[]): { column: string; range: DateRange } | null {
  const types = new Map(columns.map((c) => [c.name, c.type]));
  const list = Array.isArray(filters) ? filters : [];
  const first = list.find(
    (s) => s && s.type === 'filter' && types.has(s.column) && (s.op === 'period' || isDateBound(s, types)),
  );
  if (!first) return null;
  const column = first.column;
  let lo: number | null = null;
  let hi: number | null = null;
  const tighten = (from: number | null, to: number | null): void => {
    if (from !== null) lo = lo === null ? from : Math.max(lo, from);
    if (to !== null) hi = hi === null ? to : Math.min(hi, to);
  };
  for (const s of list) {
    if (!s || s.type !== 'filter' || s.column !== column) continue;
    if (s.op === 'period') {
      const r = s.period ? resolvePeriodNow(s.period) : null;
      if (r) tighten(daysFromIso(r.from), daysFromIso(r.to));
    } else if (isDateBound(s, types)) {
      const d = daysFromIso(s.value) as number;
      if (s.op === '>=') tighten(d, null);
      else if (s.op === '>') tighten(d + 1, null);
      else if (s.op === '<=') tighten(null, d);
      else tighten(null, d - 1);
    }
  }
  const range: DateRange = {};
  if (lo !== null) range.from = isoFromDays(lo);
  if (hi !== null) range.to = isoFromDays(hi);
  return { column, range };
}

/** `filters` with every date bound on `column` replaced by one `custom` period. */
export function withRange(filters: FilterStep[], column: string, range: DateRange, types: Map<string, string>): FilterStep[] {
  const out = (Array.isArray(filters) ? filters : []).filter(
    (s) => !(s && s.type === 'filter' && s.column === column && (s.op === 'period' || isDateBound(s, types))),
  );
  const period: FilterStep['period'] = { preset: 'custom' };
  if (range.from) period.from = range.from;
  if (range.to) period.to = range.to;
  out.push({ type: 'filter', column, op: 'period', period });
  return out;
}

/**
 * Like with like. A range still in progress ("this fiscal year" on Oct 15)
 * holds data only up to today, so comparing it with a WHOLE earlier period
 * compares four months with twelve. When today falls inside the range, the
 * comparison stops at the same point: the same date a year earlier, or the
 * same number of days into the previous period (Jul 1–Oct 15 against Jul 1–
 * Oct 15, never against all of last July–June).
 */
function toDate(range: DateRange, prior: DateRange, mode: 'previous_period' | 'previous_year'): DateRange {
  const today = todayIso();
  const t = daysFromIso(today);
  const f = daysFromIso(range.from);
  const e = daysFromIso(range.to);
  const pf = daysFromIso(prior.from);
  if (t === null || f === null || e === null || pf === null || t < f || t >= e) return prior;
  if (mode === 'previous_year') {
    const back = shiftRange({ to: today }, 'previous_year');
    return back && back.to ? { from: prior.from, to: back.to } : prior;
  }
  return { from: prior.from, to: isoFromDays(pf + (t - f)) };
}

/**
 * The scope moved for a KPI's Compare, or null when there is nothing to move
 * from — no date filter in scope (for previous period / last year), or an
 * open-ended range that has no length (previous period only). A `custom`
 * comparison needs no date filter: it names its own range, on the scope's date
 * column or, failing that, the dataset's first date column.
 */
export function compareScope(
  filters: FilterStep[],
  columns: ScopeColumn[],
  compare: { mode: CompareMode; from?: string; to?: string },
): MovedScope | null {
  const types = new Map(columns.map((c) => [c.name, c.type]));
  const found = scopeRange(filters, columns);
  if (compare.mode === 'custom') {
    const column = found ? found.column : (columns.find((c) => c.type === 'date') || { name: '' }).name;
    if (!column || !compare.from || !compare.to) return null;
    const prior = { from: compare.from, to: compare.to };
    return { column, range: found ? found.range : {}, prior, filters: withRange(filters, column, prior, types) };
  }
  if (!found) return null;
  const whole = shiftRange(found.range, compare.mode);
  if (!whole) return null;
  const prior = toDate(found.range, whole, compare.mode);
  return { column: found.column, range: found.range, prior, filters: withRange(filters, found.column, prior, types) };
}

/**
 * The scope a year earlier, for a chart overlay. With no date filter in scope
 * the filters are returned unchanged — the chart already spans every date, and
 * the overlay aligns each bucket with the one twelve months before it.
 */
export function overlayFilters(filters: FilterStep[], columns: ScopeColumn[]): FilterStep[] {
  const found = scopeRange(filters, columns);
  if (!found) return Array.isArray(filters) ? filters.slice() : [];
  const prior = shiftRange(found.range, 'previous_year');
  if (!prior) return filters.slice();
  return withRange(filters, found.column, prior, new Map(columns.map((c) => [c.name, c.type])));
}

const GRAIN_NOUN: Record<DateGrain, string> = {
  day: 'days', week: 'weeks', month: 'months', quarter: 'quarters', year: 'period',
};

/**
 * "Revenue is up 18% vs the same months last year" — over the buckets that
 * have BOTH a current and a prior value, so a half-filled year compares like
 * with like. Null when nothing pairs up or the prior total is zero.
 */
export function overlayCaption(
  measure: string,
  current: (number | null)[],
  prior: (number | null)[],
  grain: DateGrain,
): { caption: string; pct: number } | null {
  let cur = 0;
  let pri = 0;
  let pairs = 0;
  for (let i = 0; i < current.length; i += 1) {
    const a = current[i];
    const b = prior[i];
    if (typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b)) {
      cur += a;
      pri += b;
      pairs += 1;
    }
  }
  if (pairs === 0 || pri === 0) return null;
  const pct = ((cur - pri) / Math.abs(pri)) * 100;
  const name = measure ? measure.charAt(0).toUpperCase() + measure.slice(1) : 'The total';
  const noun = grain === 'year' ? 'the previous year' : `the same ${GRAIN_NOUN[grain]} last year`;
  const r = Math.round(Math.abs(pct));
  if (r === 0) return { caption: `${name} is flat vs ${noun}`, pct };
  return { caption: `${name} is ${pct > 0 ? 'up' : 'down'} ${r}% vs ${noun}`, pct };
}
