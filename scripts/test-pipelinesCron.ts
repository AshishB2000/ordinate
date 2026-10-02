// Self-check for a pipeline's cron-like schedule: src/app/pipelineCron.ts.
//
// The point of the module is wall-clock time in a named zone, so most of this
// is the two DST edges, on real 2026 transition days:
//   America/New_York  springs forward 2026-03-08 02:00 → 03:00 (EST → EDT)
//                     falls back      2026-11-01 02:00 → 01:00 (EDT → EST)
//   Europe/London     springs forward 2026-03-29 01:00 → 02:00 (GMT → BST)
// The rules being pinned: a wall time in the skipped hour runs just after the
// gap (a daily job never loses a day); a wall time that happens twice runs once.
//
//   npm run build:ts && node scripts/test-pipelinesCron.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const C: typeof import('../src/app/pipelineCron') = require('../src/app/pipelineCron');

const T = (iso: string): number => Date.parse(iso);
const next = (expr: string, tz: string, fromIso: string): string | null => {
  const t = C.nextCronRun(expr, tz, T(fromIso));
  return t === null ? null : new Date(t).toISOString();
};
const NY = 'America/New_York';
const check = (label: string, got: string | null, want: string | null): void => ok(label, got === want, `got ${got}, want ${want}`);

// ── Parsing ─────────────────────────────────────────────────────────────────
ok('parse: five fields', C.parseCron('0 6 * * *') !== null);
for (const bad of ['', '* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '*/0 * * * *', '5-1 * * * *', 'a * * * *', '1,,2 * * * *']) {
  ok(`parse: "${bad}" is refused`, C.parseCron(bad) === null);
}
ok('parse: ranges, steps and lists', JSON.stringify(C.parseCron('0,15-20/5,*/30 * * * *')!.minutes) === '[0,15,20,30]');
ok('parse: weekday 7 is Sunday', C.parseCron('0 0 * * 7')!.weekdays.has(0));
ok('zones: a real IANA zone is valid, nonsense is not', C.isValidTimeZone(NY) && !C.isValidTimeZone('Mars/Olympus') && !C.isValidTimeZone(''));

// ── Plain cases ─────────────────────────────────────────────────────────────
check('basic: daily 06:00 UTC, after today\'s slot → tomorrow', next('0 6 * * *', 'UTC', '2026-01-01T07:00:00Z'), '2026-01-02T06:00:00.000Z');
check('basic: strictly AFTER from — exactly on a slot moves to the next', next('0 6 * * *', 'UTC', '2026-01-01T06:00:00Z'), '2026-01-02T06:00:00.000Z');
check('basic: every 15 minutes', next('*/15 * * * *', 'UTC', '2026-01-01T06:07:30Z'), '2026-01-01T06:15:00.000Z');
check('basic: weekdays skip the weekend (Fri 2026-01-02 → Mon 01-05)', next('0 9 * * 1-5', 'UTC', '2026-01-02T10:00:00Z'), '2026-01-05T09:00:00.000Z');
check('basic: day-of-month OR weekday when both are set', next('0 9 15 * 1', 'UTC', '2026-01-06T00:00:00Z'), '2026-01-12T09:00:00.000Z');
check('basic: month rollover', next('0 0 1 * *', 'UTC', '2026-01-31T12:00:00Z'), '2026-02-01T00:00:00.000Z');
check('basic: Feb 29 waits for the leap year', next('0 0 29 2 *', 'UTC', '2026-03-01T00:00:00Z'), '2028-02-29T00:00:00.000Z');
check('basic: a date that never exists is null, not a hang', next('0 0 31 2 *', 'UTC', '2026-01-01T00:00:00Z'), null);
check('zone: 06:00 New York in winter is 11:00Z', next('0 6 * * *', NY, '2026-01-10T00:00:00Z'), '2026-01-10T11:00:00.000Z');
check('zone: 06:00 New York in summer is 10:00Z', next('0 6 * * *', NY, '2026-07-10T00:00:00Z'), '2026-07-10T10:00:00.000Z');
check('zone: Asia/Kolkata\'s half-hour offset', next('0 9 * * *', 'Asia/Kolkata', '2026-01-10T00:00:00Z'), '2026-01-10T03:30:00.000Z');

// ── Spring forward: New York, 2026-03-08 ────────────────────────────────────
check('spring: 06:00 the day before is EST (11:00Z)', next('0 6 * * *', NY, '2026-03-07T00:00:00Z'), '2026-03-07T11:00:00.000Z');
check('spring: 06:00 on the day is EDT (10:00Z) — wall time held, offset moved', next('0 6 * * *', NY, '2026-03-07T12:00:00Z'), '2026-03-08T10:00:00.000Z');
check('spring: 02:30 does not exist that night — it runs at 03:30 EDT, not never', next('30 2 * * *', NY, '2026-03-07T12:00:00Z'), '2026-03-08T07:30:00.000Z');
check('spring: and the night after is an ordinary 02:30 EDT', next('30 2 * * *', NY, '2026-03-08T07:30:00Z'), '2026-03-09T06:30:00.000Z');
check('spring: hourly — 01:00 EST', next('0 * * * *', NY, '2026-03-08T05:30:00Z'), '2026-03-08T06:00:00.000Z');
check('spring: hourly — the skipped 02:00 lands on the 03:00 instant', next('0 * * * *', NY, '2026-03-08T06:00:00Z'), '2026-03-08T07:00:00.000Z');
check('spring: hourly — and runs once there, then 04:00 EDT', next('0 * * * *', NY, '2026-03-08T07:00:00Z'), '2026-03-08T08:00:00.000Z');
check('spring: London 01:30 does not exist on 2026-03-29 → 02:30 BST (01:30Z)', next('30 1 * * *', 'Europe/London', '2026-03-28T12:00:00Z'), '2026-03-29T01:30:00.000Z');

// ── Fall back: New York, 2026-11-01 ─────────────────────────────────────────
check('fall: 01:30 happens twice — it runs at the FIRST (EDT, 05:30Z)', next('30 1 * * *', NY, '2026-10-31T12:00:00Z'), '2026-11-01T05:30:00.000Z');
check('fall: and not again at the repeat (EST 06:30Z) — next is tomorrow', next('30 1 * * *', NY, '2026-11-01T05:30:00Z'), '2026-11-02T06:30:00.000Z');
check('fall: asked from inside the repeat hour, still tomorrow', next('30 1 * * *', NY, '2026-11-01T06:10:00Z'), '2026-11-02T06:30:00.000Z');
check('fall: 06:00 on the day is EST (11:00Z)', next('0 6 * * *', NY, '2026-11-01T05:00:00Z'), '2026-11-01T11:00:00.000Z');
check('fall: hourly — 01:00 EDT', next('0 * * * *', NY, '2026-11-01T04:30:00Z'), '2026-11-01T05:00:00.000Z');
check('fall: hourly — the repeated 01:00 does not run twice; next is 02:00 EST', next('0 * * * *', NY, '2026-11-01T05:00:00Z'), '2026-11-01T07:00:00.000Z');
check('fall: every 30 min across the change, from 01:30 EDT → 02:00 EST', next('*/30 * * * *', NY, '2026-11-01T05:30:00Z'), '2026-11-01T07:00:00.000Z');

// ── Instants ────────────────────────────────────────────────────────────────
ok('instant: the skipped 02:30 maps past the gap', C.wallToInstant({ y: 2026, mo: 3, d: 8, h: 2, mi: 30 }, NY) === T('2026-03-08T07:30:00Z'));
ok('instant: the doubled 01:30 maps to its first occurrence', C.wallToInstant({ y: 2026, mo: 11, d: 1, h: 1, mi: 30 }, NY) === T('2026-11-01T05:30:00Z'));
{
  let t = T('2026-03-01T00:00:00Z');
  let monotonic = true;
  for (let i = 0; i < 24 * 40; i += 1) {
    const n = C.nextCronRun('0 * * * *', NY, t);
    if (n === null || n <= t) { monotonic = false; break; }
    t = n;
  }
  ok('instant: 40 days of hourly runs across both changes only ever move forward', monotonic);
}

// ── Words ───────────────────────────────────────────────────────────────────
ok('words: daily', C.describeCron('0 6 * * *') === 'Every day at 06:00');
ok('words: weekdays', C.describeCron('30 7 * * 1-5') === 'Weekdays at 07:30');
ok('words: weekly', C.describeCron('0 9 * * 1') === 'Every Monday at 09:00');
ok('words: hourly', C.describeCron('15 * * * *') === 'Every hour at :15');
ok('words: monthly', C.describeCron('0 8 1 * *') === 'Day 1 of each month at 08:00');
ok('words: anything else is the expression itself', C.describeCron('*/15 9-17 * * 1-5') === '*/15 9-17 * * 1-5');
ok('words: invalid says so', C.describeCron('nope') === 'Not a valid schedule');

finish();
