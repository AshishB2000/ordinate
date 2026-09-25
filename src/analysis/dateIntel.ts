// DATE INTELLIGENCE — relative periods, resolved against a clock. MAIN PROCESS,
// PURE apart from two pieces of module state (the calendar and the clock) that
// main sets once and every evaluator reads.
//
// A dashboard saved with "Last 30 days" has to mean the last thirty days on the
// day it is OPENED, not on the day it was built. So a relative period is stored
// as its PRESET — `{ preset: 'last_n_days', n: 30 }` — inside a filter step with
// op `period`, and is turned into two dates only at evaluation time, by
// `resolvePeriod` below. Nothing downstream ever stores the dates.
//
// ── What each preset means ──────────────────────────────────────────────────
// "Last N <unit>" is the N COMPLETE units before the current one, so "Last 1
// month" is exactly "Last month" and "Last 30 days" ends yesterday: a partial
// today would make every figure look like a drop. "This <unit>" is the whole
// current unit, which may reach into the future. "…to date" ends today.
//
// Weeks start on the workspace's first day of week (0 = Sunday … 6 = Saturday).
// Quarters and years are FISCAL: they start in the workspace's fiscal-year start
// month (1 = January, which is the calendar year). A fiscal year is named by the
// calendar year it STARTS in here only for arithmetic; nothing prints that name.
//
// ── Which cells a period matches ────────────────────────────────────────────
// A date column is stored as its ORIGINAL text (parse.ts never normalises it),
// so a period filter has to read dates the same way in JS and in SQL or the
// resident path and the fold would keep different rows. `periodDay` accepts
// exactly two shapes, each optionally followed by a time — `YYYY-MM-DD[ T…]`
// and `MM/DD/YYYY[ T…]` (either separator) — and must be a real calendar date.
// `residentCategory.sqlPeriodDate` is its SQL twin, and the two are pinned by a
// differential test. Anything else (`Jan 5, 2023`) matches no period, on both
// paths: a filter that is identical everywhere beats one that is smarter on one
// path only.

import { daysFromCivil, civilFromDays } from './categoryKey';
import type { CivilDate, DateGrain } from './categoryKey';

export type PeriodPreset =
  | 'today' | 'yesterday'
  | 'last_n_days' | 'last_n_weeks' | 'last_n_months' | 'last_n_quarters' | 'last_n_years'
  | 'this_week' | 'last_week'
  | 'this_month' | 'last_month'
  | 'this_quarter' | 'last_quarter'
  | 'this_year' | 'last_year'
  | 'ytd' | 'qtd'
  | 'custom';

export const PERIOD_PRESETS: readonly PeriodPreset[] = [
  'today', 'yesterday',
  'last_n_days', 'last_n_weeks', 'last_n_months', 'last_n_quarters', 'last_n_years',
  'this_week', 'last_week', 'this_month', 'last_month',
  'this_quarter', 'last_quarter', 'this_year', 'last_year',
  'ytd', 'qtd', 'custom',
];

/** The presets that read `n`. */
export const N_PRESETS: ReadonlySet<PeriodPreset> = new Set<PeriodPreset>([
  'last_n_days', 'last_n_weeks', 'last_n_months', 'last_n_quarters', 'last_n_years',
]);

/** How a relative period is STORED: the preset, never its dates. */
export interface PeriodSpec {
  preset: PeriodPreset;
  /** For the `last_n_*` presets. 1–3660. */
  n?: number;
  /** For `custom`: inclusive ISO bounds, either may be open. */
  from?: string;
  to?: string;
}

/** A resolved period: inclusive ISO dates. Either end may be open (custom). */
export interface DateRange {
  from?: string;
  to?: string;
}

export interface CalendarPrefs {
  /** 0 = Sunday … 6 = Saturday. */
  weekStart: number;
  /** 1 = January … 12 = December. */
  fiscalYearStart: number;
}

export const DEFAULT_CALENDAR: CalendarPrefs = { weekStart: 1, fiscalYearStart: 1 };

export type CompareMode = 'previous_period' | 'previous_year' | 'custom';
export const COMPARE_MODES: readonly CompareMode[] = ['previous_period', 'previous_year', 'custom'];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_N = 3660;

// ── Civil-date arithmetic ───────────────────────────────────────────────────

