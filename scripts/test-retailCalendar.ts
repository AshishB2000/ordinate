'use strict';

// Self-check for src/analysis/retailCalendar.ts (the retail 4-4-5 / 4-5-4 /
// 5-4-4 calendars and the ISO week-year), the consumers that follow it
// (dateIntel presets and comparisons, categoryKey buckets and labels, cohort
// and scorecard periods, driver ranges, forecast labels) and its SQL twin
// engine/weekCalSql.ts.
//
// Every expected date below is written out by hand from the PUBLISHED NRF
// 4-5-4 calendar (the year ends on the Saturday nearest January 31; 53-week
// years in this span: fiscal 2023 and fiscal 2028) and from ISO 8601 week
// tables — never derived with the code under test.
//
//   npm run build:ts && node scripts/test-retailCalendar.js

import {
  bucketStartOf, ordinalOf, ordinalStart, sameDayLastYear, setActiveWeekCal, weekCalOf, weekLabel,
  weekLabelRange, weekPos, yearStart,
} from '../src/analysis/retailCalendar';
import type { WeekCal, WeekUnit } from '../src/analysis/retailCalendar';
import {
  daysFromIso, describePeriod, isoFromDays, resolvePeriod, sanitizeCalendar, setCalendar, shiftBucketLabel, shiftRange,
} from '../src/analysis/dateIntel';
import type { CalendarPrefs, PeriodSpec } from '../src/analysis/dateIntel';
import { dateBucket, dateBucketLabel, parseDateCell } from '../src/analysis/categoryKey';
import { cohortLabel, periodOrdinal } from '../src/analysis/cohortData';
import { periodWindow } from '../src/analysis/scorecardModel';
import { bucketRange } from '../src/analysis/driverScope';
import { futureLabels } from '../src/analysis/forecast';
import { auditNumbers } from '../src/ai/numberAudit';
import { weekBucketSql, weekOrdinalSql } from '../src/engine/weekCalSql';
import { dateBucketSql } from '../src/engine/residentCategory';
import * as duck from '../src/engine/duckdb';

import { ok, finish } from './selfcheck';

const NRF: WeekCal = { type: '454', yearEnd: 'nearest' };
const LAST: WeekCal = { type: '454', yearEnd: 'last' };
const C445: WeekCal = { type: '445', yearEnd: 'nearest' };
const C544: WeekCal = { type: '544', yearEnd: 'nearest' };
const ISO: WeekCal = { type: 'iso', yearEnd: 'nearest' };
const PREFS_454: CalendarPrefs = { weekStart: 1, fiscalYearStart: 1, calendarType: '454', yearEnd: 'nearest' };
const PREFS_ISO: CalendarPrefs = { weekStart: 1, fiscalYearStart: 1, calendarType: 'iso', yearEnd: 'nearest' };

const D = (iso: string): number => {
  const d = daysFromIso(iso);
  if (d === null) throw new Error('bad date ' + iso);
  return d;
};
const eq = (label: string, got: unknown, want: unknown): void => ok(`${label}: ${String(want)}`, got === want, `got ${String(got)}`);
const span = (r: { from?: string; to?: string } | null): string => (r ? `${r.from || ''}..${r.to || ''}` : 'null');

// ── 1. The published NRF 4-5-4 calendar, fiscal 2018–2030 ──────────────────
{
  // [fiscal year, first day, last day, weeks] — NRF's published year ends.
  const years: Array<[number, string, string, number]> = [
    [2018, '2018-02-04', '2019-02-02', 52],
    [2019, '2019-02-03', '2020-02-01', 52],
    [2020, '2020-02-02', '2021-01-30', 52],
    [2021, '2021-01-31', '2022-01-29', 52],
    [2022, '2022-01-30', '2023-01-28', 52],
    [2023, '2023-01-29', '2024-02-03', 53],
    [2024, '2024-02-04', '2025-02-01', 52],
    [2025, '2025-02-02', '2026-01-31', 52],
    [2026, '2026-02-01', '2027-01-30', 52],
    [2027, '2027-01-31', '2028-01-29', 52],
    [2028, '2028-01-30', '2029-02-03', 53],
    [2029, '2029-02-04', '2030-02-02', 52],
    [2030, '2030-02-03', '2031-02-01', 52],
  ];
  for (const [fy, first, last, weeks] of years) {
    eq(`NRF FY${fy} starts`, isoFromDays(yearStart(fy, NRF)), first);
    eq(`NRF FY${fy} ends`, isoFromDays(yearStart(fy + 1, NRF) - 1), last);
    eq(`NRF FY${fy} weeks`, weekPos(D(first), NRF).weeks, weeks);
    eq(`NRF FY${fy} last day is in FY${fy}`, weekPos(D(last), NRF).key, fy);
  }
  const fiftyThree = years.filter((y) => weekPos(D(y[1]), NRF).weeks === 53).map((y) => y[0]).join(',');
  eq('NRF 53-week years 2018–2030', fiftyThree, '2023,2028');
}

