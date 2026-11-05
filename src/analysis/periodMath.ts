// The days a period metric's window covers (semantic layer part 5, D9) — PURE: a scope in, a scope out.
//
// "Scope end" is the last day of the range in scope on the base's date, or today when there is none or it is open.
// To date: the start of the unit holding min(scope end, today), to that day. Last N: N whole units ending at scope
// end (`last_n_*` resolved the day after it, never past today). The window REPLACES the scope's bounds on the base's
// date; every other filter stays. Units follow the workspace calendar through `resolvePeriod` (fiscal year, week
// start, a week calendar), never `categoryKey.dateBucket` (Monday weeks, calendar quarters).

import type { FilterStep } from '../data/transforms';
import { daysFromIso, isoFromDays, resolvePeriod } from './dateIntel';
import type { CalendarPrefs, DateRange, PeriodPreset } from './dateIntel';
import { scopeRange, withRange } from './periodScope';
import type { ScopeColumn } from './periodScope';
import type { MetricCompare, MetricWindow } from './periodMetric';

const earlier = (a: string, b: string): string => ((daysFromIso(a) ?? 0) <= (daysFromIso(b) ?? 0) ? a : b);

/** The last day of the range in scope on `dateColumn`, or `today` when there is none or it is open. */
export function scopeEnd(filters: FilterStep[], dateColumn: ScopeColumn, today: string): string {
  return scopeRange(filters, [dateColumn])?.range.to ?? today;
}

/** The window ending at scope end `end`, under `cal`. */
export function windowRange(window: MetricWindow, end: string, today: string, cal: CalendarPrefs): DateRange {
  if ('to_date' in window) {
    const e = earlier(end, today);
    return { from: resolvePeriod({ preset: `this_${window.to_date}` as PeriodPreset }, e, cal)?.from, to: e };
  }
  const ref = earlier(isoFromDays((daysFromIso(end) as number) + 1), today);
  return resolvePeriod({ preset: `last_n_${window.unit}s` as PeriodPreset, n: window.last }, ref, cal) ?? {};
}

/** The scope with its bounds on `dateColumn` replaced by the window, and the window's range; no window: the scope as it is and its range (or null). */
export function windowedScope(filters: FilterStep[], dateColumn: ScopeColumn, window: MetricWindow | undefined, today: string, cal: CalendarPrefs): { filters: FilterStep[]; range: DateRange | null } {
  if (!window) return { filters, range: scopeRange(filters, [dateColumn])?.range ?? null };
  const range = windowRange(window, scopeEnd(filters, dateColumn, today), today, cal);
  return { filters: withRange(filters, dateColumn.name, range, new Map([[dateColumn.name, dateColumn.type]])), range };
}

/** (now − prior) ÷ |prior|; null on a null or zero prior. */
export function pctChange(now: number | null, prior: number | null): number | null {
  return now === null || prior === null || prior === 0 ? null : (now - prior) / Math.abs(prior);
}

/** The figure a period metric shows: `now` with no compare, else its change, % change or the prior figure. */
export function periodValue(show: MetricCompare['show'] | undefined, now: number | null, prior: number | null): number | null {
  if (!show) return now;
  if (show === 'prior') return prior;
  if (show === 'pct_change') return pctChange(now, prior);
  return now === null || prior === null ? null : now - prior;
}
