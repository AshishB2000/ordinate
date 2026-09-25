'use strict';

// Self-check for src/analysis/dateIntel.ts and src/analysis/periodScope.ts —
// relative periods on FIXED clocks, across week and fiscal-year boundaries.
//
// Every expected range here is written out by hand from a calendar, not
// derived with the code under test: a derived expectation agrees with the bug
// it was derived from. The clock is always passed in (or pinned through
// ORDINATE_TODAY for the module-level evaluators), so nothing depends on the
// day the suite happens to run.
//
//   npm run build:ts && node scripts/test-dateIntel.js

import {
  resolvePeriod, shiftRange, describePeriod, sanitizePeriod, sanitizeCompare, periodDay,
  daysFromIso, isoFromDays, shiftBucketLabel, setCalendar, PERIOD_PRESETS,
} from '../src/analysis/dateIntel';
import type { CalendarPrefs, PeriodSpec } from '../src/analysis/dateIntel';
import { compareScope, overlayFilters, scopeRange, overlayCaption } from '../src/analysis/periodScope';
import { controlSteps, mergeDashboardFilters } from '../src/analysis/dashboardFilters';
import { sanitizeCard } from '../src/analysis/dashboards';
import { applyPipeline, sanitizeSteps } from '../src/data/transforms';
import type { FilterStep } from '../src/data/transforms';

import { ok, finish } from './selfcheck';

const CAL: CalendarPrefs = { weekStart: 1, fiscalYearStart: 1 };

function range(spec: PeriodSpec, today: string, cal: CalendarPrefs = CAL): string {
  const r = resolvePeriod(spec, today, cal);
  return r ? `${r.from || ''}..${r.to || ''}` : 'null';
}
function eq(label: string, got: string, want: string): void {
  ok(`${label}: ${want}`, got === want, `got ${got}`);
}

// ── 1. Every preset, calendar year, Monday weeks, on Tue 2024-10-15 ─────────
{
  const t = '2024-10-15';
  eq('today', range({ preset: 'today' }, t), '2024-10-15..2024-10-15');
  eq('yesterday', range({ preset: 'yesterday' }, t), '2024-10-14..2024-10-14');
  eq('last 30 days ends yesterday', range({ preset: 'last_n_days', n: 30 }, t), '2024-09-15..2024-10-14');
  eq('last 1 day is yesterday', range({ preset: 'last_n_days', n: 1 }, t), '2024-10-14..2024-10-14');
  eq('this week (Mon)', range({ preset: 'this_week' }, t), '2024-10-14..2024-10-20');
  eq('last week (Mon)', range({ preset: 'last_week' }, t), '2024-10-07..2024-10-13');
  eq('last 2 weeks', range({ preset: 'last_n_weeks', n: 2 }, t), '2024-09-30..2024-10-13');
  eq('this month', range({ preset: 'this_month' }, t), '2024-10-01..2024-10-31');
  eq('last month', range({ preset: 'last_month' }, t), '2024-09-01..2024-09-30');
  eq('last 3 months', range({ preset: 'last_n_months', n: 3 }, t), '2024-07-01..2024-09-30');
  eq('last 1 month === last month', range({ preset: 'last_n_months', n: 1 }, t), '2024-09-01..2024-09-30');
  eq('this quarter', range({ preset: 'this_quarter' }, t), '2024-10-01..2024-12-31');
  eq('last quarter', range({ preset: 'last_quarter' }, t), '2024-07-01..2024-09-30');
  eq('last 2 quarters', range({ preset: 'last_n_quarters', n: 2 }, t), '2024-04-01..2024-09-30');
  eq('this year', range({ preset: 'this_year' }, t), '2024-01-01..2024-12-31');
  eq('last year', range({ preset: 'last_year' }, t), '2023-01-01..2023-12-31');
  eq('last 2 years', range({ preset: 'last_n_years', n: 2 }, t), '2022-01-01..2023-12-31');
  eq('year to date', range({ preset: 'ytd' }, t), '2024-01-01..2024-10-15');
  eq('quarter to date', range({ preset: 'qtd' }, t), '2024-10-01..2024-10-15');
  eq('custom', range({ preset: 'custom', from: '2024-02-01', to: '2024-02-29' }, t), '2024-02-01..2024-02-29');
  eq('custom open end', range({ preset: 'custom', from: '2024-02-01' }, t), '2024-02-01..');
  ok('every preset resolves on this clock', PERIOD_PRESETS.every((p) =>
    resolvePeriod(p === 'custom' ? { preset: p, from: '2024-01-01' } : { preset: p, n: 3 }, t, CAL) !== null));
}

