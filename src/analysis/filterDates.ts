// TYPED FILTERS — the date half of the grammar. PURE (no fs / DOM,
// and no clock: `today` is always passed in).
//
// "last quarter", "since March", "Q3 2023", "before 2024" → a PeriodSpec, the
// same object a date-range control stores, so a typed date is evaluated by
// dateIntel.resolvePeriod exactly like a picked one. A phrase that has a
// preset (Last quarter, Year to date, Last 30 days …) BECOMES that preset and
// stays relative; anything else becomes a `custom` {from,to} fixed on `today`.
//
// Anchors, all against `today`, never the machine clock:
//   "March"      the most recent March that has STARTED (this year's if we are
//                in or past March, else last year's)
//   "Q3"         the most recent fiscal Q3 that has started
//   "Q3 2023"    the fiscal Q3 that STARTS in calendar 2023. That one rule
//                reads right under every common naming: January years give
//                Jul–Sep 2023; a July fiscal year (named by its end) gives
//                Jan–Mar 2023, its FY2023 Q3; an April one gives Oct–Dec 2023.
//   "2024"       the whole calendar year
//   "since X"    from the first day of X to today ("from X" reads the same)
//   "before X"   up to the day before X starts;  "after X" from the day after it ends
//
// Words arrive already normalised (lower case, accents and edge punctuation
// stripped) by filterParse.ts.

import { daysFromCivil, civilFromDays } from './categoryKey';
import { daysFromIso, describePeriod, isoFromDays } from './dateIntel';
import type { CalendarPrefs, PeriodPreset, PeriodSpec } from './dateIntel';

export interface DateMatch {
  /** How many words the phrase used. */
  used: number;
  spec: PeriodSpec;
  label: string;
}

type Unit = 'day' | 'week' | 'month' | 'quarter' | 'year';
const UNITS: readonly Unit[] = ['day', 'week', 'month', 'quarter', 'year'];

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "days", "month", "quar" (a prefix of 3+ letters, so a half-typed word still reads) → the unit. */
function unitOf(w: string | undefined): Unit | null {
  if (!w) return null;
  const s = w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w;
  for (const u of UNITS) if (s === u || (s.length >= 3 && u.startsWith(s))) return u;
  return null;
}

/** A month word → 1–12. Full names always; three-letter forms (and "sept") only when `loose`. */
function monthOf(w: string | undefined, loose: boolean): number | null {
  if (!w) return null;
  const full = MONTHS.indexOf(w);
  if (full >= 0) return full + 1;
  if (!loose) return null;
  if (w === 'sept') return 9;
  const short = w.length === 3 ? MONTHS.findIndex((m) => m.startsWith(w)) : -1;
  return short >= 0 ? short + 1 : null;
}

function yearOf(w: string | undefined): number | null {
  return w && /^(19|20|21)\d{2}$/.test(w) ? Number(w) : null;
}

function fmt(iso: string): string {
  const c = civilFromDays(daysFromIso(iso) as number);
  return `${SHORT[c.m - 1]} ${c.d}, ${c.y}`;
}

/** The first day of month `m` of year `y` shifted by `k` months, as an epoch day. */
function monthDay(y: number, m: number, k = 0): number {
  const idx = y * 12 + (m - 1) + k;
  const yy = Math.floor(idx / 12);
  return daysFromCivil(yy, idx - yy * 12 + 1, 1);
}

interface Ref { used: number; from: string; to: string; title: string }

/** A span of months starting at (y, m) → inclusive ISO bounds. */
function months(y: number, m: number, count: number, title: string, used: number): Ref {
  return { used, from: isoFromDays(monthDay(y, m)), to: isoFromDays(monthDay(y, m, count) - 1), title };
}

/**
 * A point or span in time: an ISO date, a year, a quarter, or a month, each
 * with an optional year after it. `loose` admits three-letter month names,
 * which alone would read ordinary words ("mar", "jun") as dates.
 */