// ── 2. Period boundaries, 4-5-4, a 52-week and a 53-week year ───────────────
const periods = (fy: number, wc: WeekCal): string[] => {
  const out: string[] = [];
  for (let p = 0; p < 12; p++) {
    const o = fy * 12 + p;
    out.push(`${isoFromDays(ordinalStart(o, 'period', wc))}..${isoFromDays(ordinalStart(o + 1, 'period', wc) - 1)}`);
  }
  return out;
};
const checkPeriods = (label: string, got: string[], want: string[]): void => {
  want.forEach((w, i) => eq(`${label} P${i + 1}`, got[i], w));
};
checkPeriods('4-5-4 FY2018', periods(2018, NRF), [
  '2018-02-04..2018-03-03', '2018-03-04..2018-04-07', '2018-04-08..2018-05-05',
  '2018-05-06..2018-06-02', '2018-06-03..2018-07-07', '2018-07-08..2018-08-04',
  '2018-08-05..2018-09-01', '2018-09-02..2018-10-06', '2018-10-07..2018-11-03',
  '2018-11-04..2018-12-01', '2018-12-02..2019-01-05', '2019-01-06..2019-02-02',
]);
// The 53rd week joins the last period: NRF's January 2024 is five weeks.
checkPeriods('4-5-4 FY2023 (53 weeks)', periods(2023, NRF), [
  '2023-01-29..2023-02-25', '2023-02-26..2023-04-01', '2023-04-02..2023-04-29',
  '2023-04-30..2023-05-27', '2023-05-28..2023-07-01', '2023-07-02..2023-07-29',
  '2023-07-30..2023-08-26', '2023-08-27..2023-09-30', '2023-10-01..2023-10-28',
  '2023-10-29..2023-11-25', '2023-11-26..2023-12-30', '2023-12-31..2024-02-03',
]);
checkPeriods('4-5-4 FY2024', periods(2024, NRF), [
  '2024-02-04..2024-03-02', '2024-03-03..2024-04-06', '2024-04-07..2024-05-04',
  '2024-05-05..2024-06-01', '2024-06-02..2024-07-06', '2024-07-07..2024-08-03',
  '2024-08-04..2024-08-31', '2024-09-01..2024-10-05', '2024-10-06..2024-11-02',
  '2024-11-03..2024-11-30', '2024-12-01..2025-01-04', '2025-01-05..2025-02-01',
]);
checkPeriods('4-4-5 FY2024', periods(2024, C445), [
  '2024-02-04..2024-03-02', '2024-03-03..2024-03-30', '2024-03-31..2024-05-04',
  '2024-05-05..2024-06-01', '2024-06-02..2024-06-29', '2024-06-30..2024-08-03',
  '2024-08-04..2024-08-31', '2024-09-01..2024-09-28', '2024-09-29..2024-11-02',
  '2024-11-03..2024-11-30', '2024-12-01..2024-12-28', '2024-12-29..2025-02-01',
]);
checkPeriods('5-4-4 FY2024', periods(2024, C544), [
  '2024-02-04..2024-03-09', '2024-03-10..2024-04-06', '2024-04-07..2024-05-04',
  '2024-05-05..2024-06-08', '2024-06-09..2024-07-06', '2024-07-07..2024-08-03',
  '2024-08-04..2024-09-07', '2024-09-08..2024-10-05', '2024-10-06..2024-11-02',
  '2024-11-03..2024-12-07', '2024-12-08..2025-01-04', '2025-01-05..2025-02-01',
]);
{
  const q = (fy: number, i: number): string =>
    `${isoFromDays(ordinalStart(fy * 4 + i, 'quarter', NRF))}..${isoFromDays(ordinalStart(fy * 4 + i + 1, 'quarter', NRF) - 1)}`;
  eq('4-5-4 FY2023 Q1 (13 weeks)', q(2023, 0), '2023-01-29..2023-04-29');
  eq('4-5-4 FY2023 Q4 (14 weeks)', q(2023, 3), '2023-10-29..2024-02-03');
}

