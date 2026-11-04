// A dashboard date control's period lands on the date a metric counts by (semantic layer D9, PR 04
// Task 2): rewriteControlPeriods moves a marked period step onto the metric's `timeColumn`, strips the
// mark, and keeps a tile's own identical date filter. The merges key by the mark, so a control's step
// and a tile's own identical step both reach the rewrite.
//
//   npm run build:ts && node scripts/test-metricTime.js

import { ok, finish } from './selfcheck';
import type { FilterStep } from '../src/data/transforms';

const { rewriteControlPeriods, hasControlPeriod, controlPeriodMoved } = require('../src/analysis/metricTime') as typeof import('../src/analysis/metricTime');
const { mergeDashboardFilters } = require('../src/analysis/dashboardFilters') as typeof import('../src/analysis/dashboardFilters');

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

finish();