// ── 2. Week boundaries and the first day of week ────────────────────────────
{
  eq('Sunday weeks', range({ preset: 'this_week' }, '2024-10-15', { weekStart: 0, fiscalYearStart: 1 }), '2024-10-13..2024-10-19');
  eq('Sunday last week', range({ preset: 'last_week' }, '2024-10-15', { weekStart: 0, fiscalYearStart: 1 }), '2024-10-06..2024-10-12');
  eq('Saturday weeks', range({ preset: 'this_week' }, '2024-10-15', { weekStart: 6, fiscalYearStart: 1 }), '2024-10-12..2024-10-18');
  eq('today IS the first day (Mon)', range({ preset: 'this_week' }, '2024-10-14'), '2024-10-14..2024-10-20');
  eq('today is the last day (Sun, Mon weeks)', range({ preset: 'this_week' }, '2024-10-13'), '2024-10-07..2024-10-13');
  eq('week across a year end', range({ preset: 'this_week' }, '2025-01-01'), '2024-12-30..2025-01-05');
  eq('last week across a year end', range({ preset: 'last_week' }, '2025-01-02'), '2024-12-23..2024-12-29');
  eq('leap day: last 1 day on Mar 1', range({ preset: 'last_n_days', n: 1 }, '2024-03-01'), '2024-02-29..2024-02-29');
}

// ── 3. Fiscal years ─────────────────────────────────────────────────────────
{
  const jul: CalendarPrefs = { weekStart: 1, fiscalYearStart: 7 };
  const t = '2024-10-15';
  eq('FY Jul: this fiscal year', range({ preset: 'this_year' }, t, jul), '2024-07-01..2025-06-30');
  eq('FY Jul: last fiscal year', range({ preset: 'last_year' }, t, jul), '2023-07-01..2024-06-30');
  eq('FY Jul: this fiscal quarter (FQ2)', range({ preset: 'this_quarter' }, t, jul), '2024-10-01..2024-12-31');
  eq('FY Jul: last fiscal quarter', range({ preset: 'last_quarter' }, t, jul), '2024-07-01..2024-09-30');
  eq('FY Jul: fiscal YTD', range({ preset: 'ytd' }, t, jul), '2024-07-01..2024-10-15');
  eq('FY Jul: fiscal QTD', range({ preset: 'qtd' }, t, jul), '2024-10-01..2024-10-15');
  eq('FY Jul: last day of FY', range({ preset: 'this_year' }, '2024-06-30', jul), '2023-07-01..2024-06-30');
  eq('FY Jul: first day of FY', range({ preset: 'this_year' }, '2024-07-01', jul), '2024-07-01..2025-06-30');
  eq('FY Jul: January sits in the FY that began last July', range({ preset: 'this_year' }, '2025-01-10', jul), '2024-07-01..2025-06-30');
  eq('FY Jul: last 2 fiscal years', range({ preset: 'last_n_years', n: 2 }, t, jul), '2022-07-01..2024-06-30');

  const apr: CalendarPrefs = { weekStart: 1, fiscalYearStart: 4 };
  eq('FY Apr: this fiscal year from Feb', range({ preset: 'this_year' }, '2024-02-10', apr), '2023-04-01..2024-03-31');
  eq('FY Apr: this fiscal quarter (FQ4)', range({ preset: 'this_quarter' }, '2024-02-10', apr), '2024-01-01..2024-03-31');
  eq('FY Apr: last fiscal quarter', range({ preset: 'last_quarter' }, '2024-02-10', apr), '2023-10-01..2023-12-31');
  eq('FY Apr: last 2 fiscal quarters', range({ preset: 'last_n_quarters', n: 2 }, '2024-02-10', apr), '2023-07-01..2023-12-31');

  const feb: CalendarPrefs = { weekStart: 1, fiscalYearStart: 2 };
  eq('FY Feb: quarters are Nov–Jan', range({ preset: 'this_quarter' }, '2024-01-31', feb), '2023-11-01..2024-01-31');
  eq('FY Feb: this fiscal year from Jan', range({ preset: 'this_year' }, '2024-01-31', feb), '2023-02-01..2024-01-31');
  eq('FY Feb: new FY on Feb 1', range({ preset: 'this_year' }, '2024-02-01', feb), '2024-02-01..2025-01-31');
}