// ── 3. "Last Saturday of January" — where the two rules differ ──────────────
{
  eq('last-Sat FY2018 starts', isoFromDays(yearStart(2018, LAST)), '2018-01-28');
  eq('last-Sat FY2018 ends', isoFromDays(yearStart(2019, LAST) - 1), '2019-01-26');
  eq('last-Sat FY2020 is 53 weeks', weekPos(D('2020-06-01'), LAST).weeks, 53);
  eq('last-Sat FY2020 ends', isoFromDays(yearStart(2021, LAST) - 1), '2021-01-30');
  eq('last-Sat FY2025 starts', isoFromDays(yearStart(2025, LAST)), '2025-01-26');
  eq('last-Sat FY2025 ends Jan 31 2026', isoFromDays(yearStart(2026, LAST) - 1), '2026-01-31');
  eq('last-Sat FY2025 is 53 weeks', weekPos(D('2025-06-01'), LAST).weeks, 53);
  eq('nearest FY2025 is 52 weeks', weekPos(D('2025-06-01'), NRF).weeks, 52);
  eq('Jan 27–Feb 1 2025 is FY2025 under last-Sat', weekPos(D('2025-01-28'), LAST).key, 2025);
  eq('…and FY2024 under nearest', weekPos(D('2025-01-28'), NRF).key, 2024);
}

// ── 4. ISO 8601 week edges ─────────────────────────────────────────────────
{
  const isoWeek = (iso: string): string => weekLabel(bucketStartOf(D(iso), 'week', ISO), 'week', ISO);
  eq('2020-12-31 (Thu)', isoWeek('2020-12-31'), '2020-W53');
  eq('2021-01-03 (Sun)', isoWeek('2021-01-03'), '2020-W53');
  eq('2021-01-04 (Mon)', isoWeek('2021-01-04'), '2021-W01');
  eq('2018-12-31 (Mon)', isoWeek('2018-12-31'), '2019-W01');
  eq('2019-12-29 (Sun)', isoWeek('2019-12-29'), '2019-W52');
  eq('2019-12-30 (Mon)', isoWeek('2019-12-30'), '2020-W01');
  eq('2026-12-31 (Thu)', isoWeek('2026-12-31'), '2026-W53');
  eq('2027-01-01 (Fri)', isoWeek('2027-01-01'), '2026-W53');
  eq('2027-01-03 (Sun)', isoWeek('2027-01-03'), '2026-W53');
  eq('2027-01-04 (Mon)', isoWeek('2027-01-04'), '2027-W01');
  eq('2024-12-30 (Mon)', isoWeek('2024-12-30'), '2025-W01');
  eq('ISO 2020 has 53 weeks', weekPos(D('2020-06-01'), ISO).weeks, 53);
  eq('ISO 2021 has 52 weeks', weekPos(D('2021-06-01'), ISO).weeks, 52);
  eq('ISO 2026 has 53 weeks', weekPos(D('2026-06-01'), ISO).weeks, 53);
  eq('ISO year 2020 starts', isoFromDays(yearStart(2020, ISO)), '2019-12-30');
  eq('ISO year label of 2021-01-03', weekLabel(bucketStartOf(D('2021-01-03'), 'year', ISO), 'year', ISO), '2020');
}

// ── 5. Labels and their way back ───────────────────────────────────────────
{
  const lab = (iso: string, unit: WeekUnit, wc = NRF): string => weekLabel(bucketStartOf(D(iso), unit, wc), unit, wc);
  eq('2024-03-12 week', lab('2024-03-12', 'week'), 'FY24 P02 W2');
  eq('2024-03-12 period', lab('2024-03-12', 'period'), 'FY24 P02');
  eq('2024-03-12 quarter', lab('2024-03-12', 'quarter'), 'FY24 Q1');
  eq('2024-03-12 year', lab('2024-03-12', 'year'), 'FY24');
  eq('2024-02-01 is the 53rd week', lab('2024-02-01', 'week'), 'FY23 P12 W5');
  eq('2024-01-31 is in FY23 Q4', lab('2024-01-31', 'quarter'), 'FY23 Q4');
  eq('a year outside 1970–2069 prints four digits', lab('1965-06-01', 'year'), 'FY1965');
  const back = (l: string, unit: WeekUnit, wc = NRF): string => {
    const r = weekLabelRange(l, unit, wc);
    return r ? `${isoFromDays(r.first)}..${isoFromDays(r.last)}` : 'null';
  };
  eq('FY23 P12 W5 → its days', back('FY23 P12 W5', 'week'), '2024-01-28..2024-02-03');
  eq('FY24 P02 → its days', back('FY24 P02', 'period'), '2024-03-03..2024-04-06');
  eq('FY23 Q4 → its days', back('FY23 Q4', 'quarter'), '2023-10-29..2024-02-03');
  eq('FY23 → its days', back('FY23', 'year'), '2023-01-29..2024-02-03');
  eq('FY22 P12 W5 does not exist (52 weeks)', back('FY22 P12 W5', 'week'), 'null');
  eq('a period label is not a week label', back('FY24 P02', 'week'), 'null');
  eq('FY2024 is not how 2024 prints', back('FY2024', 'year'), 'null');
  eq('2020-W53 → its days', back('2020-W53', 'week', ISO), '2020-12-28..2021-01-03');
  eq('2021-W53 does not exist', back('2021-W53', 'week', ISO), 'null');
}

