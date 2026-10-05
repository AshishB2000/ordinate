// A pipeline's cron-like schedule — PURE, no clock.
//
// Five fields, the classic shape: minute hour day-of-month month day-of-week.
// Each is `*`, a number, a range `a-b`, a step `*/n` or `a-b/n`, or a comma
// list of those. Day-of-week is 0–6 from Sunday, and 7 is Sunday again. When
// BOTH day fields are restricted a day matches either (the classic OR rule).
//
// TIME ZONES. A schedule is wall-clock time in a named IANA zone, so "06:00
// every day" stays 06:00 across a DST change. Wall time is turned into an
// instant with Intl (no library). The two DST edges are defined, and pinned by
// scripts/test-pipelinesCron.ts:
//   • spring forward — a wall time inside the skipped hour runs at the first
//     instant after the gap (02:30 on the skipped night runs at 03:30), so a
//     daily job never loses a day;
//   • fall back — a wall time that happens twice runs ONCE, at the first
//     occurrence; the repeat hour does not run it again.
//
// `nextCronRun(expr, tz, from)` is the whole rule: the first instant STRICTLY
// after `from` that the schedule names, or null when it names none within five
// years (e.g. "0 0 31 2 *").

export interface Cron {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  dayStar: boolean;
  weekdayStar: boolean;
}

const RANGES: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function field(src: string, [lo, hi]: [number, number]): number[] | null {
  const out = new Set<number>();
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    let a = lo;
    let b = hi;
    if (m[1] !== '*') {
      const [x, y] = m[1].split('-').map(Number);
      a = x;
      b = y === undefined ? (m[2] ? hi : x) : y;
    }
    const step = m[2] ? Number(m[2]) : 1;
    if (a < lo || b > hi || a > b || step < 1) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return [...out].sort((p, q) => p - q);
}

/** Parse a five-field expression, or null when it is not one. */
export function parseCron(expr: unknown): Cron | null {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const f = parts.map((p, i) => field(p, RANGES[i]));
  if (f.some((x) => !x || !x.length)) return null;
  const [minutes, hours, days, months, weekdays] = f as number[][];
  return {
    minutes, hours,
    days: new Set(days), months: new Set(months),
    weekdays: new Set(weekdays.map((d) => d % 7)),
    dayStar: parts[2] === '*', weekdayStar: parts[4] === '*',
  };
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Is this an IANA zone Intl knows? */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { fmt(tz); return true; } catch (_) { return false; }
}

interface Wall { y: number; mo: number; d: number; h: number; mi: number }

/** The wall clock in `tz` at instant `t`. */
export function wallAt(t: number, tz: string): Wall {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(t))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute };
}

/** Offset of `tz` from UTC at instant `t`, in ms (local = utc + offset). */
function offsetAt(t: number, tz: string): number {
  const w = wallAt(t, tz);
  // Every real offset is whole minutes, so the wall minute is the floored one.
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(t / 60_000) * 60_000;
}

/** The instant a wall time names in `tz`, with the DST rules in the header. */
export function wallToInstant(w: Wall, tz: string): number {
  const t = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  const before = offsetAt(t - 12 * 3600_000, tz);
  const after = offsetAt(t + 12 * 3600_000, tz);
  const fits = [t - before, t - after].filter((u) => {
    const g = wallAt(u, tz);
    return g.y === w.y && g.mo === w.mo && g.d === w.d && g.h === w.h && g.mi === w.mi;
  });
  // Twice (fall back): the first. Never (spring forward): the pre-gap offset,
  // which lands the same distance past the gap.
  return fits.length ? Math.min(...fits) : t - before;
}

const MAX_DAYS = 366 * 5;

export function nextCronRun(expr: unknown, tz: string, from: number): number | null {
  const c = parseCron(expr);
  if (!c || !isValidTimeZone(tz) || !Number.isFinite(from)) return null;
  const start = wallAt(from, tz);
  for (let i = 0; i < MAX_DAYS; i += 1) {
    const day = new Date(Date.UTC(start.y, start.mo - 1, start.d + i));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (!c.months.has(mo)) continue;
    const domOk = c.days.has(d);
    const dowOk = c.weekdays.has(day.getUTCDay());
    const dayOk = c.dayStar && c.weekdayStar ? true
      : c.dayStar ? dowOk
        : c.weekdayStar ? domOk
          : domOk || dowOk;
    if (!dayOk) continue;
    for (const h of c.hours) {
      // A whole hour already behind `from` on the first day: skip its minutes.
      if (i === 0 && h < start.h - 1) continue;
      for (const mi of c.minutes) {
        const t = wallToInstant({ y, mo, d, h, mi }, tz);
        if (t > from) return t;
      }
    }
  }
  return null;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** "Every day at 06:00", "Weekdays at 07:30", "Every hour at :15" — or the expression itself. */
export function describeCron(expr: unknown): string {
  const c = parseCron(expr);
  if (!c) return 'Not a valid schedule';
  const raw = String(expr).trim().split(/\s+/);
  const oneTime = c.minutes.length === 1 && c.hours.length === 1 && !raw[1].includes('*');
  const at = oneTime ? `${pad(c.hours[0])}:${pad(c.minutes[0])}` : '';
  const anyDay = c.dayStar && c.weekdayStar && raw[3] === '*';
  if (raw[1] === '*' && c.minutes.length === 1 && anyDay) return `Every hour at :${pad(c.minutes[0])}`;
  if (!oneTime) return raw.join(' ');
  if (anyDay) return `Every day at ${at}`;
  if (c.dayStar && raw[3] === '*') {
    const wd = [...c.weekdays].sort();
    if (wd.join() === '1,2,3,4,5') return `Weekdays at ${at}`;
    if (wd.length === 1) return `Every ${DAY_NAMES[wd[0]]} at ${at}`;
  }
  if (c.weekdayStar && raw[3] === '*' && c.days.size === 1) return `Day ${[...c.days][0]} of each month at ${at}`;
  return raw.join(' ');
}
