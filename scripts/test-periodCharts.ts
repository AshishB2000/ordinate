// Period metrics on charts (semantic layer part 5, step 06: D10's second and third bullets, the additivity bullet):
// every point equals its tile.
//
//   buckets   a date axis's labels as days (src/analysis/periodBuckets.ts), gaps filled, any calendar; the per-bucket
//             loop (src/ipc/metricBuckets.ts bucketSeries): each bucket is the tile over its days, at most 24
//
// Every guard has its NEGATIVE CONTROL beside it.
//
//   npm run build:ts && node scripts/test-periodCharts.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, post } from './liveRouteHarness';
import type { LiveColumn } from '../src/engine/live/liveSpec';
import type { FilterStep } from '../src/data/transforms';
import type { DateGrain } from '../src/analysis/categoryKey';

const pb: typeof import('../src/analysis/periodBuckets') = require('../src/analysis/periodBuckets');
const mb: typeof import('../src/ipc/metricBuckets') = require('../src/ipc/metricBuckets');
const ck: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
const dateIntel: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');
const ipcMetrics: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const msg: typeof import('../src/analysis/metricCheckMessages') = require('../src/analysis/metricCheckMessages');

process.env.ORDINATE_TODAY = '2024-11-03'; // after the harness pinned its own: every period below resolves against this day
const show = (v: unknown): string => JSON.stringify(v).slice(0, 600);
const ON = (from: string, to: string, column = 'day'): FilterStep => ({ type: 'filter', column, op: 'period', period: { preset: 'custom', from, to } }) as FilterStep;
const labelOf = (iso: string, g: DateGrain): string => ck.dateBucketLabel(ck.dateBucket(ck.parseDateCell(iso)!, g), g);
const dayAfter = (iso: string): string => dateIntel.isoFromDays(dateIntel.daysFromIso(iso)! + 1);
const earlier = (a: string, b: string): string => (a <= b ? a : b);
const GREG = { weekStart: 1, fiscalYearStart: 1 };
/** `fn` under the workspace calendar `cal`, in acme's scope; the calendar is put back after. */
const withCalendar = <T>(cal: object, fn: () => Promise<T>): Promise<T> => H.as(H.ORG_A, async () => {
  dateIntel.setCalendar(cal);
  try {
    return await fn();
  } finally {
    dateIntel.setCalendar(GREG);
  }
});

