// Self-check for the BUNDLED HOLIDAY CALENDARS (src/analysis/holidays/*.json,
// read by src/analysis/holidays.ts): every file parses, covers 2015–2035, holds
// real dates in order, stays small — and a handful of anchors a reader can
// check against any calendar are where the rules put them.
//
//   npm run build:ts && node scripts/test-eventsHolidays.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const H: typeof import('../src/analysis/holidays') = require('../src/analysis/holidays');
const { daysFromIso }: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');

const dir = path.join(__dirname, '..', 'src', 'analysis', 'holidays');
const has = (code: string, date: string, name: string): boolean => {
  const f = H.loadCalendar(code);
  return !!f && f.days.some(([d, n]) => d === date && n === name);
};

// ── 1. Integrity, file by file ───────────────────────────────────────────────
ok('every bundled calendar has a file, and no file is unlisted',
  JSON.stringify(fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) === JSON.stringify(H.CALENDARS.map((c) => c.code + '.json').sort()));
for (const { code, name } of H.CALENDARS) {
  const file = path.join(dir, code + '.json');
  let raw: any = null; // any: parsed JSON under test
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { raw = null; }
  ok(`${code}: parses`, !!raw && Array.isArray(raw.days));
  if (!raw) continue;
  ok(`${code}: names itself and says what it leaves out`, raw.code === code && raw.name === name && typeof raw.note === 'string' && raw.note.length > 20);
  ok(`${code}: covers 2015 to 2035`, raw.from === 2015 && raw.to === 2035);
  const years = new Map<number, number>();
  let valid = true;
  let sorted = true;
  let prev = '';
  for (const d of raw.days) {
    if (!Array.isArray(d) || d.length !== 2 || daysFromIso(d[0]) === null || typeof d[1] !== 'string' || !d[1].trim()) valid = false;
    if (String(d[0]) < prev) sorted = false;
    prev = String(d[0]);
    const y = Number(String(d[0]).slice(0, 4));
    years.set(y, (years.get(y) || 0) + 1);
  }
  ok(`${code}: every entry is a real ISO date with a name`, valid);
  ok(`${code}: in date order`, sorted);
  let everyYear = true;
  for (let y = 2015; y <= 2035; y++) if ((years.get(y) || 0) < 3) everyYear = false;
  ok(`${code}: every year 2015–2035 present, nothing outside`, everyYear && [...years.keys()].every((y) => y >= 2015 && y <= 2035));
  ok(`${code}: small (under 24 KB)`, fs.statSync(file).size < 24_000);
}

// ── 2. Anchors ───────────────────────────────────────────────────────────────
ok('US: Thanksgiving 2024 is Nov 28 (4th Thursday)', has('US', '2024-11-28', 'Thanksgiving Day'));
ok('US: Juneteenth only from 2021', has('US', '2021-06-19', 'Juneteenth') && !H.loadCalendar('US')!.days.some(([d, n]) => n === 'Juneteenth' && d < '2021'));
ok('UK: Easter Monday 2025 is Apr 21 (computus)', has('UK', '2025-04-21', 'Easter Monday'));
ok('UK: Christmas 2021 on a Saturday moves to Mon 27, Boxing Day to Tue 28', has('UK', '2021-12-27', 'Christmas Day') && has('UK', '2021-12-28', 'Boxing Day'));
ok('UK: the 2022 state funeral is listed', has('UK', '2022-09-19', 'State Funeral of Queen Elizabeth II'));
ok('DE: Ascension 2024 is May 9 (Easter + 39)', has('DE', '2024-05-09', 'Christi Himmelfahrt'));
ok('FR: Bastille Day 2030', has('FR', '2030-07-14', 'Fête nationale'));
ok('JP: Vernal Equinox Day 2024 is Mar 20', has('JP', '2024-03-20', 'Vernal Equinox Day'));
ok('JP: a Sunday holiday gets a substitute (Feb 11 2024 → Feb 12)', has('JP', '2024-02-12', 'Substitute Holiday'));
ok('JP: a day between two holidays is one (Sep 22 2026)', has('JP', '2026-09-22', "Citizens' Holiday"));
ok('IN: Republic Day every year', H.loadCalendar('IN')!.days.filter(([, n]) => n === 'Republic Day').length === 21);
ok('IN: Diwali is listed only for years it was known', has('IN', '2024-10-31', 'Diwali') && !H.loadCalendar('IN')!.days.some(([d, n]) => n === 'Diwali' && d > '2027'));

// ── 3. As events ─────────────────────────────────────────────────────────────
const evs = H.holidayEvents(['JP', 'XX', 'US']);
ok('calendars: unknown codes are dropped, the app\'s order kept', JSON.stringify(H.sanitizeCalendars(['JP', 'XX', 'US', 'US'])) === '["US","JP"]');
ok('calendars: each holiday is a holiday event titled with its country', evs.length === H.loadCalendar('US')!.days.length + H.loadCalendar('JP')!.days.length
  && evs.every((e) => e.kind === 'holiday' && /\((US|JP)\)$/.test(e.title) && !e.end) && evs.some((e) => e.title === 'Thanksgiving Day (US)' && e.date === '2024-11-28'));
ok('calendars: ids are unique', new Set(evs.map((e) => e.id)).size === evs.length);

finish();
