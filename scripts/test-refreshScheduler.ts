'use strict';

// Self-check for the scheduling RULE — `dueDatasets` in src/refreshScheduler.ts.
//
// The rule is the whole feature: everything else in that module is plumbing
// around it (enumerate, stamp, call refreshDataset). It is a pure function
// taking `now` precisely so this file can pin it, instead of a test that has to
// wait an hour to find out whether "hourly" means what it says.
//
// The cases that matter are the ones where getting it wrong is quiet:
//
//   - NEVER RUN must be due immediately. If it weren't, turning a schedule on
//     would do nothing until a full interval had passed, and the feature would
//     look broken for an hour before it looked working.
//   - JUST RUN must not be due. A scheduler that re-fires every 60-second tick
//     would hammer a remote source and rewrite a record sixty times an hour.
//   - AN UNPARSEABLE STAMP must be treated as never-run, not as just-run.
//     Treating a corrupt value as recent disables the schedule silently and
//     forever; treating it as never lets it self-heal on the next tick.
//   - NO ORIGIN must never be due. There is nothing to re-fetch, so a schedule
//     there is a retry loop against nothing.
//   - MOST OVERDUE FIRST (L0.3). The order is the order the jobs runner starts
//     them in; when more are due than it runs at once, the one that has waited
//     longest past its time must not be the one left waiting.
//   - EVERY 5 AND 15 MINUTES behave like any other interval at the boundary.
//
//   npm run build:ts && node scripts/test-refreshScheduler.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

// ponytail: compiled sibling of ../src/refreshScheduler.ts. Required (not
// imported) so this file does not pull a store in through the module graph.
const sched: typeof import('../src/app/refreshScheduler') = require('../src/app/refreshScheduler');
const { dueDatasets } = sched;

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const NOW = Date.parse('2026-08-08T12:00:00.000Z');

type Every = 'hourly' | 'daily' | 'weekly' | '5min' | '15min';
function meta(id: string, every?: Every, lastAutoAt?: string | null, originKind: any = 'file'): any {
  const m: any = { projectId: 'p', id, name: id, originKind };
  if (every) {
    m.autoRefresh = { every };
    if (lastAutoAt) m.autoRefresh.lastAutoAt = lastAutoAt;
  }
  return m;
}
const at = (ms: number): string => new Date(NOW - ms).toISOString();
const ids = (list: any[]): string => list.map((m) => m.id).join(',');

// ── Off, and the shapes that must never fire ─────────────────────────────────

ok('a dataset with no schedule is never due', dueDatasets([meta('off')], NOW).length === 0);
ok('an empty list is fine', dueDatasets([], NOW).length === 0);
ok('a non-array is fine, not a throw', dueDatasets(undefined as any, NOW).length === 0);
ok('a schedule with an unknown interval never fires',
  dueDatasets([meta('bad', 'monthly' as any)], NOW).length === 0);
// `null`, not `undefined`: a default parameter treats an explicit undefined as
// absent, so passing undefined here would silently test the 'file' default —
// the assertion would pass while proving nothing.
ok('a schedule on a dataset with NO ORIGIN never fires',
  dueDatasets([meta('orphan', 'hourly', null, null)], NOW).length === 0);

// ── Never run ────────────────────────────────────────────────────────────────

ok('a schedule that has never run is due at once',
  ids(dueDatasets([meta('fresh', 'hourly')], NOW)) === 'fresh');
ok('…for every interval, not just the short one',
  dueDatasets([meta('h', 'hourly'), meta('d', 'daily'), meta('w', 'weekly'), meta('5', '5min'), meta('15', '15min')], NOW).length === 5);
ok('an unparseable lastAutoAt counts as never run, so the schedule self-heals',
  ids(dueDatasets([meta('corrupt', 'hourly', 'not-a-date')], NOW)) === 'corrupt');

// ── The interval boundary, per interval ──────────────────────────────────────