export function isoFromDays(day: number): string {
  const c = civilFromDays(day);
  return `${String(c.y).padStart(4, '0')}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
}

/** A strict `YYYY-MM-DD` that is a real date → its epoch day, else null. */
export function daysFromIso(s: unknown): number | null {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const day = daysFromCivil(y, m, d);
  const back = civilFromDays(day);
  return back.y === y && back.m === m && back.d === d ? day : null;
}

function lastDayOfMonth(y: number, m: number): number {
  return civilFromDays(daysFromCivil(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - 1).d;
}

/** Add `k` months to a civil date, clamping the day (Mar 31 − 1 month = Feb 28/29). */
function addMonths(c: CivilDate, k: number): CivilDate {
  const idx = c.y * 12 + (c.m - 1) + k;
  const y = Math.floor(idx / 12);
  const m = idx - y * 12 + 1;
  return { y, m, d: Math.min(c.d, lastDayOfMonth(y, m)) };
}

function monthStart(y: number, m: number): number {
  return daysFromCivil(y, m, 1);
}

// ── The two shapes a period reads ───────────────────────────────────────────

// Shared text with residentCategory.sqlPeriodDate — RE2 and JS agree on every
// construct used here (ASCII \d, a character class, a non-capturing group, $).
export const PERIOD_ISO_RE = '^(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})(?:[T ]|$)';
export const PERIOD_US_RE = '^(\\d{1,2})[-/](\\d{1,2})[-/](\\d{4})(?:[T ]|$)';
const ISO_RX = new RegExp(PERIOD_ISO_RE);
const US_RX = new RegExp(PERIOD_US_RE);

/** A stored date cell → its epoch day, or null. See the header for the shapes. */
export function periodDay(cell: unknown): number | null {
  if (cell == null) return null;
  const s = String(cell);
  const iso = ISO_RX.exec(s);
  const us = iso ? null : US_RX.exec(s);
  if (!iso && !us) return null;
  const c: CivilDate = iso
    ? { y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) }
    : { y: Number(us![3]), m: Number(us![1]), d: Number(us![2]) };
  const day = daysFromCivil(c.y, c.m, c.d);
  const back = civilFromDays(day);
  return back.y === c.y && back.m === c.m && back.d === c.d ? day : null;
}

// ── Sanitising ──────────────────────────────────────────────────────────────

export function sanitizeCalendar(raw: unknown): CalendarPrefs {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ws = Number(o.weekStart);
  const fy = Number(o.fiscalYearStart);
  return {
    weekStart: Number.isInteger(ws) && ws >= 0 && ws <= 6 ? ws : DEFAULT_CALENDAR.weekStart,
    fiscalYearStart: Number.isInteger(fy) && fy >= 1 && fy <= 12 ? fy : DEFAULT_CALENDAR.fiscalYearStart,
  };
}

/** A stored/IPC period → a clean spec, or null. Unknown presets are dropped. */
export function sanitizePeriod(raw: unknown): PeriodSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const preset = o.preset as PeriodPreset;
  if (!(PERIOD_PRESETS as readonly string[]).includes(preset)) return null;
  const out: PeriodSpec = { preset };
  if (N_PRESETS.has(preset)) {
    const n = Math.floor(Number(o.n));
    out.n = Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_N) : 1;
  }
  if (preset === 'custom') {
    if (daysFromIso(o.from) !== null) out.from = o.from as string;
    if (daysFromIso(o.to) !== null) out.to = o.to as string;
    if (!out.from && !out.to) return null;
    if (out.from && out.to && out.from > out.to) [out.from, out.to] = [out.to, out.from];
  }
  return out;
}

// ── Resolution ──────────────────────────────────────────────────────────────

/** The first day of the (fiscal) quarter containing `c`. */
function quarterStart(c: CivilDate, fy: number): CivilDate {
  const offset = (((c.m - fy) % 12) + 12) % 12; // months since the fiscal year began
  return addMonths({ y: c.y, m: c.m, d: 1 }, -(offset % 3));
}

/** The first day of the (fiscal) year containing `c`. */
function yearStart(c: CivilDate, fy: number): CivilDate {
  const offset = (((c.m - fy) % 12) + 12) % 12;
  return addMonths({ y: c.y, m: c.m, d: 1 }, -offset);
}

function spanMonths(startDay: number, months: number, back: number): DateRange {
  const s = civilFromDays(startDay);
  const from = addMonths(s, back * months);
  const end = addMonths(from, months);
  return { from: isoFromDays(daysFromCivil(from.y, from.m, 1)), to: isoFromDays(daysFromCivil(end.y, end.m, 1) - 1) };
}

/**
 * A period → its inclusive dates on the day `today` (ISO), under `cal`.
 *
 * Returns null only for a spec that cannot be read — `sanitizePeriod` never
 * produces one, so a stored period always resolves.
 */
export function resolvePeriod(spec: PeriodSpec, today: string, cal: CalendarPrefs = DEFAULT_CALENDAR): DateRange | null {
  const t = daysFromIso(today);
  if (t === null || !spec) return null;
  const c = civilFromDays(t);
  const n = Math.max(1, Math.min(MAX_N, Math.floor(Number(spec.n) || 1)));
  const iso = isoFromDays;
  const dow = (((t + 4) % 7) + 7) % 7; // 0 = Sunday; 1970-01-01 was a Thursday
  const weekStart = t - ((dow - cal.weekStart + 7) % 7);
  const q0 = quarterStart(c, cal.fiscalYearStart);
  const y0 = yearStart(c, cal.fiscalYearStart);
  const m0 = monthStart(c.y, c.m);
  const qDay = daysFromCivil(q0.y, q0.m, 1);
  const yDay = daysFromCivil(y0.y, y0.m, 1);

  switch (spec.preset) {
    case 'today': return { from: iso(t), to: iso(t) };
    case 'yesterday': return { from: iso(t - 1), to: iso(t - 1) };
    case 'last_n_days': return { from: iso(t - n), to: iso(t - 1) };
    case 'last_n_weeks': return { from: iso(weekStart - 7 * n), to: iso(weekStart - 1) };
    case 'this_week': return { from: iso(weekStart), to: iso(weekStart + 6) };
    case 'last_week': return { from: iso(weekStart - 7), to: iso(weekStart - 1) };
    case 'this_month': return spanMonths(m0, 1, 0);
    case 'last_month': return spanMonths(m0, 1, -1);
    case 'last_n_months': return spanMonths(m0, n, -1);
    case 'this_quarter': return spanMonths(qDay, 3, 0);
    case 'last_quarter': return spanMonths(qDay, 3, -1);
    case 'last_n_quarters': return spanMonths(qDay, 3 * n, -1);
    case 'this_year': return spanMonths(yDay, 12, 0);
    case 'last_year': return spanMonths(yDay, 12, -1);
    case 'last_n_years': return spanMonths(yDay, 12 * n, -1);
    case 'ytd': return { from: iso(yDay), to: iso(t) };
    case 'qtd': return { from: iso(qDay), to: iso(t) };
    case 'custom': return spec.from || spec.to ? { from: spec.from, to: spec.to } : null;
    default: return null;
  }
}

/**
 * The comparison range for a resolved one.
 *
 * `previous_year` moves both ends back twelve months (Feb 29 → Feb 28).
 * `previous_period` is the same-length span immediately before: a range made
 * of whole months moves back by that many MONTHS, so "this quarter" compares
 * with the previous quarter rather than with the previous 92 days; anything
 * else moves back by its length in days. An open-ended range has no length,
 * so it has no previous period (null).
 */
export function shiftRange(r: DateRange, mode: 'previous_period' | 'previous_year'): DateRange | null {
  const f = daysFromIso(r.from);
  const t = daysFromIso(r.to);
  if (mode === 'previous_year') {
    const back = (day: number | null): string | undefined => {
      if (day === null) return undefined;
      const c = addMonths(civilFromDays(day), -12);
      return isoFromDays(daysFromCivil(c.y, c.m, c.d));
    };
    if (f === null && t === null) return null;
    return { from: back(f), to: back(t) };
  }
  if (f === null || t === null) return null;
  const fc = civilFromDays(f);
  const tc = civilFromDays(t);
  if (fc.d === 1 && tc.d === lastDayOfMonth(tc.y, tc.m)) {
    const months = (tc.y - fc.y) * 12 + (tc.m - fc.m) + 1;
    const s = addMonths(fc, -months);
    return { from: isoFromDays(daysFromCivil(s.y, s.m, 1)), to: isoFromDays(f - 1) };
  }
  const len = t - f + 1;
  return { from: isoFromDays(f - len), to: isoFromDays(f - 1) };
}

// ── Words ───────────────────────────────────────────────────────────────────

const UNIT: Record<string, [string, string]> = {
  last_n_days: ['day', 'days'], last_n_weeks: ['week', 'weeks'], last_n_months: ['month', 'months'],
  last_n_quarters: ['quarter', 'quarters'], last_n_years: ['year', 'years'],
};

/** "Last 30 days", "This fiscal year", "Custom range". */
export function describePeriod(spec: PeriodSpec, cal: CalendarPrefs = DEFAULT_CALENDAR): string {
  const fiscal = cal.fiscalYearStart !== 1 ? 'fiscal ' : '';
  const n = Math.max(1, Math.floor(Number(spec.n) || 1));
  switch (spec.preset) {
    case 'today': return 'Today';
    case 'yesterday': return 'Yesterday';
    case 'this_week': return 'This week';
    case 'last_week': return 'Last week';
    case 'this_month': return 'This month';
    case 'last_month': return 'Last month';
    case 'this_quarter': return `This ${fiscal}quarter`;
    case 'last_quarter': return `Last ${fiscal}quarter`;
    case 'this_year': return `This ${fiscal}year`;
    case 'last_year': return `Last ${fiscal}year`;
    case 'ytd': return fiscal ? 'Fiscal year to date' : 'Year to date';
    case 'qtd': return fiscal ? 'Fiscal quarter to date' : 'Quarter to date';
    case 'custom': {
      if (spec.from && spec.to) return `${spec.from} to ${spec.to}`;
      return spec.from ? `From ${spec.from}` : `Until ${spec.to}`;
    }
    default: {
      const u = UNIT[spec.preset];
      if (!u) return 'Custom range';
      const unit = spec.preset === 'last_n_quarters' || spec.preset === 'last_n_years' ? `${fiscal}${u[n === 1 ? 0 : 1]}` : u[n === 1 ? 0 : 1];
      return `Last ${n} ${unit}`;
    }
  }
}

/** A KPI card's `compare` → clean, or null. A custom comparison needs both dates. */
export function sanitizeCompare(raw: unknown): { mode: CompareMode; from?: string; to?: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const mode = o.mode as CompareMode;
  if (!(COMPARE_MODES as readonly string[]).includes(mode)) return null;
  if (mode !== 'custom') return { mode };
  if (daysFromIso(o.from) === null || daysFromIso(o.to) === null) return null;
  const [from, to] = (o.from as string) <= (o.to as string) ? [o.from as string, o.to as string] : [o.to as string, o.from as string];
  return { mode, from, to };
}

export function describeCompare(mode: CompareMode): string {
  if (mode === 'previous_year') return 'vs same period last year';
  if (mode === 'custom') return 'vs custom range';
  return 'vs previous period';
}

// ── The app's clock and calendar ────────────────────────────────────────────
//
// Set by main from config (`formats.weekStart`/`fiscalYearStart`) at startup
// and on every save. The clock is the machine's LOCAL date — a user in Tokyo
// asking for "today" means their today — unless ORDINATE_TODAY pins it, which
// is how the smoke gets a date inside the bundled sample's two years.

let calendar: CalendarPrefs = { ...DEFAULT_CALENDAR };

export function setCalendar(c: unknown): void {
  calendar = sanitizeCalendar(c);
}

export function getCalendar(): CalendarPrefs {
  return { ...calendar };
}

export function todayIso(now: Date = new Date()): string {
  const pinned = process.env.ORDINATE_TODAY;
  if (pinned && daysFromIso(pinned) !== null) return pinned;
  return isoFromDays(daysFromCivil(now.getFullYear(), now.getMonth() + 1, now.getDate()));
}

/** Resolve against the app's clock and calendar — what every evaluator calls. */
export function resolvePeriodNow(spec: PeriodSpec): DateRange | null {
  return resolvePeriod(spec, todayIso(), calendar);
}

// ── Labels on a date axis ───────────────────────────────────────────────────

/**
 * A `categoryKey.dateBucketLabel` → the label of the same bucket a year
 * earlier, so an overlay series can be aligned period by period. Weeks move by
 * 52 weeks (364 days) to stay on their weekday; days move by a calendar year.
 */
export function shiftBucketLabel(label: string, grain: DateGrain): string | null {
  const s = String(label);
  if (grain === 'year') return /^\d{4}$/.test(s) ? String(Number(s) - 1).padStart(4, '0') : null;
  if (grain === 'quarter') {
    const m = /^(\d{4})-Q([1-4])$/.exec(s);
    return m ? `${String(Number(m[1]) - 1).padStart(4, '0')}-Q${m[2]}` : null;
  }
  if (grain === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(s);
    return m ? `${String(Number(m[1]) - 1).padStart(4, '0')}-${m[2]}` : null;
  }
  const day = daysFromIso(s);
  if (day === null) return null;
  if (grain === 'week') return isoFromDays(day - 364);
  const c = addMonths(civilFromDays(day), -12);
  return isoFromDays(daysFromCivil(c.y, c.m, c.d));
}
