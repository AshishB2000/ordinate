// A date axis's buckets as DAYS (semantic layer part 5, step 06) — PURE. A period metric on a date axis is resolved
// once per bucket with the bucket's days as its scope (ipc/metricBuckets), so each axis label must give back the days
// it names, and the axis must hold every bucket from its first to its last: a month with no rows still has a YTD.
// Labels are read exactly as the axis writes them (categoryKey.dateBucketLabel): gregorian, a week naming its Monday,
// or the active week calendar's periods (retailCalendar).

import { civilFromDays, dateBucket, dateBucketLabel, daysFromCivil } from './categoryKey';
import type { DateGrain } from './categoryKey';
import { daysFromIso, isoFromDays } from './dateIntel';
import { activeWeekCal, unitOfGrain, weekLabelRange } from './retailCalendar';

const GREGORIAN = /^(\d{4})(?:-Q([1-4])|-(\d{2})(?:-(\d{2}))?)?$/;
/** At least one bucket's length and less than two: the day this far past a bucket's start is in the next one. */
const SPAN: Record<DateGrain, number> = { day: 1, week: 7, month: 31, quarter: 92, year: 366 };

const labelOfDay = (day: number, grain: DateGrain): string => dateBucketLabel(dateBucket(civilFromDays(day), grain), grain);

/** The first and last day (ISO) of the bucket an axis labels `label` at `grain`, or null when it is not one of its labels. */
export function bucketRange(label: string, grain: DateGrain): { from: string; to: string } | null {
  const wc = grain === 'day' ? null : activeWeekCal();
  if (wc) {
    const r = weekLabelRange(label, unitOfGrain(grain)!, wc);
    return r ? { from: isoFromDays(r.first), to: isoFromDays(r.last) } : null;
  }
  const m = GREGORIAN.exec(String(label));
  if (!m) return null;
  const first = daysFromCivil(Number(m[1]), m[2] ? 3 * Number(m[2]) - 2 : m[3] ? Number(m[3]) : 1, m[4] ? Number(m[4]) : 1);
  // Round trip: a month under day grain, a week that is not a Monday, or 2024-02-30 is not this axis's label.
  if (dateBucket(civilFromDays(first), grain) !== first || dateBucketLabel(first, grain) !== label) return null;
  return { from: isoFromDays(first), to: isoFromDays(dateBucket(civilFromDays(first + SPAN[grain]), grain) - 1) };
}

/** Every bucket from the earliest of `labels` to the latest, in order; a label that names no bucket (a blank) is left out. */
export function fillBuckets(labels: readonly string[], grain: DateGrain): string[] {
  const days = labels.map((l) => bucketRange(l, grain)).filter((r): r is { from: string; to: string } => !!r);
  if (!days.length) return [];
  const first = Math.min(...days.map((r) => daysFromIso(r.from)!));
  const last = Math.max(...days.map((r) => daysFromIso(r.to)!));
  const out: string[] = [];
  for (let day = first; day <= last; ) {
    const label = labelOfDay(day, grain);
    out.push(label);
    day = daysFromIso(bucketRange(label, grain)!.to)! + 1;
  }
  return out;
}
