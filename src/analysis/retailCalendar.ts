// WEEK CALENDARS — the retail 4-4-5 / 4-5-4 / 5-4-4 calendars and the ISO
// week-year. MAIN PROCESS, PURE apart from one piece of module state (the active
// calendar), set by `dateIntel.setCalendar` and read by every bucketing site.
//
// ── The model ───────────────────────────────────────────────────────────────
// A week calendar's year is a run of 52 or 53 WHOLE weeks, so every bucket —
// week, period, quarter, year — is a union of whole weeks and is fixed by the
// day its year starts:
//
//   retail  weeks run Sunday–Saturday and the year ENDS on a Saturday in late
//           January (NRF style), by one of two rules:
//             'nearest'  the Saturday nearest January 31 (the NRF 4-5-4 rule) —
//                        so the year STARTS on the Sunday in Jan 29 … Feb 4;
//             'last'     the last Saturday of January — the Sunday in Jan 26 … Feb 1.
//   iso     ISO 8601: weeks run Monday–Sunday and week 1 is the week holding
//           January 4 — the Monday in Dec 29 … Jan 4.
//
// So a year's first day is "the first <weekday> on or after a fixed date", and
// 52 vs 53 weeks simply falls out of the distance to the next one.
//
// Twelve PERIODS follow the pattern quarter by quarter (4-4-5 = 4, 4 and 5
// weeks); a 53rd week always joins the LAST period (P12, so Q4 has 14 weeks),
// as the NRF calendar does. The ISO calendar has no pattern of its own and uses
// 4-4-5 for its periods and 13-week quarters.
//
// ── Names ───────────────────────────────────────────────────────────────────
// A retail year is named for the calendar year it STARTS in — dateIntel's rule
// for a gregorian fiscal year, and NRF's: fiscal 2023 runs Jan 29 2023 … Feb 3
// 2024 (53 weeks) and prints "FY23". (scorecardModel's pre-existing gregorian
// "FY2025 = Jul 2024 – Jun 2025" names by the END year; a week calendar never
// reaches that code.) Two digits for 1970–2069, four otherwise, so a label
// always reads back to one year. An ISO year is named by its own number, the
// standard way: 2020-W53. Either way a year's name IS its key below.
//
//   retail  FY24 · FY24 Q1 · FY24 P03 · FY24 P03 W2   (W = week of the period)
//   iso     2020 · 2020-Q4 · 2020-P12 · 2020-W53
//
// The JS here is the REFERENCE; `engine/weekCalSql.ts` compiles the same
// buckets for DuckDB and scripts/test-retailCalendar.ts pins the two together.

import { civilFromDays, daysFromCivil } from './civilDays';

export type CalendarType = 'gregorian' | '445' | '454' | '544' | 'iso';
export const CALENDAR_TYPES: readonly CalendarType[] = ['gregorian', '445', '454', '544', 'iso'];
export type YearEndRule = 'nearest' | 'last';
export const YEAR_END_RULES: readonly YearEndRule[] = ['nearest', 'last'];

/** A week calendar. Gregorian is not one — it is `null` wherever a WeekCal is asked for. */
export interface WeekCal {
  type: Exclude<CalendarType, 'gregorian'>;
  yearEnd: YearEndRule;
}

/** The bucket units a week calendar steps in. A date axis's `month` grain is the period. */
export type WeekUnit = 'week' | 'period' | 'quarter' | 'year';

const PATTERN: Record<WeekCal['type'], readonly number[]> = {
  '445': [4, 4, 5], '454': [4, 5, 4], '544': [5, 4, 4], iso: [4, 4, 5],
};

const mod = (a: number, n: number): number => ((a % n) + n) % n;
/** 0 = Sunday. 1970-01-01 was a Thursday. */
const dow = (day: number): number => mod(day + 4, 7);

/** `{ calendarType, yearEnd }` (config / CalendarPrefs) → the week calendar, or null for gregorian. */
export function weekCalOf(c: unknown): WeekCal | null {
  const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
  const t = o.calendarType;
  if (t !== '445' && t !== '454' && t !== '544' && t !== 'iso') return null;
  return { type: t, yearEnd: o.yearEnd === 'last' ? 'last' : 'nearest' };
}

