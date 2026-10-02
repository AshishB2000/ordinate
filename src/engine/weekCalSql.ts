// The week calendars (analysis/retailCalendar.ts) compiled to DuckDB SQL — the
// resident twin of `retailCalendar.bucketStartOf` / `ordinalOf`. Pinned to the
// JS reference by scripts/test-retailCalendar.ts with `Object.is` over every day
// of several decades and a sample of far years.
//
// Everything is epoch-day integer arithmetic over a DATE expression `d`, which
// appears only a few times (it is the long canonical-date regex expression):
//
//   W   the week's first day:   date_trunc('week', d + k) − k
//       (DuckDB's week is MONDAY-based; k = 1 shifts it to Sunday weeks)
//   Y   the year's key: the calendar year of W − 28 / W − 25 (retail), W + 3
//       (ISO). Exact because a year starts on a week-start day inside a fixed
//       7-day window, so a week start is in year Y iff it is on/after Y's window.
//   YS  year Y's first day: the week start on or before the window's last day.
//   wk  0-based week of the year, (W − YS) / 7; a 53-entry list literal maps it
//       to its period or quarter — no CASE ladder.
//
// Every value interpolated is an integer this module computed, never input.

import type { WeekCal, WeekUnit } from '../analysis/retailCalendar';
import { periodIndex, periodStarts, weekStartDay, yearAnchor } from '../analysis/retailCalendar';

const EPOCH = "DATE '1970-01-01'";

/** Days from the epoch to a DATE/TIMESTAMP expression, as BIGINT. */
const days = (x: string): string => `date_diff('day', ${EPOCH}, ${x})`;

function parts(d: string, wc: WeekCal): { w: string; y: string; ys: string; wk: string } {
  const k = 1 - weekStartDay(wc);
  const w = `(${days(`date_trunc('week', ${d} + ${k})`)} - ${k})`;
  const open = wc.type === 'iso' ? 3 : wc.yearEnd === 'last' ? -25 : -28;
  const y = `year(${EPOCH} + CAST(${w} + ${open} AS INTEGER))`;
  const [am, ad] = yearAnchor(wc);
  const ys = `(${days(`date_trunc('week', make_date(${y}, ${am}, ${ad}) + ${k})`)} - ${k})`;
  return { w, y, ys, wk: `((${w} - ${ys}) // 7)` };
}

/** A 53-entry list: week of the year → `pick(period index, period starts)`. */
function weekList(wc: WeekCal, pick: (p: number, starts: number[]) => number): string {
  const starts = periodStarts(wc);
  const out: number[] = [];
  for (let w = 0; w < 53; w++) out.push(pick(periodIndex(w, starts), starts));
  return `[${out.join(', ')}]`;
}

/** The bucket id (epoch day of the bucket's first day) — `retailCalendar.bucketStartOf`. INTEGER. */
export function weekBucketSql(d: string, unit: WeekUnit, wc: WeekCal): string {
  const p = parts(d, wc);
  if (unit === 'week') return `CAST(${p.w} AS INTEGER)`;
  if (unit === 'year') return `CAST(${p.ys} AS INTEGER)`;
  const first = weekList(wc, (i, s) => s[unit === 'quarter' ? i - (i % 3) : i]);
  return `CAST(${p.ys} + 7 * ${first}[${p.wk} + 1] AS INTEGER)`;
}

/** `retailCalendar.ordinalOf` — consecutive integers per unit. INTEGER. */
export function weekOrdinalSql(d: string, unit: WeekUnit, wc: WeekCal): string {
  const p = parts(d, wc);
  if (unit === 'week') return `CAST((${p.w} + ${4 - weekStartDay(wc)}) // 7 AS INTEGER)`;
  if (unit === 'year') return `CAST(${p.y} AS INTEGER)`;
  const idx = weekList(wc, (i) => (unit === 'quarter' ? Math.floor(i / 3) : i));
  return `CAST(${p.y} * ${unit === 'quarter' ? 4 : 12} + ${idx}[${p.wk} + 1] AS INTEGER)`;
}
