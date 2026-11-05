// Period metrics (semantic layer part 5, step 05: D8, D9, D10's first bullet): "Revenue, year to date", "Orders,
// last 7 days", "Revenue, % change on last year" — a base metric resolved under a rewritten scope.
//
//   math      the days a window covers under any scope and calendar (src/analysis/periodMath.ts), pure
//
// Every guard has its NEGATIVE CONTROL beside it.
//
//   npm run build:ts && node scripts/test-periodMetrics.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { FilterStep } from '../src/data/transforms';
import type { DateRange } from '../src/analysis/dateIntel';
import type { MetricWindow } from '../src/analysis/periodMetric';

const pm: typeof import('../src/analysis/periodMath') = require('../src/analysis/periodMath');
const { resolvePeriod }: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');

const same = (a: DateRange | null | undefined, b: DateRange | null | undefined): boolean => !!a && !!b && a.from === b.from && a.to === b.to;
const ON = (from: string, to: string, column = 'day'): FilterStep => ({ type: 'filter', column, op: 'period', period: { preset: 'custom', from, to } }) as FilterStep;

// ── math ────────────────────────────────────────────────────────────────────
{
  const TODAY = '2024-11-03';
  const D = { name: 'day', type: 'date' };
  const GREG = { weekStart: 1, fiscalYearStart: 1 }, FY4 = { weekStart: 1, fiscalYearStart: 4 }, W445 = { ...GREG, calendarType: '445' as const };
  const REGION_EAST = { type: 'filter', column: 'region', op: '=', value: 'East' } as FilterStep;
  const r = (w: MetricWindow, f: FilterStep[], cal: typeof GREG = GREG) => pm.windowedScope(f, D, w, TODAY, cal).range;
  ok('YTD, no scope = the ytd preset', same(r({ to_date: 'year' }, []), resolvePeriod({ preset: 'ytd' }, TODAY, GREG)));
  ok('YTD, fiscal April, scope October', same(r({ to_date: 'year' }, [ON('2024-10-01', '2024-10-31')], FY4), { from: '2024-04-01', to: '2024-10-31' }));
  ok('QTD = the qtd preset under a week calendar', same(r({ to_date: 'quarter' }, [], W445), resolvePeriod({ preset: 'qtd' }, TODAY, W445)), JSON.stringify([r({ to_date: 'quarter' }, [], W445), resolvePeriod({ preset: 'qtd' }, TODAY, W445)]));
  ok('YTD = the ytd preset under a week calendar too', same(r({ to_date: 'year' }, [], W445), resolvePeriod({ preset: 'ytd' }, TODAY, W445)));
  ok('MTD, February 2024 ends on the 29th', same(r({ to_date: 'month' }, [ON('2024-02-01', '2024-02-29')]), { from: '2024-02-01', to: '2024-02-29' }));
  ok('WTD starts on the workspace week start', same(r({ to_date: 'week' }, []), { from: '2024-10-28', to: TODAY }) && same(r({ to_date: 'week' }, [], { weekStart: 0, fiscalYearStart: 1 }), { from: '2024-11-03', to: TODAY }));
  ok('to date never passes today', r({ to_date: 'month' }, [ON('2024-11-01', '2024-11-30')])!.to === TODAY);
  ok('last 7 days, scope February: the 23rd to the 29th', same(r({ last: 7, unit: 'day' }, [ON('2024-02-01', '2024-02-29')]), { from: '2024-02-23', to: '2024-02-29' }));
  ok('last 7 days, no scope, ends yesterday', r({ last: 7, unit: 'day' }, [])!.to === '2024-11-02');
  ok('last 3 months, scope ending mid-October: whole months only', same(r({ last: 3, unit: 'month' }, [ON('2024-10-01', '2024-10-15')]), resolvePeriod({ preset: 'last_n_months', n: 3 }, '2024-10-16', GREG)));
  ok('last 2 weeks, scope ending on a Sunday: the two whole weeks before it', same(r({ last: 2, unit: 'week' }, [ON('2024-10-01', '2024-10-27')]), { from: '2024-10-14', to: '2024-10-27' }));
  const f = pm.windowedScope([REGION_EAST, ON('2024-10-01', '2024-10-31'), { type: 'filter', column: 'ship', op: '>=', value: '2024-01-01' } as FilterStep], D, { to_date: 'year' }, TODAY, GREG).filters;
  ok('the window replaces only the date bounds on the base\'s date', f.includes(REGION_EAST) && f.some((s) => s.column === 'ship') && f.filter((s) => s.column === 'day').length === 1, JSON.stringify(f));
  ok('… and its one step is the window', same(f.find((s) => s.column === 'day')?.period as DateRange, { from: '2024-01-01', to: '2024-10-31' }));
  const none = pm.windowedScope([REGION_EAST, ON('2024-10-01', '2024-10-31')], D, undefined, TODAY, GREG);
  ok('no window: the filters as they are, and the scope\'s range', none.filters.length === 2 && none.filters[0] === REGION_EAST && same(none.range, { from: '2024-10-01', to: '2024-10-31' }));
  ok('no window and no scope: no range', pm.windowedScope([REGION_EAST], D, undefined, TODAY, GREG).range === null);
  ok('scopeEnd: the scope\'s end, today when open or none', pm.scopeEnd([ON('2024-10-01', '2024-10-31')], D, TODAY) === '2024-10-31' && pm.scopeEnd([{ type: 'filter', column: 'day', op: '>=', value: '2024-10-01' } as FilterStep], D, TODAY) === TODAY && pm.scopeEnd([], D, TODAY) === TODAY);
  ok('windowRange: last 1 month ending at the end of October', same(pm.windowRange({ last: 1, unit: 'month' }, '2024-10-31', TODAY, GREG), { from: '2024-10-01', to: '2024-10-31' }));
  ok('pct_change', pm.pctChange(110, 100) === 0.1 && pm.pctChange(90, -100) === 1.9 && pm.pctChange(5, 0) === null && pm.pctChange(5, null) === null && pm.pctChange(null, 5) === null);
  ok('periodValue: no compare is now, change, % change and prior', pm.periodValue(undefined, 7, 5) === 7 && pm.periodValue('change', 7, 5) === 2 && pm.periodValue('pct_change', 6, 5) === pm.pctChange(6, 5) && pm.periodValue('prior', 7, 5) === 5);
  ok('periodValue: a change with either side missing is no figure', pm.periodValue('change', null, 5) === null && pm.periodValue('change', 7, null) === null && pm.periodValue(undefined, null, 5) === null);
  ok('NEGATIVE CONTROL: a scope on another date column does not move the window', r({ to_date: 'year' }, [{ type: 'filter', column: 'ship', op: 'period', period: { preset: 'last_month' } } as FilterStep])!.to === TODAY);
}

finish();
