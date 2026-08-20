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
//
//   npm run build:ts && node scripts/test-refreshScheduler.js

export {}; // module scope — sibling test scripts share top-level names

// ponytail: compiled sibling of ../src/refreshScheduler.ts. Required (not
// imported) so this file does not pull Electron in through the module graph.
const sched: typeof import('../src/app/refreshScheduler') = require('../src/app/refreshScheduler');
const { dueDatasets } = sched;

let failures = 0;
function ok(label: string, cond: boolean, extra?: string): void {
  if (cond) console.log('ok   ' + label + (extra ? '  ' + extra : ''));
  else {
    console.error('FAIL ' + label + (extra ? '  ' + extra : ''));
    failures++;
  }
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const NOW = Date.parse('2026-08-08T12:00:00.000Z');

type Every = 'hourly' | 'daily' | 'weekly';
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
  dueDatasets([meta('h', 'hourly'), meta('d', 'daily'), meta('w', 'weekly')], NOW).length === 3);
ok('an unparseable lastAutoAt counts as never run, so the schedule self-heals',
  ids(dueDatasets([meta('corrupt', 'hourly', 'not-a-date')], NOW)) === 'corrupt');

// ── The interval boundary, per interval ──────────────────────────────────────

for (const [every, span] of [['hourly', HOUR], ['daily', DAY], ['weekly', WEEK]] as const) {
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

// ── Order and selectivity ────────────────────────────────────────────────────

const mixed = [
  meta('a-due', 'hourly', at(2 * HOUR)),
  meta('b-off'),
  meta('c-due', 'daily'),
  meta('d-recent', 'daily', at(HOUR)),
  meta('e-due', 'weekly', at(8 * DAY)),
];
ok('only the due ones come back, in input order', ids(dueDatasets(mixed, NOW)) === 'a-due,c-due,e-due',
  ids(dueDatasets(mixed, NOW)));
ok('…and the input is not mutated', mixed.length === 5);

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
if (failures) {
  console.error(`${failures} scheduler check(s) FAILED.`);
  process.exit(1);
}
console.log('All scheduler checks passed.');
