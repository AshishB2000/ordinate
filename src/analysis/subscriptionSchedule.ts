// A subscription's schedule and its DUE CHECK — pure, `now` passed in.
//
// The shape is reportSpec's ReportSchedule (`cadence` + `at`, "HH:MM") with the
// two things a scheduled send needs that a report on one desktop did not: WHICH
// days (weekdays, chosen weekdays, a day of the month, every hour) and WHOSE
// clock (an IANA time zone — the server's own zone is a pod's accident). The
// rule is still reportSpec.scheduleDue's two gates, restated over slots:
//
//   time-of-day gate   a SLOT is one scheduled instant: the schedule's `at`, on
//                      a day the cadence names, read in the time zone.
//   interval gate      a slot is handled ONCE: `lastSlot` is stamped before
//                      anything is sent, and a slot at or before it (or before
//                      `since`, when the schedule was last set) is never due.
//
// LATE AND MISSED. The server may have been down at the slot's minute. On
// return the newest slot is sent once if it is less than LATE_MS old, and
// recorded as missed otherwise — never a burst of every slot that went by.
//
// DST. A slot is found by asking Intl what the zone's wall clock reads, so
// "08:00 in New York" stays 08:00 across both changes. A wall time that does
// not exist (02:30 on the spring day) runs once, the gap's length later on the
// clock (03:30); one that happens twice (01:30 on the autumn day) runs the
// first time only.
// Intl is the whole dependency: no time zone library.

import { sanitizeTimeOfDay } from './reportSpec';

export type SubCadence = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface SubSchedule {
  cadence: SubCadence;
  /** "HH:MM" in the subscription's time zone. Hourly uses the minute only. */
  at: string;
  /** `weekly`: the days it runs, 0 = Sunday … 6 = Saturday. */
  days?: number[];
  /** `monthly`: the day of the month, 1–31; a shorter month runs on its last day. */
  dayOfMonth?: number;
}

export const CADENCES: readonly SubCadence[] = ['hourly', 'daily', 'weekdays', 'weekly', 'monthly'];

/** A slot this old is recorded as missed instead of sent. */
export const LATE_MS = 6 * 60 * 60 * 1000;

const MINUTE = 60_000;

export function sanitizeSubSchedule(raw: unknown): SubSchedule {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const cadence = (CADENCES as readonly unknown[]).includes(o.cadence) ? (o.cadence as SubCadence) : 'daily';
  const s: SubSchedule = { cadence, at: sanitizeTimeOfDay(o.at) };
  if (cadence === 'weekly') {
    const days = [...new Set((Array.isArray(o.days) ? o.days : []).filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
    s.days = days.length ? days : [1];
  }
  if (cadence === 'monthly') {
    const d = Number(o.dayOfMonth);
    s.dayOfMonth = Number.isInteger(d) && d >= 1 && d <= 31 ? d : 1;
  }
  return s;
}

const formatters = new Map<string, Intl.DateTimeFormat>(); // by zone name — not org data

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    formatters.set(tz, f);
  }
  return f;
}

/** Is `tz` a zone this runtime's Intl knows? */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

export function sanitizeTimeZone(raw: unknown): string {
  return isTimeZone(raw) ? raw : 'UTC';
}

interface Wall { y: number; m: number; d: number; h: number; mi: number }

/** The zone's wall clock at instant `ms`. */
export function wallClock(ms: number, tz: string): Wall {
  const out: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return { y: out.year, m: out.month, d: out.day, h: out.hour, mi: out.minute };
}

const asUtc = (w: Wall): number => Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);

/** The instant the zone's wall clock reads `w` — see DST in the header for a time that is skipped or repeated. */
export function zonedToUtc(w: Wall, tz: string): number {
  const want = asUtc(w);
  const offsetAt = (t: number): number => asUtc(wallClock(t, tz)) - t;
  const a = want - offsetAt(want);
  const b = want - offsetAt(a);
  const hits = [a, b].filter((t) => asUtc(wallClock(t, tz)) === want);
  return hits.length ? Math.min(...hits) : Math.max(a, b);
}

function runsOn(s: SubSchedule, y: number, m: number, d: number): boolean {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  switch (s.cadence) {
    case 'weekdays': return dow >= 1 && dow <= 5;
    case 'weekly': return (s.days ?? [1]).includes(dow);
    case 'monthly': return d === Math.min(s.dayOfMonth ?? 1, new Date(Date.UTC(y, m, 0)).getUTCDate());
    default: return true;
  }
}

/** The schedule's slot on the wall date `offset` days from `now`'s, or null when it does not run that day. */
function slotOnDay(s: SubSchedule, tz: string, now: number, offset: number): number | null {
  const today = wallClock(now, tz);
  const day = new Date(Date.UTC(today.y, today.m - 1, today.d + offset));
  const [y, m, d] = [day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()];
  if (!runsOn(s, y, m, d)) return null;
  const [h, mi] = s.at.split(':').map(Number);
  return zonedToUtc({ y, m, d, h, mi }, tz);
}

/** The newest slot at or before `now`, or null (a schedule always has one within two months). */
export function previousSlot(s: SubSchedule, tz: string, now: number): number | null {
  if (s.cadence === 'hourly') {
    const minute = Number(s.at.split(':')[1]);
    const floor = Math.floor(now / MINUTE) * MINUTE;
    return floor - ((wallClock(now, tz).mi - minute + 60) % 60) * MINUTE;
  }
  for (let back = 0; back <= 62; back++) {
    const slot = slotOnDay(s, tz, now, -back);
    if (slot !== null && slot <= now) return slot;
  }
  return null;
}

/** The next `n` slots strictly after `now`, oldest first. */
export function nextSlots(s: SubSchedule, tz: string, now: number, n = 3): number[] {
  const out: number[] = [];
  if (s.cadence === 'hourly') {
    const prev = previousSlot(s, tz, now) as number;
    for (let k = 1; out.length < n; k++) out.push(prev + k * 60 * MINUTE);
    return out;
  }
  // ponytail: a day-by-day walk, at most 400 Intl reads; a closed form per cadence if this is ever hot.
  for (let ahead = 0; ahead <= 400 && out.length < n; ahead++) {
    const slot = slotOnDay(s, tz, now, ahead);
    if (slot !== null && slot > now) out.push(slot);
  }
  return out;
}

export type Due = { kind: 'none' } | { kind: 'send' | 'missed'; slot: number };

const stamp = (v: string | undefined): number => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};

/**
 * What to do with a subscription at `now` — the whole scheduling rule. `since`
 * is when the schedule was last set or switched on: a slot before it belongs to
 * a schedule that did not exist yet. An unparseable `lastSlot` reads as "never
 * ran" (reportSpec.scheduleDue's self-healing rule), so a corrupt stamp cannot
 * switch a schedule off for good.
 */
export function dueDecision(sub: { schedule: SubSchedule; timezone: string; lastSlot?: string; since?: string }, now: number): Due {
  const slot = previousSlot(sub.schedule, sanitizeTimeZone(sub.timezone), now);
  if (slot === null || slot <= Math.max(stamp(sub.lastSlot), stamp(sub.since))) return { kind: 'none' };
  return { kind: now - slot < LATE_MS ? 'send' : 'missed', slot };
}