// ── 4. Comparison ranges ────────────────────────────────────────────────────
{
  const s = (r: { from?: string; to?: string } | null): string => (r ? `${r.from || ''}..${r.to || ''}` : 'null');
  eq('prev year clamps Feb 29', s(shiftRange({ from: '2024-02-29', to: '2024-03-31' }, 'previous_year')), '2023-02-28..2023-03-31');
  eq('prev period of a quarter is the previous quarter', s(shiftRange({ from: '2024-10-01', to: '2024-12-31' }, 'previous_period')), '2024-07-01..2024-09-30');
  eq('prev period of Feb (29 days) is all of January', s(shiftRange({ from: '2024-02-01', to: '2024-02-29' }, 'previous_period')), '2024-01-01..2024-01-31');
  eq('prev period of 30 days is the 30 before', s(shiftRange({ from: '2024-09-15', to: '2024-10-14' }, 'previous_period')), '2024-08-16..2024-09-14');
  eq('prev period of YTD is the same number of days before', s(shiftRange({ from: '2024-01-01', to: '2024-10-15' }, 'previous_period')), '2023-03-18..2023-12-31');
  eq('prev period of a fiscal year', s(shiftRange({ from: '2024-07-01', to: '2025-06-30' }, 'previous_period')), '2023-07-01..2024-06-30');
  eq('open range has no previous period', s(shiftRange({ from: '2024-07-01' }, 'previous_period')), 'null');
  eq('open range still has a last year', s(shiftRange({ from: '2024-07-01' }, 'previous_year')), '2023-07-01..');
}

// ── 5. Words ────────────────────────────────────────────────────────────────
{
  const jul = { weekStart: 1, fiscalYearStart: 7 };
  eq('describe last 30 days', describePeriod({ preset: 'last_n_days', n: 30 }), 'Last 30 days');
  eq('describe last 1 day', describePeriod({ preset: 'last_n_days', n: 1 }), 'Last 1 day');
  eq('describe this year (calendar)', describePeriod({ preset: 'this_year' }), 'This year');
  eq('describe this fiscal year', describePeriod({ preset: 'this_year' }, jul), 'This fiscal year');
  eq('describe fiscal YTD', describePeriod({ preset: 'ytd' }, jul), 'Fiscal year to date');
  eq('describe last 2 fiscal quarters', describePeriod({ preset: 'last_n_quarters', n: 2 }, jul), 'Last 2 fiscal quarters');
  eq('describe last 3 months stays calendar', describePeriod({ preset: 'last_n_months', n: 3 }, jul), 'Last 3 months');
}

// ── 6. Sanitising ───────────────────────────────────────────────────────────
{
  ok('unknown preset → null', sanitizePeriod({ preset: 'last_fortnight' }) === null);
  ok('non-object → null', sanitizePeriod('last_n_days') === null);
  ok('n defaults to 1', sanitizePeriod({ preset: 'last_n_days' })!.n === 1);
  ok('n is clamped', sanitizePeriod({ preset: 'last_n_days', n: 1e9 })!.n === 3660);
  ok('n is dropped where it means nothing', !('n' in sanitizePeriod({ preset: 'this_week', n: 5 })!));
  ok('custom needs a date', sanitizePeriod({ preset: 'custom' }) === null);
  ok('custom rejects a non-date', sanitizePeriod({ preset: 'custom', from: '2024-02-30' }) === null);
  const sw = sanitizePeriod({ preset: 'custom', from: '2024-05-01', to: '2024-01-01' })!;
  ok('custom swaps a reversed range', sw.from === '2024-01-01' && sw.to === '2024-05-01');
  ok('compare: unknown mode → null', sanitizeCompare({ mode: 'yesterday' }) === null);
  ok('compare: custom needs both dates', sanitizeCompare({ mode: 'custom', from: '2024-01-01' }) === null);
  ok('compare: previous_year kept', JSON.stringify(sanitizeCompare({ mode: 'previous_year', from: 'x' })) === '{"mode":"previous_year"}');
  const step = sanitizeSteps([{ type: 'filter', column: 'd', op: 'period', period: { preset: 'last_n_days', n: 7, junk: 1 } }]);
  ok('a period step survives sanitizeSteps with only its preset', JSON.stringify(step) ===
    '[{"type":"filter","column":"d","op":"period","period":{"preset":"last_n_days","n":7}}]', JSON.stringify(step));
  ok('a period step with no period is dropped', sanitizeSteps([{ type: 'filter', column: 'd', op: 'period' }]).length === 0);
}

