// Bundled holiday calendars — MAIN PROCESS, read-only, no network.
//
// Six static files under ./holidays/ (US, UK, IN, DE, FR, JP), 2015–2035, each
// `{ code, name, note, from, to, days: [[iso, name], …] }`. They were generated
// once by computed rules — fixed dates, nth-weekday rules, Easter by the
// Gregorian computus, Japan's equinoxes by the standard formula plus its
// substitute and in-between holidays — and checked in as data. What a rule
// cannot know is said in each file's `note`: India's Holi and Diwali are
// lunar and listed only for 2015–2026; one-off days (a coronation, a state
// funeral) are listed only for years already past when the files were made.
//
// A project opts in per calendar on the Events page; an enabled calendar
// contributes 'holiday' events that are never stored, so a calendar fix ships
// with the app rather than living in every project.

import * as fs from 'fs';
import * as path from 'path';
import type { ProjectEvent } from './events';

export const CALENDARS: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'US', name: 'United States' },
  { code: 'UK', name: 'United Kingdom' },
  { code: 'IN', name: 'India' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'JP', name: 'Japan' },
];
const CODES: ReadonlySet<string> = new Set(CALENDARS.map((c) => c.code));

export interface HolidayFile { code: string; name: string; note: string; from: number; to: number; days: Array<[string, string]> }

const cache = new Map<string, HolidayFile | null>();

/** One calendar's file, or null when the code is unknown or the file unreadable. */
export function loadCalendar(code: string): HolidayFile | null {
  if (!CODES.has(code)) return null;
  if (!cache.has(code)) {
    let file: HolidayFile | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'holidays', code + '.json'), 'utf8'));
      if (raw && Array.isArray(raw.days)) file = raw as HolidayFile;
    } catch (_) { file = null; }
    cache.set(code, file);
  }
  return cache.get(code) || null;
}

/** Keep only calendar codes the app ships, once each, in the app's order. */
export function sanitizeCalendars(raw: unknown): string[] {
  const want = new Set(Array.isArray(raw) ? raw.map(String) : []);
  return CALENDARS.map((c) => c.code).filter((c) => want.has(c));
}

/** The enabled calendars' holidays as events, titled "Thanksgiving Day (US)". */
export function holidayEvents(codes: string[]): ProjectEvent[] {
  const out: ProjectEvent[] = [];
  for (const code of sanitizeCalendars(codes)) {
    const f = loadCalendar(code);
    for (const [date, name] of f ? f.days : []) {
      out.push({ id: `holiday-${code}-${date}-${out.length}`, date, title: `${name} (${code})`, kind: 'holiday', calendar: code });
    }
  }
  return out;
}