// ── 6. Relative presets under 4-5-4 ────────────────────────────────────────
{
  const r = (spec: PeriodSpec, t: string, cal = PREFS_454): string => span(resolvePeriod(spec, t, cal));
  const t = '2024-03-12';
  eq('this week (Sunday)', r({ preset: 'this_week' }, t), '2024-03-10..2024-03-16');
  eq('last week', r({ preset: 'last_week' }, t), '2024-03-03..2024-03-09');
  eq('this period', r({ preset: 'this_month' }, t), '2024-03-03..2024-04-06');
  eq('last period', r({ preset: 'last_month' }, t), '2024-02-04..2024-03-02');
  eq('last 3 periods cross the 53-week year end', r({ preset: 'last_n_months', n: 3 }, t), '2023-11-26..2024-03-02');
  eq('this quarter', r({ preset: 'this_quarter' }, t), '2024-02-04..2024-05-04');
  eq('last quarter is the 14-week Q4', r({ preset: 'last_quarter' }, t), '2023-10-29..2024-02-03');
  eq('this year', r({ preset: 'this_year' }, t), '2024-02-04..2025-02-01');
  eq('last year (53 weeks)', r({ preset: 'last_year' }, t), '2023-01-29..2024-02-03');
  eq('year to date', r({ preset: 'ytd' }, t), '2024-02-04..2024-03-12');
  eq('quarter to date', r({ preset: 'qtd' }, t), '2024-02-04..2024-03-12');
  eq('days are days', r({ preset: 'last_n_days', n: 7 }, t), '2024-03-05..2024-03-11');
  eq('in the 53rd week, this year is FY2023', r({ preset: 'this_year' }, '2024-02-01'), '2023-01-29..2024-02-03');
  eq('ISO: this week (Monday)', r({ preset: 'this_week' }, '2021-01-02', PREFS_ISO), '2020-12-28..2021-01-03');
  eq('ISO: this year', r({ preset: 'this_year' }, '2021-01-02', PREFS_ISO), '2019-12-30..2021-01-03');
  eq('ISO: last year', r({ preset: 'last_year' }, '2021-01-02', PREFS_ISO), '2018-12-31..2019-12-29');
  eq('describe: this period', describePeriod({ preset: 'this_month' }, PREFS_454), 'This period');
  eq('describe: last 3 periods', describePeriod({ preset: 'last_n_months', n: 3 }, PREFS_454), 'Last 3 periods');
  eq('describe: retail years are fiscal', describePeriod({ preset: 'this_year' }, PREFS_454), 'This fiscal year');
  eq('describe: ISO years are not', describePeriod({ preset: 'this_year' }, PREFS_ISO), 'This year');
}