/** The weekday a week starts on: Sunday for retail, Monday for ISO. */
export function weekStartDay(wc: WeekCal): number {
  return wc.type === 'iso' ? 1 : 0;
}

/** Period start weeks within a year: 13 entries, [0, 4, 8, 13, …, 48, 52]. */
export function periodStarts(wc: WeekCal): number[] {
  const out = [0];
  for (let q = 0; q < 4; q++) for (const w of PATTERN[wc.type]) out.push(out[out.length - 1] + w);
  return out;
}

/**
 * The window a year's first day falls in, as [month, day] of its LAST day:
 * the first day is the calendar's week-start weekday on or before it.
 */
export function yearAnchor(wc: WeekCal): [number, number] {
  if (wc.type === 'iso') return [1, 4];
  return wc.yearEnd === 'last' ? [2, 1] : [2, 4];
}

/** The first day of year `y` — the retail year that starts in calendar year y, or ISO year y. */
export function yearStart(y: number, wc: WeekCal): number {
  const [m, d] = yearAnchor(wc);
  const last = daysFromCivil(y, m, d);
  return last - mod(dow(last) - weekStartDay(wc), 7);
}

/** The key of the year holding `day`. */
export function yearKeyOf(day: number, wc: WeekCal): number {
  const y = civilFromDays(day).y;
  if (day >= yearStart(y + 1, wc)) return y + 1;
  return day < yearStart(y, wc) ? y - 1 : y;
}

export interface WeekPos {
  /** The year's key — and its name (see the header). */
  key: number;
  /** 52 or 53. */
  weeks: number;
  /** 1-based, in the year. */
  week: number;
  period: number;
  quarter: number;
  /** 1-based, in the period. */
  weekOfPeriod: number;
}

/** 0-based week of the year → 0-based period. Week 52 (the 53rd) stays in P12. */
export function periodIndex(week0: number, starts: readonly number[]): number {
  let p = 0;
  while (p < 11 && week0 >= starts[p + 1]) p++;
  return p;
}

/** Where a day sits in its week-calendar year. */
export function weekPos(day: number, wc: WeekCal): WeekPos {
  const key = yearKeyOf(day, wc);
  const ys = yearStart(key, wc);
  const week0 = Math.floor((day - ys) / 7);
  const starts = periodStarts(wc);
  const p = periodIndex(week0, starts);
  return {
    key, weeks: (yearStart(key + 1, wc) - ys) / 7,
    week: week0 + 1, period: p + 1, quarter: Math.floor(p / 3) + 1, weekOfPeriod: week0 - starts[p] + 1,
  };
}

// ── Ordinals: consecutive integers per unit, so "n back" is a subtraction ────

export function ordinalOf(day: number, unit: WeekUnit, wc: WeekCal): number {
  if (unit === 'week') return Math.floor((day + 4 - weekStartDay(wc)) / 7);
  const pos = weekPos(day, wc);
  if (unit === 'year') return pos.key;
  if (unit === 'quarter') return pos.key * 4 + pos.quarter - 1;
  return pos.key * 12 + pos.period - 1;
}

/** An ordinal → the first day of its bucket. */
export function ordinalStart(ord: number, unit: WeekUnit, wc: WeekCal): number {
  if (unit === 'week') return ord * 7 - 4 + weekStartDay(wc);
  if (unit === 'year') return yearStart(ord, wc);
  const per = unit === 'quarter' ? 4 : 12;
  const key = Math.floor(ord / per);
  const i = ord - key * per;
  return yearStart(key, wc) + 7 * periodStarts(wc)[unit === 'quarter' ? 3 * i : i];
}

/** The first day of the bucket holding `day`. */
export function bucketStartOf(day: number, unit: WeekUnit, wc: WeekCal): number {
  return ordinalStart(ordinalOf(day, unit, wc), unit, wc);
}

/** A date grain → its week-calendar unit; `day` has none. */
export function unitOfGrain(grain: string): WeekUnit | null {
  if (grain === 'week' || grain === 'quarter' || grain === 'year') return grain;
  return grain === 'month' || grain === 'period' ? 'period' : null;
}

// ── Labels ──────────────────────────────────────────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, '0');

function fyText(fy: number): string {
  return fy >= 1970 && fy <= 2069 ? pad2(fy % 100) : String(fy).padStart(4, '0');
}