// SALES: two rows a day from 2023-01-01 to 2024-11-03, every seventh day written the US way; `ship` a few days
// later. June 2024 has no rows at all (GAP_MONTH): the gap a date axis must still draw.
const COLS: LiveColumn[] = [{ name: 'day', type: 'date' }, { name: 'region', type: 'text' }, { name: 'amt', type: 'number' }, { name: 'ship', type: 'date' }];
const iso = (n: number): string => new Date(Date.UTC(2023, 0, 1) + n * 86400000).toISOString().slice(0, 10);
const us = (d: string): string => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}/${d.slice(0, 4)}`;
const DAYS = 673; // 2023-01-01 … 2024-11-03
const GAP_MONTH = '2024-06';
const ROWS = Array.from({ length: DAYS * 2 }, (_, i) => {
  const n = i >> 1;
  return [n % 7 === 3 ? us(iso(n)) : iso(n), ['North', 'South', 'East', 'West'][i % 4], ((i * 37) % 101) + (n % 13), iso(n + (i % 5))];
}).filter((_, i) => !iso(i >> 1).startsWith(GAP_MONTH));

void (async () => {
  // ── buckets ───────────────────────────────────────────────────────────────
  await H.as(H.ORG_A, async () => {
    for (const g of ['day', 'week', 'month', 'quarter', 'year'] as const) {
      const label = labelOf('2024-02-29', g);
      const r = pb.bucketRange(label, g);
      ok(`bucketRange inverts the axis label: ${g}`, !!r && r.from <= '2024-02-29' && r.to >= '2024-02-29' && labelOf(r.from, g) === label && labelOf(r.to, g) === label && labelOf(dayAfter(r.to), g) !== label, show([label, r]));
    }
    ok('bucketRange: a week names its Monday', pb.bucketRange('2024-02-26', 'week')?.to === '2024-03-03' && pb.bucketRange('2024-02-27', 'week') === null);
    ok('bucketRange: February 2024 has 29 days, Q1 ends in March', pb.bucketRange('2024-02', 'month')?.to === '2024-02-29' && pb.bucketRange('2024-Q1', 'quarter')?.to === '2024-03-31' && pb.bucketRange('2024', 'year')?.to === '2024-12-31');
    ok('NEGATIVE CONTROL: not a label of the grain, or no such day', pb.bucketRange('2024-02', 'day') === null && pb.bucketRange('2024-02-30', 'day') === null && pb.bucketRange('Other', 'month') === null && pb.bucketRange('2024-13', 'month') === null);
    ok('fillBuckets fills a gap', JSON.stringify(pb.fillBuckets(['2024-01', '2024-04'], 'month')) === JSON.stringify(['2024-01', '2024-02', '2024-03', '2024-04']));
    ok('fillBuckets: in order, an unreadable label left out', JSON.stringify(pb.fillBuckets(['2024-Q3', '(blank)', '2024-Q1'], 'quarter')) === JSON.stringify(['2024-Q1', '2024-Q2', '2024-Q3']));
    ok('fillBuckets: weeks across a year end', JSON.stringify(pb.fillBuckets(['2024-12-23', '2025-01-06'], 'week')) === JSON.stringify(['2024-12-23', '2024-12-30', '2025-01-06']));
  });
  await withCalendar({ ...GREG, calendarType: '445', yearEnd: 'nearest' }, async () => {
    const first = labelOf('2024-06-03', 'month');
    const second = labelOf(dayAfter(pb.bucketRange(first, 'month')!.to), 'month');
    const third = labelOf(dayAfter(pb.bucketRange(second, 'month')!.to), 'month');
    const filled = pb.fillBuckets([first, third], 'month');
    ok('fillBuckets under a week calendar uses its periods', /^FY\d\d P\d\d$/.test(first) && filled.length === 3 && filled[1] === second, show([first, second, third, filled]));
    const r = pb.bucketRange(first, 'month')!;
    ok('bucketRange under a week calendar: its first and last day are in the period, the day after is not', labelOf(r.from, 'month') === first && labelOf(r.to, 'month') === first && labelOf(dayAfter(r.to), 'month') === second, show(r));
  });

  const s = await H.setupOrg(H.ORG_A);
  const P = s.projectId;
  const D = (await H.as(H.ORG_A, () => H.datasets.saveDataset(P, { name: 'Sales', sourceKind: 'csv', ...H.fx.importTyped(COLS, ROWS) })))!.id;
  ok('fixture: June 2024 has no rows', !ROWS.some((r) => String(r[0]).startsWith(GAP_MONTH) || String(r[0]).startsWith('6/') && String(r[0]).endsWith('/2024')));
  const saved = async (input: Record<string, unknown>): Promise<{ id: string; name: string }> => {
    const r = (await post('metric:save', { projectId: P, input: { datasetId: D, ...input } })).value;
    if (r.ok !== true) throw new Error(`could not save ${String(input.name)}: ${show(r)}`);
    return { id: r.metric.id, name: r.metric.name };
  };
  const REV = await saved({ name: 'Revenue', definition: { column: 'amt', aggregation: 'sum' }, timeColumn: 'day', format: { kind: 'currency', decimals: 0 } });
  const d7 = await saved({ name: 'Revenue 7d', definition: { base: REV.id, window: { last: 7, unit: 'day' } } });
  const kpi = async (id: string, filters: FilterStep[]): Promise<number | null> => ((await H.as(H.ORG_A, () => ipcMetrics.resolveMetric(P, id, { filters }))) as Reply)?.value ?? null;
  const series = (filters: FilterStep[], grain: DateGrain | undefined, id: string, name: string) => H.as(H.ORG_A, () => mb.bucketSeries(P, D, 'day', grain, filters, async (f) => kpi(id, f), { name }));
  const Y2024 = ON('2024-01-01', '2024-12-31');

  const sm = await series([Y2024], 'month', REV.id, 'Revenue');
  const tiles = sm.ok ? await Promise.all(sm.labels.map((l) => { const b = pb.bucketRange(l, 'month')!; return kpi(REV.id, [ON(b.from, earlier(b.to, '2024-12-31'))]); })) : [];
  ok('each bucket is the tile over that month', sm.ok && sm.grain === 'month' && sm.labels.length === 11 && sm.labels.every((_, i) => typeof tiles[i] === 'number' || sm.labels[i] === GAP_MONTH) && sm.values.every((v, i) => Object.is(v, tiles[i])), show([sm, tiles]));
  ok('a month with no rows is a bucket, not skipped', sm.ok && sm.labels.includes(GAP_MONTH) && sm.values[sm.labels.indexOf(GAP_MONTH)] === null, show(sm));
  const ytd = await saved({ name: 'Revenue YTD', definition: { base: REV.id, window: { to_date: 'year' } } });
  const sy = await series([Y2024], 'month', ytd.id, 'Revenue YTD');
  ok('YTD\'s June is January to June: a figure, though June has no rows', sy.ok && typeof sy.values[5] === 'number' && sy.labels[5] === GAP_MONTH && Object.is(sy.values[5], await kpi(REV.id, [ON('2024-01-01', '2024-06-30')])), show(sy));
  const sd7 = await series([Y2024], 'month', d7.id, 'Revenue 7d');
  ok('last 7 days by month: each month\'s last 7 days', sd7.ok && sd7.values[5] === null && Object.is(sd7.values[6], await kpi(REV.id, [ON('2024-07-25', '2024-07-31')])), show(sd7));
  const auto = await series([ON('2024-01-01', '2024-01-20')], undefined, REV.id, 'Revenue');
  ok('no grain: the door\'s own grain (20 days are days)', auto.ok && auto.grain === 'day' && auto.labels.length === 20, show(auto));
  const autoYear = await series([Y2024], undefined, REV.id, 'Revenue');
  ok('no grain over 2024: the door\'s weeks, 44 of them, refused', !autoYear.ok && autoYear.error === msg.periodTooManyBuckets('Revenue', 'week', 44), show(autoYear));
  const too = await series([ON('2024-01-01', '2024-01-25')], 'day', d7.id, 'Revenue 7d');
  ok('25 buckets are refused, naming the Moving sum', !too.ok && too.error === msg.periodTooManyBuckets('Revenue 7d', 'day', 25), show(too));
  const fine = await series([ON('2024-01-01', '2024-01-24')], 'day', d7.id, 'x');
  ok('NEGATIVE CONTROL: 24 are drawn', fine.ok === true && fine.labels.length === 24, show(fine));
  const last = await H.as(H.ORG_A, () => mb.bucketSeries(P, D, 'day', 'month', [], async (f) => kpi(REV.id, f), { name: 'Revenue', last: 12 }));
  ok('last: the latest 12 buckets of a longer axis, never refused', last.ok && last.labels.length === 12 && last.labels[11] === '2024-11' && last.labels[0] === '2023-12', show(last));
  ok('NEGATIVE CONTROL: … the whole axis is 23 months', ((await series([], 'month', REV.id, 'Revenue')) as { labels?: string[] }).labels?.length === 23);
  const scoped = await series([ON('2024-03-15', '2024-05-10')], 'month', REV.id, 'Revenue');
  ok('a bucket is cut to the scope: March from the 15th, May to the 10th', scoped.ok && Object.is(scoped.values[0], await kpi(REV.id, [ON('2024-03-15', '2024-03-31')])) && Object.is(scoped.values[2], await kpi(REV.id, [ON('2024-05-01', '2024-05-10')])), show(scoped));
  ok('NEGATIVE CONTROL: … not the whole of March', scoped.ok && !Object.is(scoped.values[0], await kpi(REV.id, [ON('2024-03-01', '2024-03-31')])));

  await close();
  finish();
})().catch((err) => {
  ok('test-periodCharts ran to completion', false, err && err.stack ? err.stack : err);
  finish();
});