// ── 7. Comparisons in a 53-week year ───────────────────────────────────────
{
  const sh = (from: string, to: string, mode: 'previous_period' | 'previous_year', cal = PREFS_454): string =>
    span(shiftRange({ from, to }, mode, cal));
  eq('FY23 week 10 → FY22 week 10', sh('2023-04-02', '2023-04-08', 'previous_year'), '2022-04-03..2022-04-09');
  eq('FY24 week 1 → FY23 week 1, not a 364-day shift', sh('2024-02-04', '2024-02-10', 'previous_year'), '2023-01-29..2023-02-04');
  eq('the 53rd week → FY22 week 52', sh('2024-01-28', '2024-02-03', 'previous_year'), '2023-01-22..2023-01-28');
  eq('the whole 53-week FY23 → the whole FY22', sh('2023-01-29', '2024-02-03', 'previous_year'), '2022-01-30..2023-01-28');
  eq('FY23 P12 (5 weeks) → FY22 P12 (4 weeks)', sh('2023-12-31', '2024-02-03', 'previous_year'), '2023-01-01..2023-01-28');
  eq('previous period of FY23 P12 is P11', sh('2023-12-31', '2024-02-03', 'previous_period'), '2023-11-26..2023-12-30');
  eq('previous period of FY24 Q1 is the 14-week Q4', sh('2024-02-04', '2024-05-04', 'previous_period'), '2023-10-29..2024-02-03');
  eq('previous period of 10 days is 10 days', sh('2024-03-01', '2024-03-10', 'previous_period'), '2024-02-20..2024-02-29');
  eq('same weekday a year back', isoFromDays(sameDayLastYear(D('2024-03-12'), NRF)), '2023-03-07');
  eq('an open start still has a last year', span(shiftRange({ from: '2024-02-04' }, 'previous_year', PREFS_454)), '2023-01-29..');

  setCalendar(PREFS_454);
  eq('label: FY23 P12 W5 → FY22 P12 W4', shiftBucketLabel('FY23 P12 W5', 'week'), 'FY22 P12 W4');
  eq('label: FY24 P01 W1 → FY23 P01 W1', shiftBucketLabel('FY24 P01 W1', 'week'), 'FY23 P01 W1');
  eq('label: FY24 P03 → FY23 P03', shiftBucketLabel('FY24 P03', 'month'), 'FY23 P03');
  eq('label: FY24 Q1 → FY23 Q1', shiftBucketLabel('FY24 Q1', 'quarter'), 'FY23 Q1');
  eq('label: FY24 → FY23', shiftBucketLabel('FY24', 'year'), 'FY23');
  eq('label: a gregorian label is not a retail one', shiftBucketLabel('2024-03', 'month'), null);
  eq('module default: shiftRange follows the workspace calendar', span(shiftRange({ from: '2024-02-04', to: '2024-02-10' }, 'previous_year')), '2023-01-29..2023-02-04');
  setCalendar({});
  eq('back to gregorian: labels move by a year', shiftBucketLabel('2024-03', 'month'), '2023-03');
}

// ── 8. Every consumer follows the workspace calendar ──────────────────────
{
  setCalendar(PREFS_454);
  const p = parseDateCell('2024-03-12')!;
  eq('axis: week', dateBucketLabel(dateBucket(p, 'week'), 'week'), 'FY24 P02 W2');
  eq('axis: month is the period', dateBucketLabel(dateBucket(p, 'month'), 'month'), 'FY24 P02');
  eq('axis: quarter', dateBucketLabel(dateBucket(p, 'quarter'), 'quarter'), 'FY24 Q1');
  eq('axis: year', dateBucketLabel(dateBucket(p, 'year'), 'year'), 'FY24');
  eq('axis: day stays a date', dateBucketLabel(dateBucket(p, 'day'), 'day'), '2024-03-12');
  eq('drivers: a period label → its days', span(bucketRange('FY24 P02', 'month')), '2024-03-03..2024-04-06');
  eq('forecast: the periods after FY23 P11', (futureLabels(['FY23 P11'], 'month', 3) || []).join(','), 'FY23 P12,FY24 P01,FY24 P02');
  const w = periodWindow('2024-03-12', 'month', 1, PREFS_454);
  eq('scorecard: last period', w ? `${w.from}..${w.to} ${w.label}` : 'null', '2024-02-04..2024-03-02 FY24 P01');
  const yw = periodWindow('2024-03-12', 'year', 1, PREFS_454);
  eq('scorecard: last year', yw ? `${yw.from}..${yw.to} ${yw.label}` : 'null', '2023-01-29..2024-02-03 FY23');
  eq('cohort: period ordinal → label', cohortLabel(periodOrdinal(D('2024-02-01'), 'month', PREFS_454), 'month', PREFS_454), 'FY23 P12');
  eq('cohort: consecutive across the year end',
    periodOrdinal(D('2024-02-04'), 'month', PREFS_454) - periodOrdinal(D('2024-02-03'), 'month', PREFS_454), 1);
  eq('cohort: week label', cohortLabel(periodOrdinal(D('2024-02-01'), 'week', PREFS_454), 'week', PREFS_454), 'FY23 P12 W5');
  ok('numbers: an FY label is not a figure', auditNumbers('FY24 P03 W2 and 2020-W53 were the peaks', []).ok);
  setCalendar({});
  eq('gregorian again: quarter label', dateBucketLabel(dateBucket(p, 'quarter'), 'quarter'), '2024-Q1');
  setActiveWeekCal(null);
}

