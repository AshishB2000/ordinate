// A dashboard date control's period lands on the date a metric counts by (semantic layer D9, PR 04
// Task 2): rewriteControlPeriods moves a marked period step onto the metric's `timeColumn`, strips the
// mark, and keeps a tile's own identical date filter. The merges key by the mark, so a control's step
// and a tile's own identical step both reach the rewrite.
//
//   npm run build:ts && node scripts/test-metricTime.js

import { ok, finish } from './selfcheck';
import type { FilterStep } from '../src/data/transforms';

const { rewriteControlPeriods, hasControlPeriod, controlPeriodMoved, controlPeriodsConflict } = require('../src/analysis/metricTime') as typeof import('../src/analysis/metricTime');
const { mergeDashboardFilters } = require('../src/analysis/dashboardFilters') as typeof import('../src/analysis/dashboardFilters');
const msg = require('../src/analysis/metricCheckMessages') as typeof import('../src/analysis/metricCheckMessages');

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const CTRL = { type: 'filter', column: 'order_date', op: 'period', period: { preset: 'custom', from: '2024-03-01', to: '2024-03-31' }, fromControl: true } as FilterStep;
const OWN = { type: 'filter', column: 'order_date', op: 'period', period: CTRL.period } as FilterStep;
const LOCK = { type: 'filter', column: 'region', op: '=', value: 'West', lock: true } as FilterStep;
const plain = [LOCK, OWN];
ok('no marks: the same array back', rewriteControlPeriods(plain, 'ship_date') === plain);
ok('a marked period moves to the metric\'s date, unmarked', same(rewriteControlPeriods([CTRL], 'ship_date'), [{ ...OWN, column: 'ship_date' }]));
ok('unset: only the mark goes', same(rewriteControlPeriods([CTRL], ''), [OWN]));
ok('a tile\'s own identical step survives a move', same(rewriteControlPeriods([CTRL, OWN], 'ship_date'), [{ ...OWN, column: 'ship_date' }, OWN]));
ok('… and collapses to one when unset (today\'s merge)', same(rewriteControlPeriods([CTRL, OWN], ''), [OWN]));
ok('NEGATIVE CONTROL: an unmarked period and a lock step never move', same(rewriteControlPeriods([LOCK, CTRL, OWN], 'ship_date')[0], LOCK) && rewriteControlPeriods([LOCK, CTRL, OWN], 'ship_date')[2].column === 'order_date');
ok('a marked non-period step only loses its mark', same(rewriteControlPeriods([{ ...LOCK, lock: undefined, fromControl: true } as FilterStep], 'ship_date'), [{ type: 'filter', column: 'region', op: '=', value: 'West' }]));
ok('mergeDashboardFilters keeps a control step and an identical own step', mergeDashboardFilters([CTRL], [OWN]).length === 2);
ok('NEGATIVE CONTROL: two unmarked duplicates still collapse', mergeDashboardFilters([OWN], [OWN]).length === 1);

// A kept step (a term a door did not expand, or a newer release's step) rides verbatim, its own flag too.
const TERM = { type: 'term', term: '7d2c1f4e-1111-4222-8333-444455556666', fromControl: true } as unknown as FilterStep;
const onlyTerm = [TERM, OWN];
ok('a kept step\'s own mark is no mark: the same array back', rewriteControlPeriods(onlyTerm, 'ship_date') === onlyTerm);
ok('a kept step passes through verbatim beside a moved period', same(rewriteControlPeriods([TERM, CTRL], 'ship_date'), [TERM, { ...OWN, column: 'ship_date' }]));
// The marker is no security property: a row lock never moves, though its mark goes.
ok('a marked row lock period stays on its column', same(rewriteControlPeriods([{ ...CTRL, lock: true } as FilterStep], 'ship_date'), [{ ...OWN, lock: true }]));