/** A bucket's FIRST day → its label. See the header for the shapes. */
export function weekLabel(startDay: number, unit: WeekUnit, wc: WeekCal): string {
  const p = weekPos(startDay, wc);
  if (wc.type === 'iso') {
    const y = String(p.key).padStart(4, '0');
    if (unit === 'year') return y;
    if (unit === 'quarter') return `${y}-Q${p.quarter}`;
    if (unit === 'period') return `${y}-P${pad2(p.period)}`;
    return `${y}-W${pad2(p.week)}`;
  }
  const fy = `FY${fyText(p.key)}`;
  if (unit === 'year') return fy;
  if (unit === 'quarter') return `${fy} Q${p.quarter}`;
  if (unit === 'period') return `${fy} P${pad2(p.period)}`;
  return `${fy} P${pad2(p.period)} W${p.weekOfPeriod}`;
}

const RETAIL_RE = /^FY(\d{2}|\d{4})(?: Q([1-4])| P(\d{2})(?: W(\d))?)?$/;
const ISO_RE = /^(\d{4})(?:-Q([1-4])|-P(\d{2})|-W(\d{2}))?$/;

/** A label → the first day of its bucket, or null when it is not one of `unit`'s labels. */
export function weekLabelStart(label: string, unit: WeekUnit, wc: WeekCal): number | null {
  const s = String(label);
  const m = (wc.type === 'iso' ? ISO_RE : RETAIL_RE).exec(s);
  if (!m) return null;
  let key = Number(m[1]);
  if (m[1].length === 2) key += key >= 70 ? 1900 : 2000;
  const ys = yearStart(key, wc);
  const weeks = (yearStart(key + 1, wc) - ys) / 7;
  const starts = periodStarts(wc);
  let start: number | null = null;
  if (unit === 'year' && !m[2] && !m[3] && !m[4]) start = ys;
  else if (unit === 'quarter' && m[2]) start = ys + 7 * starts[3 * (Number(m[2]) - 1)];
  else if (unit === 'period' && m[3] && !m[4]) {
    const p = Number(m[3]);
    if (p >= 1 && p <= 12) start = ys + 7 * starts[p - 1];
  } else if (unit === 'week' && m[4]) {
    if (wc.type === 'iso') {
      const w = Number(m[4]);
      if (w >= 1 && w <= weeks) start = ys + 7 * (w - 1);
    } else if (m[3]) {
      const p = Number(m[3]);
      const w = Number(m[4]);
      const len = p === 12 ? weeks - starts[11] : starts[p] - starts[p - 1];
      if (p >= 1 && p <= 12 && w >= 1 && w <= len) start = ys + 7 * (starts[p - 1] + w - 1);
    }
  }
  // Round-trip: a label that does not print back exactly (FY2024 for FY24) is not ours.
  return start !== null && weekLabel(start, unit, wc) === s ? start : null;
}

/** A label → its inclusive first and last day, or null. */
export function weekLabelRange(label: string, unit: WeekUnit, wc: WeekCal): { first: number; last: number } | null {
  const first = weekLabelStart(label, unit, wc);
  if (first === null) return null;
  return { first, last: ordinalStart(ordinalOf(first, unit, wc) + 1, unit, wc) - 1 };
}

// ── Last year ───────────────────────────────────────────────────────────────

/**
 * The same day one year earlier, by FISCAL POSITION: same week number, same
 * weekday, so a 53-week year lines up week for week with the year before it.
 * Week 53 has no twin in a 52-week year and maps to week 52.
 */
export function sameDayLastYear(day: number, wc: WeekCal): number {
  const p = weekPos(day, wc);
  const ys = yearStart(p.key, wc);
  const prev = yearStart(p.key - 1, wc);
  const weeks = (ys - prev) / 7;
  const week0 = Math.min(p.week, weeks) - 1;
  return prev + 7 * week0 + mod(day - ys, 7);
}

// ── The active calendar ─────────────────────────────────────────────────────

let active: WeekCal | null = null;

/** Set by `dateIntel.setCalendar` from the workspace formats. */
export function setActiveWeekCal(c: unknown): void {
  active = weekCalOf(c);
}

/** The workspace's week calendar, or null under gregorian. */
export function activeWeekCal(): WeekCal | null {
  return active ? { ...active } : null;
}
