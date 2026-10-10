// A subscription's schedule (src/analysis/subscriptionSchedule.ts) — pure, every
// `now` passed in.
//
//   slots      each cadence's previous and next slots, in a time zone that is
//              not the machine's (the suite pins nothing on TZ)
//   zones      08:00 in Tokyo, Kolkata (a :30 offset), New York and UTC are
//              four different instants; hourly keeps the zone's own minute
//   DST        New York across both changes: the wall time holds; 02:30 on the
//              spring day runs ONCE (03:30), 01:30 on the autumn day ONCE
//   due        a slot is due once; an edit or a re-enable (`since`) never fires
//              for a slot that already passed; a corrupt stamp heals
//   late       under six hours late → send; six or more → missed; a long
//              outage is ONE decision, never a burst
//   controls   a negative control per guard (see each)
//
//   npm run build:ts && node scripts/test-subscriptionSchedule.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const S: typeof import('../src/analysis/subscriptionSchedule') = require('../src/analysis/subscriptionSchedule');
const text: typeof import('../src/analysis/subscriptionText') = require('../src/analysis/subscriptionText');

const utc = (iso: string): number => Date.parse(iso);
const at = (ms: number | null): string => (ms === null ? 'null' : new Date(ms).toISOString());
const H = 3_600_000;

// ── sanitizers ──────────────────────────────────────────────────────────────
ok('sanitize: junk becomes daily 09:00', JSON.stringify(S.sanitizeSubSchedule({ cadence: 'yearly', at: '25:99' })) === '{"cadence":"daily","at":"09:00"}');
ok('sanitize: weekly days are deduplicated, sorted, bounded; none → Monday',
  JSON.stringify(S.sanitizeSubSchedule({ cadence: 'weekly', at: '8:05', days: [5, 1, 1, 9, -1, 2.5] })) === '{"cadence":"weekly","at":"08:05","days":[1,5]}'
  && JSON.stringify(S.sanitizeSubSchedule({ cadence: 'weekly', at: '08:00', days: [] }).days) === '[1]');
ok('sanitize: a day of month outside 1–31 becomes the 1st', S.sanitizeSubSchedule({ cadence: 'monthly', at: '08:00', dayOfMonth: 40 }).dayOfMonth === 1);
ok('time zones: IANA names are known; nonsense and an injection are not',
  S.isTimeZone('Europe/Berlin') && S.isTimeZone('Asia/Kolkata') && !S.isTimeZone('Mars/Olympus') && !S.isTimeZone('') && !S.isTimeZone('UTC; DROP') && S.sanitizeTimeZone('nope') === 'UTC');

// ── zones ───────────────────────────────────────────────────────────────────
const daily8 = S.sanitizeSubSchedule({ cadence: 'daily', at: '08:00' });
const noon = utc('2026-10-12T12:00:00Z'); // a Monday
ok('daily 08:00 UTC: the previous slot is today 08:00Z', at(S.previousSlot(daily8, 'UTC', noon)) === '2026-10-12T08:00:00.000Z');
ok('daily 08:00 Tokyo (UTC+9): yesterday 23:00Z', at(S.previousSlot(daily8, 'Asia/Tokyo', noon)) === '2026-10-11T23:00:00.000Z');
ok('daily 08:00 Kolkata (UTC+5:30): 02:30Z', at(S.previousSlot(daily8, 'Asia/Kolkata', noon)) === '2026-10-12T02:30:00.000Z');
ok('daily 08:00 New York (EDT, UTC−4): 12:00Z — due exactly at its minute', at(S.previousSlot(daily8, 'America/New_York', noon)) === '2026-10-12T12:00:00.000Z');
ok('daily 08:00 New York one minute earlier: still yesterday\'s', at(S.previousSlot(daily8, 'America/New_York', noon - 60_000)) === '2026-10-11T12:00:00.000Z');
ok('next three daily slots, oldest first', S.nextSlots(daily8, 'UTC', noon).map(at).join() === '2026-10-13T08:00:00.000Z,2026-10-14T08:00:00.000Z,2026-10-15T08:00:00.000Z');

const hourly = S.sanitizeSubSchedule({ cadence: 'hourly', at: '00:15' });
ok('hourly at :15 UTC', at(S.previousSlot(hourly, 'UTC', utc('2026-10-12T12:14:59Z'))) === '2026-10-12T11:15:00.000Z' && at(S.previousSlot(hourly, 'UTC', utc('2026-10-12T12:15:00Z'))) === '2026-10-12T12:15:00.000Z');
ok('hourly at :15 in Kolkata is :45 UTC (the zone\'s own minute)', at(S.previousSlot(hourly, 'Asia/Kolkata', utc('2026-10-12T12:50:00Z'))) === '2026-10-12T12:45:00.000Z');
ok('hourly: the next three are an hour apart', S.nextSlots(hourly, 'UTC', utc('2026-10-12T12:20:00Z')).map(at).join() === '2026-10-12T13:15:00.000Z,2026-10-12T14:15:00.000Z,2026-10-12T15:15:00.000Z');