function dateRef(w: string[], i: number, today: string, cal: CalendarPrefs, loose: boolean): Ref | null {
  const tDay = daysFromIso(today) as number;
  const t = civilFromDays(tDay);
  const word = w[i];
  if (!word) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(word) && daysFromIso(word) !== null) {
    return { used: 1, from: word, to: word, title: fmt(word) };
  }
  const q = /^q([1-4])$/.exec(word);
  if (q) {
    const k = Number(q[1]);
    const m = ((cal.fiscalYearStart - 1 + 3 * (k - 1)) % 12) + 1; // the month fiscal Qk starts in
    const fiscal = cal.fiscalYearStart !== 1 ? 'Fiscal ' : '';
    const y = yearOf(w[i + 1]);
    if (y !== null) return months(y, m, 3, `${fiscal}Q${k} ${y}`, 2);
    const start = monthDay(t.y, m) <= tDay ? t.y : t.y - 1;
    return months(start, m, 3, `${fiscal}Q${k} ${start}`, 1);
  }
  const mo = monthOf(word, loose || yearOf(w[i + 1]) !== null);
  if (mo !== null) {
    const name = MONTHS[mo - 1].charAt(0).toUpperCase() + MONTHS[mo - 1].slice(1);
    const y = yearOf(w[i + 1]);
    if (y !== null) return months(y, mo, 1, `${name} ${y}`, 2);
    const start = mo <= t.m ? t.y : t.y - 1;
    return months(start, mo, 1, `${name} ${start}`, 1);
  }
  const y = yearOf(word);
  if (y !== null) return months(y, 1, 12, String(y), 1);
  return null;
}

function preset(p: PeriodPreset, used: number, cal: CalendarPrefs, n?: number): DateMatch {
  const spec: PeriodSpec = n === undefined ? { preset: p } : { preset: p, n };
  return { used, spec, label: describePeriod(spec, cal) };
}

function custom(from: string | undefined, to: string | undefined, label: string, used: number): DateMatch {
  const spec: PeriodSpec = { preset: 'custom' };
  if (from) spec.from = from;
  if (to) spec.to = to;
  return { used, spec, label };
}

const LAST = new Set(['last', 'past', 'previous', 'prior']);
const THIS = new Set(['this', 'current']);

/** The date phrase starting at word `i`, or null. Longest reading wins. */
export function matchDate(w: string[], i: number, today: string, cal: CalendarPrefs): DateMatch | null {
  const t = daysFromIso(today);
  if (t === null) return null;
  const a = w[i];
  const b = w[i + 1];
  if (!a) return null;

  if (a === 'today') return preset('today', 1, cal);
  if (a === 'yesterday') return preset('yesterday', 1, cal);
  if (a === 'ytd') return preset('ytd', 1, cal);
  if (a === 'qtd') return preset('qtd', 1, cal);
  // Month to date has no preset: a fixed range, first of this month → today.
  const monthStart = (): string => { const c = civilFromDays(t); return isoFromDays(daysFromCivil(c.y, c.m, 1)); };
  if (a === 'mtd') return custom(monthStart(), today, 'Month to date', 1);
  if (b === 'to' && w[i + 2] === 'date') {
    if (a === 'year') return preset('ytd', 3, cal);
    if (a === 'quarter') return preset('qtd', 3, cal);
    if (a === 'month') return custom(monthStart(), today, 'Month to date', 3);
  }

  if (LAST.has(a)) {
    // "last 30 days", "past 6 months"
    if (b && /^\d{1,4}$/.test(b) && Number(b) >= 1) {
      const u = unitOf(w[i + 2]);
      if (u) return preset(`last_n_${u}s` as PeriodPreset, 3, cal, Math.min(Number(b), 3660));
    }
    const u = unitOf(b);
    if (u === 'day') return preset('yesterday', 2, cal);
    if (u) return preset(`last_${u}` as PeriodPreset, 2, cal);
  }
  if (THIS.has(a)) {
    const u = unitOf(b);
    if (u === 'day') return preset('today', 2, cal);
    if (u) return preset(`this_${u}` as PeriodPreset, 2, cal);
  }

  if (a === 'since' || a === 'from' || a === 'before' || a === 'after') {
    const r = dateRef(w, i + 1, today, cal, true);
    if (!r) return null;
    if (a === 'since' || a === 'from') return custom(r.from, today, `Since ${fmt(r.from)}`, r.used + 1);
    if (a === 'before') {
      const to = isoFromDays((daysFromIso(r.from) as number) - 1);
      return custom(undefined, to, `Before ${fmt(r.from)}`, r.used + 1);
    }
    const from = isoFromDays((daysFromIso(r.to) as number) + 1);
    return custom(from, undefined, `After ${fmt(r.to)}`, r.used + 1);
  }

  const r = dateRef(w, i, today, cal, false);
  return r ? custom(r.from, r.to, r.from === r.to ? r.title : `${r.title} · ${fmt(r.from)} – ${fmt(r.to)}`, r.used) : null;
}
