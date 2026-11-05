// The arithmetic of a metric's target under a date range (semantic layer part 5, D13). PURE: it splits a range into
// the `per` periods it touches (the workspace calendar's own: fiscal years, week starts, 4-4-5 weeks) and plans at most
// three resolutions of the plan: a partial first period, the whole periods between as one, a partial last period.

import type { CalendarPrefs } from './dateIntel';
import { daysFromIso, isoFromDays } from './dateIntel';
import { periodWindow } from './scorecardModel';
import type { ScorePeriod } from './scorecardModel';

/** One `per` period the range touches: its own bounds, the days the range covers of it, and its length. */
export interface PeriodPart { from: string; to: string; covered: number; days: number; label: string }

/** A resolution of the plan metric and what share of it counts. */
export interface PlanAsk { from: string; to: string; fraction: number }

export function periodParts(range: { from: string; to: string }, per: ScorePeriod, cal: CalendarPrefs): PeriodPart[] {
  const end = daysFromIso(range.to);
  let day = daysFromIso(range.from);
  const out: PeriodPart[] = [];
  while (day !== null && end !== null && day <= end) {
    const w = periodWindow(isoFromDays(day), per, 0, cal);
    const a = w ? daysFromIso(w.from) : null;
    const b = w ? daysFromIso(w.to) : null;
    if (!w || a === null || b === null || b < day) break; // shortcut: a calendar that yields no window ends the walk (no part, so no target)
    out.push({ ...w, covered: Math.min(b, end) - day + 1, days: b - a + 1 });
    day = b + 1;
  }
  return out;
}

const whole = (p: PeriodPart): boolean => p.covered === p.days;

/** At most three asks: the partial first period, the whole periods between merged (fraction 1), the partial last. */
export function planAsks(parts: PeriodPart[]): PlanAsk[] {
  const asks: PlanAsk[] = [];
  let run: PeriodPart[] = [];
  const flush = (): void => {
    if (run.length) asks.push({ from: run[0].from, to: run[run.length - 1].to, fraction: 1 });
    run = [];
  };
  for (const p of parts) {
    if (whole(p)) { run.push(p); continue; }
    flush();
    asks.push({ from: p.from, to: p.to, fraction: p.covered / p.days });
  }
  flush();
  return asks;
}

/** Σ value × covered ÷ days: a fixed figure per period, pro-rated by calendar days. */
export function fixedTarget(value: number, parts: PeriodPart[]): number {
  return parts.reduce((s, p) => s + (value * p.covered) / p.days, 0);
}

/** The range widened to whole periods. */
export function widened(parts: PeriodPart[]): { from: string; to: string } {
  return { from: parts[0].from, to: parts[parts.length - 1].to };
}