// ── cadences ────────────────────────────────────────────────────────────────
const weekdays = S.sanitizeSubSchedule({ cadence: 'weekdays', at: '08:00' });
const sat = utc('2026-10-17T12:00:00Z');
ok('weekdays: on Saturday the previous slot is Friday', at(S.previousSlot(weekdays, 'UTC', sat)) === '2026-10-16T08:00:00.000Z');
ok('weekdays: the next three skip the weekend', S.nextSlots(weekdays, 'UTC', sat).map(at).join() === '2026-10-19T08:00:00.000Z,2026-10-20T08:00:00.000Z,2026-10-21T08:00:00.000Z');
ok('weekdays follow the ZONE\'s day: Friday 23:30 in Los Angeles is Saturday in UTC, and still runs',
  at(S.previousSlot(S.sanitizeSubSchedule({ cadence: 'weekdays', at: '23:30' }), 'America/Los_Angeles', utc('2026-10-17T12:00:00Z'))) === '2026-10-17T06:30:00.000Z');
const monWed = S.sanitizeSubSchedule({ cadence: 'weekly', at: '09:30', days: [1, 3] });
ok('weekly Mon + Wed', S.nextSlots(monWed, 'UTC', noon).map(at).join() === '2026-10-14T09:30:00.000Z,2026-10-19T09:30:00.000Z,2026-10-21T09:30:00.000Z');
const m31 = S.sanitizeSubSchedule({ cadence: 'monthly', at: '06:00', dayOfMonth: 31 });
ok('monthly on the 31st: a shorter month runs on its last day (28 Feb, 30 Apr), a leap February on the 29th',
  S.nextSlots(m31, 'UTC', utc('2027-01-31T07:00:00Z')).map(at).join() === '2027-02-28T06:00:00.000Z,2027-03-31T06:00:00.000Z,2027-04-30T06:00:00.000Z'
  && at(S.nextSlots(m31, 'UTC', utc('2028-02-01T00:00:00Z'), 1)[0]) === '2028-02-29T06:00:00.000Z');
ok('monthly: the previous slot reaches back across a month', at(S.previousSlot(S.sanitizeSubSchedule({ cadence: 'monthly', at: '06:00', dayOfMonth: 15 }), 'UTC', utc('2026-10-14T00:00:00Z'))) === '2026-09-15T06:00:00.000Z');

// ── DST (New York: 8 Mar 2026 02:00 → 03:00, 1 Nov 2026 02:00 → 01:00) ──────
const ny = 'America/New_York';
ok('DST: 08:00 New York is 13:00Z in winter and 12:00Z in summer — the wall time holds',
  at(S.previousSlot(daily8, ny, utc('2026-03-07T20:00:00Z'))) === '2026-03-07T13:00:00.000Z' && at(S.previousSlot(daily8, ny, utc('2026-03-08T20:00:00Z'))) === '2026-03-08T12:00:00.000Z'
  && at(S.previousSlot(daily8, ny, utc('2026-11-01T20:00:00Z'))) === '2026-11-01T13:00:00.000Z');
const gap = S.sanitizeSubSchedule({ cadence: 'daily', at: '02:30' });
const springDay = S.nextSlots(gap, ny, utc('2026-03-07T12:00:00Z'), 2).map(at);
ok('DST: 02:30 does not exist on the spring day — it runs ONCE, at 03:30 EDT, and the day after at 02:30 again',
  springDay.join() === '2026-03-08T07:30:00.000Z,2026-03-09T06:30:00.000Z', springDay.join());
const twice = S.sanitizeSubSchedule({ cadence: 'daily', at: '01:30' });
const autumn = S.nextSlots(twice, ny, utc('2026-10-31T12:00:00Z'), 2).map(at);
ok('DST: 01:30 happens twice on the autumn day — it runs the FIRST time only', autumn.join() === '2026-11-01T05:30:00.000Z,2026-11-02T06:30:00.000Z', autumn.join());
ok('DST: between the two 01:30s the slot is already behind us (no second send)', at(S.previousSlot(twice, ny, utc('2026-11-01T06:31:00Z'))) === '2026-11-01T05:30:00.000Z');
const hourlyAcross = S.nextSlots(hourly, ny, utc('2026-03-08T05:20:00Z'), 3).map(at);
ok('DST: hourly never skips or doubles an hour across the change', hourlyAcross.join() === '2026-03-08T06:15:00.000Z,2026-03-08T07:15:00.000Z,2026-03-08T08:15:00.000Z', hourlyAcross.join());