// ── 7. Which cells a period reads ───────────────────────────────────────────
{
  const d = (s: unknown): string => { const v = periodDay(s); return v === null ? 'null' : isoFromDays(v); };
  eq('ISO', d('2024-03-05'), '2024-03-05');
  eq('ISO single digits', d('2024-3-5'), '2024-03-05');
  eq('ISO slashes', d('2024/03/05'), '2024-03-05');
  eq('US', d('03/05/2024'), '2024-03-05');
  eq('ISO + time', d('2024-03-05 10:22:00'), '2024-03-05');
  eq('ISO + T time', d('2024-03-05T10:22:00Z'), '2024-03-05');
  eq('not a real date', d('2024-02-30'), 'null');
  eq('prose date', d('Jan 5, 2024'), 'null');
  eq('leading space', d(' 2024-03-05'), 'null');
  eq('trailing junk', d('2024-03-05x'), 'null');
  eq('empty', d(''), 'null');
  eq('null', d(null), 'null');
  eq('a number', d(20240305), 'null');
  ok('daysFromIso rejects the lax shape', daysFromIso('2024-3-5') === null);
}

// ── 8. Overlay labels ───────────────────────────────────────────────────────
{
  eq('year label', String(shiftBucketLabel('2024', 'year')), '2023');
  eq('quarter label', String(shiftBucketLabel('2024-Q3', 'quarter')), '2023-Q3');
  eq('month label', String(shiftBucketLabel('2024-03', 'month')), '2023-03');
  eq('week label keeps its weekday (52 weeks)', String(shiftBucketLabel('2024-10-14', 'week')), '2023-10-16');
  eq('day label clamps Feb 29', String(shiftBucketLabel('2024-02-29', 'day')), '2023-02-28');
  ok('a label of the wrong shape → null', shiftBucketLabel('Other', 'month') === null);
}

// ── 9. Moving a scope (module clock pinned) ─────────────────────────────────
{
  process.env.ORDINATE_TODAY = '2024-10-15';
  setCalendar({ weekStart: 1, fiscalYearStart: 7 });
  const cols = [{ name: 'order_date', type: 'date' }, { name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }];
  const fy: FilterStep = { type: 'filter', column: 'order_date', op: 'period', period: { preset: 'this_year' } };
  const west: FilterStep = { type: 'filter', column: 'region', op: '=', value: 'West' };

  const found = scopeRange([west, fy], cols);
  ok('scopeRange reads the fiscal year from the clock', !!found && found.column === 'order_date'
    && found.range.from === '2024-07-01' && found.range.to === '2025-06-30', JSON.stringify(found));

  // Today (Oct 15) is inside this fiscal year, so the comparison is TO DATE.
  const ly = compareScope([west, fy], cols, { mode: 'previous_year' });
  ok('same period last year stops at the same date a year ago', !!ly && ly.prior.from === '2023-07-01' && ly.prior.to === '2023-10-15', JSON.stringify(ly));
  ok('…other filters ride along untouched', !!ly && JSON.stringify(ly.filters[0]) === JSON.stringify(west));
  ok('…and the date filter is replaced, not stacked', !!ly && ly.filters.filter((s) => s.column === 'order_date').length === 1);

  const pp = compareScope([fy], cols, { mode: 'previous_period' });
  ok('previous period of a fiscal year in progress: the same 107 days of the last one',
    !!pp && pp.prior.from === '2023-07-01' && pp.prior.to === '2023-10-15', JSON.stringify(pp));
  const lastFy: FilterStep = { type: 'filter', column: 'order_date', op: 'period', period: { preset: 'last_year' } };
  const whole = compareScope([lastFy], cols, { mode: 'previous_year' });
  ok('a period already over compares whole with whole', !!whole && whole.prior.from === '2022-07-01' && whole.prior.to === '2023-06-30', JSON.stringify(whole));
  const q: FilterStep = { type: 'filter', column: 'order_date', op: 'period', period: { preset: 'this_quarter' } };
  const qtd = compareScope([q], cols, { mode: 'previous_period' });
  ok('this quarter on its 15th day vs the first 15 days of last quarter', !!qtd && qtd.prior.from === '2024-07-01' && qtd.prior.to === '2024-07-15', JSON.stringify(qtd));

  const bounds: FilterStep[] = [
    { type: 'filter', column: 'order_date', op: '>=', value: '2024-03-01' },
    { type: 'filter', column: 'order_date', op: '<', value: '2024-04-01' },
  ];
  const b = compareScope(bounds, cols, { mode: 'previous_period' });
  ok('>= / < bounds intersect to March and move to February', !!b && b.range.from === '2024-03-01' && b.range.to === '2024-03-31'
    && b.prior.from === '2024-02-01' && b.prior.to === '2024-02-29', JSON.stringify(b));

  ok('no date filter → nothing to compare', compareScope([west], cols, { mode: 'previous_year' }) === null);
  const cu = compareScope([west], cols, { mode: 'custom', from: '2023-01-01', to: '2023-03-31' });
  ok('custom needs no date filter — it names its own range on the first date column',
    !!cu && cu.column === 'order_date' && cu.prior.from === '2023-01-01');
  ok('a date bound on a column the dataset lacks is not a scope',
    scopeRange([{ type: 'filter', column: 'ship_date', op: '>=', value: '2024-01-01' }], cols) === null);
  ok('a text column holding an ISO string is not a date bound',
    scopeRange([{ type: 'filter', column: 'region', op: '>=', value: '2024-01-01' }], cols) === null);

  const ov = overlayFilters([west, fy], cols);
  const ovp = ov.find((s) => s.op === 'period');
  ok('overlay filters move back one year', !!ovp && ovp.period!.from === '2023-07-01' && ovp.period!.to === '2024-06-30');
  ok('overlay with no date filter keeps the filters', JSON.stringify(overlayFilters([west], cols)) === JSON.stringify([west]));

  // The period evaluates through the ordinary pipeline under the pinned clock.
  const table = {
    columns: [{ name: 'order_date', type: 'date' as const }],
    rows: [['2024-06-30'], ['2024-07-01'], ['2025-06-30'], ['2025-07-01'], ['07/04/2024'], [''], [null]],
  };
  const kept = applyPipeline(table, [fy]).rows.map((r) => r[0]);
  ok('the fold keeps exactly the fiscal year', JSON.stringify(kept) === '["2024-07-01","2025-06-30","07/04/2024"]', JSON.stringify(kept));
  setCalendar({ weekStart: 1, fiscalYearStart: 1 });
  delete process.env.ORDINATE_TODAY;
}