ok('hasControlPeriod: a marked period', hasControlPeriod([LOCK, CTRL]) && !hasControlPeriod(plain));
ok('NEGATIVE CONTROL: a marked non-period step, a kept step or a lock is no control period',
  !hasControlPeriod([{ ...LOCK, lock: undefined, fromControl: true } as FilterStep, TERM, { ...CTRL, lock: true } as FilterStep]));
ok('controlPeriodMoved: the control names another column', controlPeriodMoved([CTRL], 'ship_date'));
ok('NEGATIVE CONTROL: not moved when unset, on the same column or unmarked',
  !controlPeriodMoved([CTRL], '') && !controlPeriodMoved([CTRL], 'order_date') && !controlPeriodMoved([OWN], 'ship_date'));

// "Only when one of the pair was marked": two identical unmarked steps both stay, as they came in.
const OWN2 = { type: 'filter', column: 'region', op: '=', value: 'East' } as FilterStep;
ok('two identical unmarked steps beside a control both stay', same(rewriteControlPeriods([CTRL, OWN2, OWN2], 'ship_date'), [{ ...OWN, column: 'ship_date' }, OWN2, OWN2]));
// A row lock is never merged away in favour of an identical unlocked step: the lock is in the key.
const MARKED_X = { type: 'filter', column: 'region', op: '=', value: 'West', fromControl: true } as FilterStep;
ok('a lock beside its identical marked step stays', same(rewriteControlPeriods([MARKED_X, LOCK], 'ship_date'), [{ type: 'filter', column: 'region', op: '=', value: 'West' }, LOCK]));
ok('mergeDashboardFilters keeps a lock and an identical unlocked step', mergeDashboardFilters([{ ...LOCK, lock: undefined } as FilterStep], [LOCK]).length === 2);
ok('NEGATIVE CONTROL: the same lock twice is one', mergeDashboardFilters([LOCK], [{ ...LOCK }]).length === 1);
// The metric's date is a column of its own dataset: a moved period is no longer read through a relationship.
const VIA = '44444444-4444-4444-8444-444444444444';
ok('a moved period drops its via', same(rewriteControlPeriods([{ ...CTRL, via: VIA } as FilterStep], 'ship_date'), [{ ...OWN, column: 'ship_date' }]));
ok('NEGATIVE CONTROL: unset, nothing moves and the via stays', same(rewriteControlPeriods([{ ...CTRL, via: VIA } as FilterStep], ''), [{ ...OWN, via: VIA }]));

// Two date controls that would land on one date with different periods: the doors refuse (D9).
const APRIL = { ...CTRL, column: 'ship_date', period: { preset: 'custom', from: '2024-04-01', to: '2024-04-30' } } as FilterStep;
ok('conflict: two controls on different columns', controlPeriodsConflict([CTRL, APRIL], 'ship_date'));
ok('conflict: two controls on one column with different periods', controlPeriodsConflict([CTRL, { ...APRIL, column: 'order_date' } as FilterStep], 'ship_date'));
ok('NEGATIVE CONTROL: the same period from controls on two columns lands as one step', !controlPeriodsConflict([CTRL, { ...CTRL, column: 'ship_date' } as FilterStep], 'ship_date'));
ok('NEGATIVE CONTROL: the same period twice merges, no conflict', !controlPeriodsConflict([CTRL, { ...CTRL }], 'ship_date'));
ok('NEGATIVE CONTROL: one control is no conflict', !controlPeriodsConflict([CTRL, OWN, LOCK], 'ship_date'));
ok('NEGATIVE CONTROL: unset, nothing lands on a metric date', !controlPeriodsConflict([CTRL, APRIL], ''));
ok('NEGATIVE CONTROL: a tile\'s own date filter, a lock or a kept step is no second control',
  !controlPeriodsConflict([CTRL, { ...APRIL, fromControl: undefined } as FilterStep, { ...APRIL, lock: true } as FilterStep, TERM], 'ship_date'));
ok('the refusal sentence', msg.controlPeriodsDisagree() === 'This metric counts by its own date, and two date controls set different periods on it.');

finish();