// ── due, late, missed ───────────────────────────────────────────────────────
const sub = (o: { lastSlot?: string; since?: string } = {}) => ({ schedule: daily8, timezone: 'UTC', ...o });
const since = '2026-10-01T00:00:00.000Z';
const d1 = S.dueDecision(sub({ since }), utc('2026-10-12T08:00:30Z'));
ok('due: at its minute → send, for that slot', d1.kind === 'send' && at(d1.slot) === '2026-10-12T08:00:00.000Z');
ok('due: once the slot is stamped it is not due again', S.dueDecision(sub({ since, lastSlot: '2026-10-12T08:00:00.000Z' }), utc('2026-10-12T08:05:00Z')).kind === 'none');
ok('due: …until the next slot', S.dueDecision(sub({ since, lastSlot: '2026-10-12T08:00:00.000Z' }), utc('2026-10-13T08:00:00Z')).kind === 'send');
ok('due: before the first slot there is nothing to do', S.dueDecision(sub({ since: '2026-10-12T07:00:00.000Z' }), utc('2026-10-12T07:59:00Z')).kind === 'none');
ok('due: made at 10:00 for 08:00 — today\'s slot passed before it existed, so the first send is tomorrow',
  S.dueDecision(sub({ since: '2026-10-12T10:00:00.000Z' }), utc('2026-10-12T10:01:00Z')).kind === 'none'
  && S.dueDecision(sub({ since: '2026-10-12T10:00:00.000Z' }), utc('2026-10-13T08:00:00Z')).kind === 'send');
ok('NEGATIVE CONTROL: without `since` the same subscription WOULD fire for the slot it missed by being created late',
  S.dueDecision({ schedule: daily8, timezone: 'UTC' }, utc('2026-10-12T10:01:00Z')).kind === 'send');
ok('due: a corrupt lastSlot reads as "never ran" — it cannot switch the schedule off', S.dueDecision(sub({ since, lastSlot: 'not a date' }), utc('2026-10-12T08:01:00Z')).kind === 'send');
ok('due: an unknown time zone falls back to UTC rather than throwing', S.dueDecision({ schedule: daily8, timezone: 'Nowhere/None', since }, utc('2026-10-12T08:01:00Z')).kind === 'send');

const late = (hours: number) => S.dueDecision(sub({ since, lastSlot: '2026-10-11T08:00:00.000Z' }), utc('2026-10-12T08:00:00Z') + hours * H);
ok('late: 5 h 59 m after the slot → still sent', late(5 + 59 / 60).kind === 'send');
ok('late: exactly 6 h → missed', late(6).kind === 'missed' && at((late(6) as { slot: number }).slot) === '2026-10-12T08:00:00.000Z');
ok('LATE_MS is six hours', S.LATE_MS === 6 * H);
const outage = S.dueDecision(sub({ since, lastSlot: '2026-10-05T08:00:00.000Z' }), utc('2026-10-12T09:00:00Z'));
ok('late: back after a week down — ONE decision, for the newest slot, sent (1 h late); the six in between are not replayed',
  outage.kind === 'send' && at(outage.slot) === '2026-10-12T08:00:00.000Z');
const outage2 = S.dueDecision(sub({ since, lastSlot: '2026-10-05T08:00:00.000Z' }), utc('2026-10-12T20:00:00Z'));
ok('late: back 12 h after the newest slot → that one is missed, and stamping it leaves nothing due',
  outage2.kind === 'missed' && S.dueDecision(sub({ since, lastSlot: at((outage2 as { slot: number }).slot) }), utc('2026-10-12T20:01:00Z')).kind === 'none');
const hourlyLate = S.dueDecision({ schedule: hourly, timezone: 'UTC', since, lastSlot: '2026-10-12T01:15:00.000Z' }, utc('2026-10-12T12:20:00Z'));
ok('late: an hourly schedule after 11 h down sends once (its newest slot is 5 minutes old)', hourlyLate.kind === 'send' && at(hourlyLate.slot) === '2026-10-12T12:15:00.000Z');

// ── the schedule as a sentence ──────────────────────────────────────────────
ok('sentence: each cadence', text.scheduleText(daily8, 'Europe/Berlin') === 'Every day at 08:00 (Europe/Berlin)'
  && text.scheduleText(weekdays, 'UTC') === 'Every weekday at 08:00 (UTC)'
  && text.scheduleText(monWed, 'UTC') === 'Every Mon, Wed at 09:30 (UTC)'
  && text.scheduleText(m31, 'UTC') === 'Monthly on day 31 at 06:00 (UTC)'
  && text.scheduleText(hourly, 'UTC') === 'Every hour at :15 (UTC)',
[daily8, weekdays, monWed, m31, hourly].map((s) => text.scheduleText(s, 'UTC')).join(' | '));

finish();