// ── 9. Settings round trip ─────────────────────────────────────────────────
{
  const old = sanitizeCalendar({ weekStart: 0, fiscalYearStart: 7 });
  eq('old prefs are gregorian', old.calendarType, 'gregorian');
  ok('old prefs keep their week and fiscal start', old.weekStart === 0 && old.fiscalYearStart === 7);
  eq('junk type → gregorian', sanitizeCalendar({ calendarType: '4-4-5' }).calendarType, 'gregorian');
  eq('junk year end → nearest', sanitizeCalendar({ calendarType: '454', yearEnd: 'first' }).yearEnd, 'nearest');
  ok('gregorian is not a week calendar', weekCalOf(old) === null);
  eq('a retail type is', weekCalOf({ calendarType: '544', yearEnd: 'last' })?.yearEnd, 'last');
}

// ── 10. Ordinals step by exactly one, every day, every calendar ───────────
{
  let bad = '';
  for (const wc of [NRF, LAST, C445, C544, ISO]) {
    for (const unit of ['week', 'period', 'quarter', 'year'] as WeekUnit[]) {
      let prev = ordinalOf(D('1999-12-01'), unit, wc);
      for (let d = D('1999-12-02'); d <= D('2032-01-31') && !bad; d++) {
        const o = ordinalOf(d, unit, wc);
        const startsHere = ordinalStart(o, unit, wc) === d;
        if (o !== prev + (startsHere ? 1 : 0)) bad = `${wc.type}/${wc.yearEnd} ${unit} at ${isoFromDays(d)}`;
        prev = o;
      }
    }
  }
  ok('ordinals are consecutive and start where they say, 2000–2031', bad === '', bad);
}

// ── 11. The SQL twin, Object.is against the JS reference ───────────────────
function sqlDifferential(): void {
  const ranges: Array<[string, number]> = [['1999-12-01', 32 * 366], ['1899-12-01', 800], ['2399-12-01', 800], ['1969-11-01', 800]];
  for (const wc of [NRF, LAST, C445, C544, ISO]) {
    let bad = '';
    let n = 0;
    for (const [from, len] of ranges) {
      const units = ['week', 'period', 'quarter', 'year'] as WeekUnit[];
      const cols = units.map((u) => `${weekBucketSql('d', u, wc)} AS b_${u}, ${weekOrdinalSql('d', u, wc)} AS o_${u}`).join(', ');
      const rows = duck.query(`SELECT CAST(i AS INTEGER) AS i, ${cols} FROM (SELECT i, DATE '${from}' + CAST(i AS INTEGER) AS d FROM range(0, ${len}) t(i)) ORDER BY i`);
      const base = D(from);
      for (const r of rows) {
        const day = base + Number(r.i);
        for (const u of units) {
          n++;
          if (!bad && !Object.is(r[`b_${u}`], bucketStartOf(day, u, wc))) bad = `bucket ${u} ${isoFromDays(day)}: ${String(r[`b_${u}`])}`;
          if (!bad && !Object.is(r[`o_${u}`], ordinalOf(day, u, wc))) bad = `ordinal ${u} ${isoFromDays(day)}: ${String(r[`o_${u}`])}`;
        }
      }
    }
    ok(`SQL ≡ JS, Object.is, ${wc.type}/${wc.yearEnd} (${n} day-units incl. 1900, 1970, 2400)`, bad === '' && n > 0, bad);
  }
  // The live dispatcher: residentCategory.dateBucketSql follows the workspace calendar.
  setCalendar(PREFS_454);
  const row = duck.query(`SELECT ${dateBucketSql("DATE '2024-02-01'", 'month')} AS m, ${dateBucketSql("DATE '2024-02-01'", 'day')} AS d`)[0];
  eq('dateBucketSql: month is the 4-5-4 period', row && isoFromDays(Number(row.m)), '2023-12-31');
  eq('dateBucketSql: day stays the day', row && isoFromDays(Number(row.d)), '2024-02-01');
  setCalendar({});
}

let bridge = false;
try { bridge = duck.isAvailable(); } catch { bridge = false; }
if (!bridge) console.log('ok   (skipped) the DuckDB bridge is unavailable — SQL differential not run');
else sqlDifferential();
finish();
