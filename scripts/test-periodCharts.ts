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
import { H, close, hydrates, post } from './liveRouteHarness';
import type { LiveColumn } from '../src/engine/live/liveSpec';
import type { FilterStep } from '../src/data/transforms';
import type { DateGrain } from '../src/analysis/categoryKey';

const pb: typeof import('../src/analysis/periodBuckets') = require('../src/analysis/periodBuckets');
const mb: typeof import('../src/ipc/metricBuckets') = require('../src/ipc/metricBuckets');
const ck: typeof import('../src/analysis/categoryKey') = require('../src/analysis/categoryKey');
const dateIntel: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');
const ipcMetrics: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const msg: typeof import('../src/analysis/metricCheckMessages') = require('../src/analysis/metricCheckMessages');
const { createHash }: typeof import('crypto') = require('crypto');

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
}).filter((_, i) => !iso(i >> 1).startsWith(GAP_MONTH))
  .concat(Array.from({ length: 31 }, (_, d) => [`2024-10-${String(d + 1).padStart(2, '0')}`, 'New', 40 + d, `2024-10-${String(d + 1).padStart(2, '0')}`])); // a region new this October

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

  // ── chart ─────────────────────────────────────────────────────────────────
  const handlers: Map<string, (e: unknown, arg: unknown) => Promise<Reply>> = require('../src/server/rpc').handlers;
  const chartOn = (dataset: string, encoding: object, filters: FilterStep[], cal?: object): Promise<Reply> => {
    const draw = () => handlers.get('visual:data')!(null, { projectId: P, datasetId: dataset, encoding, filters });
    return cal ? withCalendar(cal, draw) : H.as(H.ORG_A, draw);
  };
  const chart = (encoding: object, filters: FilterStep[], cal?: object): Promise<Reply> => chartOn(D, encoding, filters, cal);
  const M = (m: { id: string }, more: object = {}) => ({ column: 'amt', aggregation: 'sum', metricId: m.id, ...more });
  const pointAt = (r: Reply, label: string): unknown => (r.ok ? r.data.series[0].values[r.data.labels.indexOf(label)] : 'not drawn');
  const OCT = ON('2024-10-01', '2024-10-31');
  const eq = (column: string, value: string) => ({ type: 'filter', column, op: '=', value }) as FilterStep;

  // Old content first: charts with no period measure reply byte for byte as before this step (hash taken on 659e3b9b, before the planner knew a period metric).
  const AVG = await saved({ name: 'Avg sale', definition: { column: 'amt', aggregation: 'avg' }, timeColumn: 'day' });
  const EASTREV = await saved({ name: 'East revenue', definition: { column: 'amt', aggregation: 'sum' }, filters: [eq('region', 'East')], timeColumn: 'day' });
  const PER = await saved({ name: 'Per sale', definition: { formula: '[Revenue] / [Avg sale]' } });
  const RT = { kind: 'running_total', along: 'across' };
  const plainEncodings: [object, FilterStep[]][] = [
    [{ category: 'day', grain: 'month', values: [M(REV)] }, [Y2024]],
    [{ category: 'region', values: [M(REV), M(AVG)] }, [OCT]],
    [{ category: 'day', grain: 'month', values: [M(REV, { calc: RT })] }, [Y2024]],
    [{ category: 'region', values: [M(EASTREV), M(PER)] }, []],
    [{ category: 'day', grain: 'quarter', series: 'region', values: [M(REV)] }, []],
    [{ category: 'day', grain: 'month', values: [M(AVG, { calc: RT })] }, [Y2024]],
    [{ category: 'region', values: [{ column: 'amt', aggregation: 'sum' }] }, [{ ...ON('2024-10-01', '2024-10-31', 'ship'), fromControl: true } as FilterStep]],
  ];
  const plainReplies: unknown[] = [];
  for (const [enc, f] of plainEncodings) {
    const r = await chart(enc, f);
    plainReplies.push(r.asOf ? { ...r, asOf: { ...r.asOf, at: 'the save time' } } : r); // the dataset's save time differs per run
  }
  const PLAIN_PIN = createHash('sha256').update(JSON.stringify(plainReplies)).digest('hex');
  ok('NEGATIVE CONTROL: charts with no period measure are byte-identical', PLAIN_PIN === '3481ffc013281d31e09d41f151b2db62928aa23467e5b8333effd63b213e17a7', PLAIN_PIN);

  const yoy = await saved({ name: 'Revenue YTD vs LY', definition: { base: REV.id, window: { to_date: 'year' }, compare: { vs: 'previous_year', show: 'pct_change' } } });
  const tileUnder = (m: { id: string }, label: string, to = '2024-12-31'): Promise<number | null> => {
    const b = pb.bucketRange(label, 'month')!;
    return kpi(m.id, [ON(b.from, earlier(b.to, to))]);
  };
  const byMonth = await chart({ category: 'day', grain: 'month', values: [M(ytd)] }, [Y2024]);
  const monthTiles = byMonth.ok ? await Promise.all(byMonth.data.labels.map((l: string) => tileUnder(ytd, l))) : [];
  ok('YTD by month: each point is its month\'s tile', byMonth.ok && byMonth.data.labels.length === 11 && byMonth.category?.kind === 'date' && byMonth.data.series[0].values.every((v: unknown, i: number) => typeof v === 'number' && Object.is(v, monthTiles[i])), show(byMonth));
  ok('… a running total, never a month alone', byMonth.ok && Object.is(pointAt(byMonth, '2024-03'), await kpi(REV.id, [ON('2024-01-01', '2024-03-31')])));
  ok('October\'s point is the tile under an October date control', Object.is(pointAt(byMonth, '2024-10'), await kpi(ytd.id, [{ ...OCT, fromControl: true } as FilterStep])));
  ok('November\'s point stops at today', Object.is(pointAt(byMonth, '2024-11'), await kpi(REV.id, [ON('2024-01-01', '2024-11-03')])));
  const FY4 = { weekStart: 1, fiscalYearStart: 4 };
  const fy = await chart({ category: 'day', grain: 'month', values: [M(ytd)] }, [Y2024], FY4);
  const fyJan = await withCalendar(FY4, () => kpi(REV.id, [ON('2023-04-01', '2024-01-31')]));
  ok('under a fiscal year from April, January is April to January', Object.is(pointAt(fy, '2024-01'), fyJan), show([pointAt(fy, '2024-01'), fyJan]));
  ok('NEGATIVE CONTROL: … not a running total starting in January (approach C\'s bug)', !Object.is(pointAt(fy, '2024-01'), pointAt(await chart({ category: 'day', grain: 'month', values: [M(REV)] }, [Y2024], FY4), '2024-01')));
  const byRegion = await chart({ category: 'region', values: [M(yoy)] }, [OCT]);
  const regionTiles = byRegion.ok ? await Promise.all(byRegion.data.labels.map((l: string) => kpi(yoy.id, [OCT, eq('region', l)]))) : [];
  ok('% change by region pairs the two scopes by label', byRegion.ok && byRegion.data.labels.length === 5 && byRegion.data.series[0].values.every((v: unknown, i: number) => Object.is(v, regionTiles[i])), show([byRegion, regionTiles]));
  ok('a region missing last year is null', byRegion.ok && pointAt(byRegion, 'New') === null && typeof pointAt(byRegion, 'East') === 'number', show(byRegion));
  ok('a text axis is named by its metric', byRegion.ok && byRegion.data.series[0].name === 'Revenue YTD vs LY' && byMonth.data.series[0].name === 'Revenue YTD');
  const asStored = { column: 'Revenue YTD', aggregation: 'count', metricId: ytd.id }; // how the web stores a period measure (calc/api metricMeasure)
  ok('the web\'s stored shape draws the same chart', JSON.stringify(await chart({ category: 'day', grain: 'month', values: [asStored] }, [Y2024])) === JSON.stringify(byMonth) && JSON.stringify(await chart({ category: 'region', values: [asStored] }, [OCT])) === JSON.stringify(await chart({ category: 'region', values: [M(ytd)] }, [OCT])));
  const ytdByRegion = await chart({ category: 'region', values: [M(ytd)] }, [OCT]);
  ok('YTD by region: one question over the window', ytdByRegion.ok && Object.is(pointAt(ytdByRegion, 'East'), await kpi(ytd.id, [OCT, eq('region', 'East')])), show(ytdByRegion));

  // "Other" on a compare: the two scopes fold different customers into it, so it has no figure.
  const MANY_COLS: LiveColumn[] = [{ name: 'day', type: 'date' }, { name: 'cust', type: 'text' }, { name: 'amt', type: 'number' }];
  const MANY_ROWS = ['2023-10-05', '2024-10-05'].flatMap((d, y) => Array.from({ length: 60 }, (_, c) => [d, `c${String(c).padStart(2, '0')}`, y ? 100 + c : 200 - c]));
  const DM = (await H.as(H.ORG_A, () => H.datasets.saveDataset(P, { name: 'Customers', sourceKind: 'csv', ...H.fx.importTyped(MANY_COLS, MANY_ROWS) })))!.id;
  const savedOn = async (dataset: string, input: Record<string, unknown>): Promise<{ id: string; name: string }> => (await post('metric:save', { projectId: P, input: { datasetId: dataset, ...input } })).value.metric;
  const custRev = await savedOn(DM, { name: 'Customer revenue', definition: { column: 'amt', aggregation: 'sum' }, timeColumn: 'day' });
  const custYoy = await savedOn(DM, { name: 'Customer revenue vs LY', definition: { base: custRev.id, compare: { vs: 'previous_year', show: 'change' } } });
  const folded = await chartOn(DM, { category: 'cust', values: [M(custYoy)] }, [OCT]);
  ok('"Other" on a compare is null, the customers kept either side are paired', folded.ok && folded.data.labels.includes('Other') && pointAt(folded, 'Other') === null && Object.is(pointAt(folded, 'c30'), 130 - 170), show(folded));
  ok('a customer folded into last year\'s "Other" is null', folded.ok && pointAt(folded, 'c55') === null, show(folded));
  const unfolded = await chartOn(DM, { category: 'cust', values: [M(custYoy)] }, [OCT, { type: 'filter', column: 'cust', op: 'in', values: ['c01', 'c02'] } as FilterStep]);
  ok('NEGATIVE CONTROL: with nothing folded every customer has its change', unfolded.ok && Object.is(pointAt(unfolded, 'c01'), 101 - 199), show(unfolded));

  // Live: the same points as its ISO extract twin, never hydrated, one statement per bucket plus the axis.
  const isoCell = (c: unknown): unknown => (typeof c === 'string' && /^\d+\/\d+\/\d{4}$/.test(c) ? `${c.split('/')[2]}-${c.split('/')[0].padStart(2, '0')}-${c.split('/')[1].padStart(2, '0')}` : c);
  const ISO_ROWS = ROWS.map((r) => [isoCell(r[0]), ...r.slice(1)]);
  const DI = (await H.as(H.ORG_A, () => H.datasets.saveDataset(P, { name: 'Sales ISO', sourceKind: 'csv', ...H.fx.importTyped(COLS, ISO_ROWS as never) })))!.id;
  await H.as(H.ORG_A, () => H.fx.loadWarehouse('sales', COLS, ISO_ROWS as never));
  const L = (await H.as(H.ORG_A, () => H.liveOver(P, { table: 'sales' }, COLS))).liveId;
  const revI = await savedOn(DI, { name: 'ISO revenue', definition: { column: 'amt', aggregation: 'sum' }, timeColumn: 'day' });
  const ytdI = await savedOn(DI, { name: 'ISO revenue YTD', definition: { base: revI.id, window: { to_date: 'year' } } });
  const revL = await savedOn(L, { name: 'Live revenue', definition: { column: 'amt', aggregation: 'sum' }, timeColumn: 'day' });
  const ytdL = await savedOn(L, { name: 'Live revenue YTD', definition: { base: revL.id, window: { to_date: 'year' } } });
  const calls = H.fake.calls.length;
  const live = await hydrates(L, () => chartOn(L, { category: 'day', grain: 'month', values: [M(ytdL)] }, [Y2024]));
  const statements = H.fake.calls.length - calls;
  const twin = await chartOn(DI, { category: 'day', grain: 'month', values: [M(ytdI)] }, [Y2024]);
  ok('Live: the extract twin\'s points, never hydrated', live.value.ok && twin.ok && JSON.stringify(live.value.data.labels) === JSON.stringify(twin.data.labels) && live.value.data.series[0].values.every((v: unknown, i: number) => typeof v === 'number' && Object.is(v, twin.data.series[0].values[i])) && !live.hydrated, show([live, twin]));
  ok('Live: one statement per bucket, plus the axis', statements >= 1 && statements <= 11 + 1, String(statements));
  const liveByRegion = await hydrates(L, () => chartOn(L, { category: 'region', values: [M(ytdL)] }, [OCT]));
  ok('Live: by region too', liveByRegion.value.ok && Object.is(pointAt(liveByRegion.value, 'East'), pointAt(await chartOn(DI, { category: 'region', values: [M(ytdI)] }, [OCT]), 'East')) && !liveByRegion.hydrated, show(liveByRegion));

  // Refused, not guessed.
  const twiceYtd = await saved({ name: 'Twice YTD', definition: { formula: '[Revenue YTD] * 2' } });
  const refusals: [object, string][] = [
    [{ category: 'day', grain: 'month', values: [M(ytd), M(REV)] }, msg.measureChartsAlone('Revenue YTD')],
    [{ category: 'day', grain: 'month', values: [M(REV), M(ytd)] }, msg.measureChartsAlone('Revenue YTD')],
    [{ category: 'day', grain: 'month', series: 'region', values: [M(ytd)] }, msg.measureChartsAlone('Revenue YTD')],
    [{ category: 'region', values: [M(ytd)], facet: { cols: 'region' } }, msg.measureChartsAlone('Revenue YTD')],
    [{ category: 'region', values: [M(REV)], pivot: { rows: [{ column: 'region' }], columns: [], values: [M(ytd)] } }, msg.measureChartsAlone('Revenue YTD')],
    [{ category: 'ship', grain: 'month', values: [M(ytd)] }, msg.periodOtherDate('Revenue YTD', 'day', 'ship')],
    [{ category: 'region', values: [M(twiceYtd)] }, msg.periodInChartFormula('Revenue YTD')],
  ];
  for (const [enc, err] of refusals) {
    const r = await chart(enc, []);
    ok(`refused: ${err} (${show(enc).slice(0, 120)})`, r.ok === false && r.error === err, show(r));
  }
  ok('NEGATIVE CONTROL: a second measure under a split is not drawn, so it is not refused', (await chart({ category: 'day', grain: 'month', series: 'region', values: [M(REV), M(ytd)] }, [Y2024])).ok === true);
  const rt = await chart({ category: 'day', grain: 'month', values: [M(ytd, { calc: RT })] }, [Y2024]);
  ok('a running total along months over YTD is refused (it does not add up over time)', rt.ok === false && rt.code === 'calc_not_additive', show(rt));
  const share = await chart({ category: 'region', values: [M(ytd, { calc: { kind: 'pct_of_total', along: 'across' } })] }, [OCT]);
  ok('a share of total across regions over YTD is drawn (its base adds across categories)', share.ok === true, show(share));
  ok('NEGATIVE CONTROL: … but not over a % change, which adds across nothing', (await chart({ category: 'region', values: [M(yoy, { calc: { kind: 'pct_of_total', along: 'across' } })] }, [OCT])).code === 'calc_not_additive');

  // The Data model's "adds up": a window as its base across categories, never across time; a compare, neither.
  const additivity: typeof import('../src/analysis/additivity') = require('../src/analysis/additivity');
  const metricsMod: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
  const addsUp = (id: string) => H.as(H.ORG_A, async () => JSON.stringify(await additivity.metricAdditivity(P, id, await metricsMod.metricsByName(P))));
  const avgYtd = await saved({ name: 'Avg sale YTD', definition: { base: AVG.id, window: { to_date: 'year' } } });
  const DOUBLE = await saved({ name: 'Double revenue', definition: { formula: '[Revenue] * 2' } });
  const doubleYtd = await saved({ name: 'Double revenue YTD', definition: { base: DOUBLE.id, window: { to_date: 'year' } } });
  const perYtd = await saved({ name: 'Per sale YTD', definition: { base: PER.id, window: { to_date: 'year' } } });
  const YES_CATS = '{"categories":true,"time":false}', NEITHER = '{"categories":false,"time":false}';
  ok('adds up: YTD across categories, not over time', (await addsUp(ytd.id)) === YES_CATS, await addsUp(ytd.id));
  ok('adds up: last 7 days the same', (await addsUp(d7.id)) === YES_CATS);
  ok('adds up: a compare adds across neither', (await addsUp(yoy.id)) === NEITHER);
  ok('adds up: a window over an average adds across neither', (await addsUp(avgYtd.id)) === NEITHER);
  ok('adds up: a window over an additive formula, across categories', (await addsUp(doubleYtd.id)) === YES_CATS, await addsUp(doubleYtd.id));
  ok('adds up: … over a ratio, neither', (await addsUp(perYtd.id)) === NEITHER);
  ok('NEGATIVE CONTROL: the base adds up both ways', (await addsUp(REV.id)) === '{"categories":true,"time":true}');

  // ── spark ─────────────────────────────────────────────────────────────────
  // The Metrics table's sparkline: the last 12 months, each point its month's tile (a label filter would give "to today").
  const table = (await post('metric:table', { projectId: P })).value;
  const spark: (number | null)[] | null = table.rows?.[ytd.id]?.series ?? null;
  const months = Array.from({ length: 12 }, (_, i) => labelOf(dateIntel.isoFromDays(dateIntel.daysFromIso('2023-12-01')! + 31 * i), 'month'));
  const sparkTiles = await Promise.all(months.map((l) => tileUnder(ytd, l, '2024-11-30')));
  ok('the sparkline: 12 months, each its month\'s tile', Array.isArray(spark) && spark.length === 12 && spark.every((v, i) => Object.is(v, sparkTiles[i])) && typeof spark[11] === 'number', show([spark, sparkTiles]));
  ok('… June, with no rows, is still January to June', Array.isArray(spark) && Object.is(spark[6], await kpi(REV.id, [ON('2024-01-01', '2024-06-30')])));
  const sparkSeries = await H.as(H.ORG_A, () => ipcMetrics.resolveMetricSeries(P, ytd.id, 'day'));
  ok('resolveMetricSeries: the labels and the tile\'s own text', sparkSeries?.labels.join() === months.join() && sparkSeries.display.length === 12 && typeof sparkSeries.display[11] === 'string' && sparkSeries.display[11] !== '—', show(sparkSeries));
  const tree = await H.as(H.ORG_A, () => ipcMetrics.resolveMetricSeries(P, ytd.id, 'day', { points: 6 }));
  ok('fewer points when asked (the metric tree)', tree?.labels.join() === months.slice(-6).join(), show(tree));
  ok('NEGATIVE CONTROL: the base keeps its own sparkline (insightsAgg periods, a label filter each: here its last 24 days)', table.rows?.[REV.id]?.series?.length === 24 && JSON.stringify(table.rows[REV.id].series) === JSON.stringify((await H.as(H.ORG_A, () => ipcMetrics.resolveMetricSeries(P, REV.id, 'day')))?.values), show(table.rows?.[REV.id]?.series));

  // The published page draws the chart the live page draws.
  const visualsMod: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
  const analysisMod: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
  const { buildDashboard }: typeof import('../src/publish/dashboardData') = require('../src/publish/dashboardData');
  const { randomUUID }: typeof import('crypto') = require('crypto');
  const YTD_ENC = { category: 'day', grain: 'month', values: [asStored] };
  const built = await H.as(H.ORG_A, async () => {
    const v = await visualsMod.saveVisual(P, { datasetId: D, name: 'YTD by month', chartType: 'line', encoding: YTD_ENC, filters: [Y2024] } as never);
    const dash = await analysisMod.saveAnalysis(P, { name: 'Period', sheets: [{ id: randomUUID(), name: 'Main', cards: [{ id: randomUUID(), type: 'visual', visualId: v!.id, layout: { x: 0, y: 0, w: 6, h: 4 } }] }] } as never);
    return buildDashboard(P, dash!.id, 8);
  });
  const liveValues = (await chart(YTD_ENC, [Y2024])).data.series[0].values;
  ok('a published YTD chart has the live chart\'s points', !!built && JSON.stringify(built).includes(JSON.stringify(liveValues)) && liveValues.length === 11, show([liveValues, JSON.stringify(built).slice(0, 400)]));

  await close();
  finish();
})().catch((err) => {
  ok('test-periodCharts ran to completion', false, err && err.stack ? err.stack : err);
  finish();
});