// ── 10. The caption ─────────────────────────────────────────────────────────
{
  const c = overlayCaption('revenue', [100, 200, null], [80, 170, 50], 'month');
  ok('caption over the paired buckets only', !!c && c.caption === 'Revenue is up 20% vs the same months last year', c && c.caption);
  const d = overlayCaption('profit', [90], [100], 'quarter');
  ok('down', !!d && d.caption === 'Profit is down 10% vs the same quarters last year', d && d.caption);
  const y = overlayCaption('units', [100.2], [100], 'year');
  ok('flat, and a year axis says "the previous year"', !!y && y.caption === 'Units is flat vs the previous year', y && y.caption);
  ok('nothing pairs → no caption', overlayCaption('x', [1, null], [null, 2], 'month') === null);
  ok('zero prior → no caption', overlayCaption('x', [1], [0], 'month') === null);
}

// ── 11. Controls and cards carry the preset, not the dates ──────────────────
{
  const rel = controlSteps({ kind: 'date_range', column: 'd' }, { preset: 'last_n_days', n: 30 });
  ok('a relative control emits a period step with its preset', JSON.stringify(rel) ===
    '[{"type":"filter","column":"d","op":"period","period":{"preset":"last_n_days","n":30}}]', JSON.stringify(rel));
  const abs = controlSteps({ kind: 'date_range', column: 'd' }, { from: '2024-01-01' });
  ok('two fixed dates emit a custom period', JSON.stringify(abs) ===
    '[{"type":"filter","column":"d","op":"period","period":{"preset":"custom","from":"2024-01-01"}}]', JSON.stringify(abs));
  ok('an unset date control filters nothing', controlSteps({ kind: 'date_range', column: 'd' }, {}).length === 0);
  const merged = mergeDashboardFilters(rel, [{ type: 'filter', column: 'd', op: 'period', period: { preset: 'last_year' } }]);
  ok('two different periods on one column are two filters, not a duplicate', merged.length === 2, JSON.stringify(merged));

  const ds = '11111111-1111-4111-8111-111111111111';
  const ctl = sanitizeCard({ type: 'control', control: { kind: 'date_range', label: 'When', datasetId: ds, column: 'd', default: { preset: 'this_year' } } });
  ok('a control default can be a preset', !!ctl && JSON.stringify(ctl.control!.default) === '{"preset":"this_year"}');
  const kpi = sanitizeCard({ type: 'metric', metric: { datasetId: ds, column: 'v', aggregation: 'sum', compare: { mode: 'previous_year' } } });
  ok('a KPI card keeps its compare', !!kpi && kpi.metric!.compare!.mode === 'previous_year');
  const bad = sanitizeCard({ type: 'metric', metric: { datasetId: ds, column: 'v', aggregation: 'sum', compare: { mode: 'nope' } } });
  ok('…and drops a bad one', !!bad && bad.metric!.compare === undefined);
}

finish();