for (const [every, span] of [['5min', 5 * MIN], ['15min', 15 * MIN], ['hourly', HOUR], ['daily', DAY], ['weekly', WEEK]] as const) {
  ok(`${every}: just run is NOT due`, dueDatasets([meta('x', every, at(1000))], NOW).length === 0);
  ok(`${every}: one second short of the interval is NOT due`,
    dueDatasets([meta('x', every, at(span - 1000))], NOW).length === 0);
  ok(`${every}: exactly the interval IS due (>=, so a tick landing on the boundary counts)`,
    dueDatasets([meta('x', every, at(span))], NOW).length === 1);
  ok(`${every}: long overdue is due`, dueDatasets([meta('x', every, at(span * 10))], NOW).length === 1);
}

// An hourly and a weekly both last run 25 hours ago: the hourly is due, the
// weekly is not. The intervals must not be collapsing into one number.
ok('intervals are independent of each other',
  ids(dueDatasets([meta('h', 'hourly', at(25 * HOUR)), meta('w', 'weekly', at(25 * HOUR))], NOW)) === 'h');

// A 5-minute and a 15-minute schedule both last run 10 minutes ago.
ok('5 and 15 minutes are distinct intervals',
  ids(dueDatasets([meta('5', '5min', at(10 * MIN)), meta('15', '15min', at(10 * MIN))], NOW)) === '5');

// ── Order (most overdue first) and selectivity ──────────────────────────────

const mixed = [
  meta('a-due', 'hourly', at(2 * HOUR)), // 1 h past due
  meta('b-off'),
  meta('c-due', 'daily'), // never run: infinitely overdue
  meta('d-recent', 'daily', at(HOUR)),
  meta('e-due', 'weekly', at(8 * DAY)), // 1 day past due
  meta('f-due', '5min', at(7 * MIN)), // 2 min past due
];
ok('only the due ones come back, MOST OVERDUE FIRST (never run leads)', ids(dueDatasets(mixed, NOW)) === 'c-due,e-due,a-due,f-due',
  ids(dueDatasets(mixed, NOW)));
ok('…and the input is not mutated (order included)', mixed.length === 6 && ids(mixed) === 'a-due,b-off,c-due,d-recent,e-due,f-due');
ok('lateness is TIME past due, not a share of the interval: a 15-min schedule 20 min late beats a 5-min one 10 min late',
  ids(dueDatasets([meta('five', '5min', at(15 * MIN)), meta('fifteen', '15min', at(35 * MIN))], NOW)) === 'fifteen,five');
ok('ties keep input order — several never-run schedules, a corrupt stamp among them',
  ids(dueDatasets([meta('n1', '5min'), meta('n2', 'weekly', 'not-a-date'), meta('n3', 'hourly')], NOW)) === 'n1,n2,n3');
ok('…and equal lateness keeps input order too',
  ids(dueDatasets([meta('x', '5min', at(6 * MIN)), meta('y', '15min', at(16 * MIN))], NOW)) === 'x,y');
// Negative control for the ordering itself: the same set given in the
// opposite order comes back in the SAME order, so the sort is doing the work.
ok('negative control: reversed input, same most-overdue order', ids(dueDatasets([...mixed].reverse(), NOW)) === 'c-due,e-due,a-due,f-due',
  ids(dueDatasets([...mixed].reverse(), NOW)));

// The catch-up story, which is the one users will ask about: the app was closed
// for three days, so on the first tick after launch everything overdue fires.
// There is no special-case code for that — it falls out of the same comparison.
const afterThreeDaysClosed = [
  meta('hourly', 'hourly', at(3 * DAY)),
  meta('daily', 'daily', at(3 * DAY)),
  meta('weekly', 'weekly', at(3 * DAY)),
];
ok('a three-day gap catches up the hourly and daily, but not the weekly',
  ids(dueDatasets(afterThreeDaysClosed, NOW)) === 'hourly,daily');

console.log('');
if (failureCount()) {
  console.error(`${failureCount()} scheduler check(s) FAILED.`);
  process.exit(1);
}
console.log('All scheduler checks passed.');
