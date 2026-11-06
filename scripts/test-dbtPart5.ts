// The dbt import of part 5's shapes (semantic layer part 7, f2; docs/semantic-layer/07-portability.md D10,
// 05-metrics-depth.md D8–D9), over scripts/fixtures/dbt-part5/ (README.md says what MetricFlow does, from dbt's docs).
//
// § cumulative  cumulativeWindow reads dbt's window as the Ordinate window that sums the same rows each day (N days or
//               weeks as `last N days`, a month, quarter or year to date on dbt's calendar). translateDbt still imports
//               no cumulative metric: none matches dbt at every period. `period_agg: last` reads a period at its last day
//               whose window holds rows, Ordinate at the period's last day (no figure when that window is empty), so it
//               is skipped `period_agg_last`; `first` and `average` read it otherwise (`period_agg`). Every other shape
//               is skipped for its own reason, and so are conversions, time offsets and window groupings.
// § route       model:importPlan and model:importApply: each one listed with its reason, the bases imported, a re-import
//               writes nothing; the calendar picks the reason and so moves the hash, and a stale apply is refused.
// § figures     NEGATIVE CONTROL for period_agg_last: the period metric the import would write for each window equals
//               expected.json on every day (Object.is), and at every ended week, month, quarter and year except exactly
//               the 14 whose last window holds no row, where it has no figure and MetricFlow an earlier day's.
// § controls    NEGATIVE CONTROLS, each skip load-bearing: period_agg first and average, a 1-month window, a count's
//               window, a year compare and a funnel each give another figure than MetricFlow's.
// § old imports f1's translation is byte-identical outside the four kinds (its golden, sha256-pinned).
//
//   npm run build:ts && node scripts/test-dbtPart5.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { H, close, post, type Reply } from './liveRouteHarness';
import { P5, P5_DIR, P5_DATASETS, P5_COLUMNS, F1_MANIFEST, F1_DATASETS, metricNamed, allMetricNames, dropFourKinds, withoutFourKinds, uploadJson, csvRows } from './dbtHarness';
import type { ModelMetric } from '../src/app/modelFormat';

const { isDeepStrictEqual }: typeof import('util') = require('util');
const { translateDbt }: typeof import('../src/app/dbtImport') = require('../src/app/dbtImport');
const { cumulativeWindow }: typeof import('../src/app/dbtCumulative') = require('../src/app/dbtCumulative');
const { DEFAULT_CALENDAR }: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');
const { stableStringify }: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
const { modelPlanChanged }: typeof import('../src/app/modelFileMessages') = require('../src/app/modelFileMessages');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { createHash }: typeof import('crypto') = require('crypto');

process.env.ORDINATE_TODAY = '2024-07-01'; // after every seed row: every bucket below has ended

const show = (v: unknown): string => JSON.stringify(v)?.slice(0, 600) ?? String(v);

(async () => {
  // ── § cumulative ───────────────────────────────────────────────────────────
  const W = (tp: unknown, cal = DEFAULT_CALENDAR) => cumulativeWindow(tp, cal);
  const skipOf = (r: ReturnType<typeof cumulativeWindow>): string | undefined => ('skip' in r ? r.skip : undefined);
  const ctp = (o: object) => ({ cumulative_type_params: { period_agg: 'last', ...o } });
  const SUN = { ...DEFAULT_CALENDAR, weekStart: 0 }, APR = { ...DEFAULT_CALENDAR, fiscalYearStart: 4 }, R445 = { ...DEFAULT_CALENDAR, calendarType: '445' as const };
  ok('7 days', isDeepStrictEqual(W(ctp({ window: { count: 7, granularity: 'day' } })), { window: { last: 7, unit: 'day' } }));
  ok('the plural granularity is the same unit', isDeepStrictEqual(W(ctp({ window: { count: 7, granularity: 'days' } })), { window: { last: 7, unit: 'day' } }));
  ok('2 weeks is 14 days, never calendar weeks (RF 2)', isDeepStrictEqual(W(ctp({ window: { count: 2, granularity: 'week' } })), { window: { last: 14, unit: 'day' } }));
  ok('366 days and 52 weeks are the longest', 'window' in W(ctp({ window: { count: 366, granularity: 'day' } })) && 'window' in W(ctp({ window: { count: 52, granularity: 'week' } })));
  for (const [tp, why] of [
    [ctp({ window: { count: 1, granularity: 'month' } }), 'window_unit'], // RF 2
    [ctp({ window: { count: 367, granularity: 'day' } }), 'window_unit'], [ctp({ window: { count: 53, granularity: 'week' } }), 'window_unit'],
    [ctp({ window: { count: 12, granularity: 'hour' } }), 'window_unit'], [ctp({ grain_to_date: 'day' }), 'window_unit'], [ctp({ grain_to_date: 'fiscal_quarter' }), 'window_unit'],
    [ctp({ window: { count: 0, granularity: 'day' } }), 'cumulative'], [ctp({ window: { count: 1.5, granularity: 'day' } }), 'cumulative'], [ctp({ window: '7 days' }), 'cumulative'],
    [{ cumulative_type_params: { window: { count: 7, granularity: 'day' } } }, 'period_agg'], // RF 1: dbt's default is first
    [ctp({ window: { count: 7, granularity: 'day' }, period_agg: 'first' }), 'period_agg'], [ctp({ window: { count: 7, granularity: 'day' }, period_agg: 'average' }), 'period_agg'],
    [{ window: { count: 7, granularity: 'day' } }, 'period_agg'], // an older manifest: top-level window, no period_agg
    [ctp({}), 'all_time'], [ctp({ window: { count: 7, granularity: 'day' }, grain_to_date: 'month' }), 'cumulative'],
    [{ window: { count: 7, granularity: 'day' }, cumulative_type_params: { window: { count: 8, granularity: 'day' }, period_agg: 'last' } }, 'cumulative'],
    [{ grain_to_date: 'year', cumulative_type_params: { grain_to_date: 'month', period_agg: 'last' } }, 'cumulative'],
    [ctp({ grain_to_date: 'week' }), 'calendar_differs'], // MetricFlow's week is its warehouse's date_trunc: not in dbt's docs
    [null, 'all_time'], ['x', 'all_time'],
  ] as const) ok(`skip ${why}: ${JSON.stringify(tp)}`, skipOf(W(tp)) === why, show(W(tp)));
  ok('the same window in both places is read once', isDeepStrictEqual(W({ window: { count: 7, granularity: 'day' }, cumulative_type_params: { window: { count: 7, granularity: 'day' }, period_agg: 'last' } }), { window: { last: 7, unit: 'day' } }));
  ok('month, quarter and year to date, dbt\'s calendar', ['month', 'quarter', 'year'].every((g) => isDeepStrictEqual(W(ctp({ grain_to_date: g })), { window: { to_date: g } })));
  ok('calendar differs (RF 3)', skipOf(W(ctp({ grain_to_date: 'week' }), SUN)) === 'calendar_differs' && ['quarter', 'year'].every((g) => skipOf(W(ctp({ grain_to_date: g }), APR)) === 'calendar_differs')
    && ['month', 'quarter', 'year'].every((g) => skipOf(W(ctp({ grain_to_date: g }), R445)) === 'calendar_differs') && skipOf(W(ctp({ grain_to_date: 'month' }), { ...DEFAULT_CALENDAR, calendarType: 'iso' })) === 'calendar_differs');
  ok('under April and 4-4-5, month to date (April) and last 7 days still map', 'window' in W(ctp({ grain_to_date: 'month' }), APR) && 'window' in W(ctp({ window: { count: 7, granularity: 'day' } }), R445));
  ok('a Sunday week and an explicit Gregorian calendar change nothing else', 'window' in W(ctp({ grain_to_date: 'year' }), SUN) && 'window' in W(ctp({ grain_to_date: 'year' }), { ...DEFAULT_CALENDAR, calendarType: 'gregorian' }));

  const { model, skipped } = translateDbt(P5, P5_DATASETS, {}, DEFAULT_CALENDAR);
  const m = (n: string): ModelMetric => metricNamed(model, n);
  const WINDOWS = ['revenue_7d', 'revenue_2w', 'revenue_mtd', 'revenue_qtd', 'revenue_ytd', 'eu_revenue_7d'];
  const SKIPS: Array<[string, string]> = [
    ...WINDOWS.map((n): [string, string] => [n, 'period_agg_last']), ['eu_share_7d', 'period_agg_last'],
    ['revenue_wtd', 'calendar_differs'], ['revenue_7d_first', 'period_agg'], ['revenue_7d_average', 'period_agg'], ['revenue_all_time', 'all_time'], ['revenue_rolling_month', 'window_unit'],
    ['revenue_7d_filled', 'fill_nulls'], ['refunds_7d', 'no_base_metric'], ['mrr_7d', 'cumulative'], ['orders_7d', 'count_window'], ['aov_7d', 'period_agg_last'], ['visit_to_buy', 'conversion'], ['revenue_ly', 'time_offset'],
    ['revenue_yoy_change', 'time_offset'], ['revenue_yoy_growth', 'time_offset'], ['mrr', 'window_groupings'], ['mrr_two', 'window_groupings'], ['mrr_first', 'window_groupings'],
  ];
  for (const [name, why] of SKIPS) ok(`${name}: skipped, ${why} (RF 1, 2, 5)`, skipped.some((s) => s.name === name && s.kind === 'metric' && s.reason === why) && !m(name), show(skipped.filter((s) => s.name === name)));
  ok('every metric is translated or named, never both', allMetricNames(P5).every((n) => !!m(n) !== skipped.some((s) => s.name === n && s.kind === 'metric')));
  ok('no cumulative metric is imported: only the three bases', isDeepStrictEqual(model.metrics.map((x) => x.name).sort(), ['orders', 'refunds_card', 'revenue']), show(model.metrics.map((x) => x.name)));
  ok('a formula over windows falls with its first input', skipped.some((s) => s.name === 'eu_share_7d' && s.because === 'eu_revenue_7d') && skipped.some((s) => s.name === 'aov_7d' && s.because === 'revenue_7d'));
  ok('under 4-4-5, every to-date is calendar_differs and a 7-day window still period_agg_last', ['revenue_mtd', 'revenue_qtd', 'revenue_ytd'].every((n) => translateDbt(P5, P5_DATASETS, {}, R445).skipped.some((s) => s.name === n && s.reason === 'calendar_differs')) && translateDbt(P5, P5_DATASETS, {}, R445).skipped.some((s) => s.name === 'revenue_7d' && s.reason === 'period_agg_last'));
  const noBase = JSON.parse(JSON.stringify(P5));
  noBase.metrics = noBase.metrics.filter((x: { name: string }) => x.name !== 'revenue');
  ok('with its base gone, a window is no_base_metric', translateDbt(noBase, P5_DATASETS, {}, DEFAULT_CALENDAR).skipped.some((s) => s.name === 'revenue_7d' && s.reason === 'no_base_metric'));
  const noDate = JSON.parse(JSON.stringify(P5));
  noDate.semantic_models[0].dimensions = noDate.semantic_models[0].dimensions.filter((d: { type: string }) => d.type !== 'time');
  noDate.semantic_models[0].defaults = null;
  ok('a base with no date is no base', translateDbt(noDate, P5_DATASETS, {}, DEFAULT_CALENDAR).skipped.some((s) => s.name === 'revenue_7d' && s.reason === 'no_base_metric'));
  ok('no dataset for its model: no_dataset', translateDbt(P5, P5_DATASETS.slice(1), {}, DEFAULT_CALENDAR).skipped.some((s) => s.name === 'revenue_7d' && s.reason === 'no_dataset' && s.model === 'orders'));
  const orFilter = JSON.parse(JSON.stringify(P5));
  orFilter.metrics.find((x: { name: string }) => x.name === 'eu_revenue_7d').filter = { where_filters: [{ where_sql_template: "{{ Dimension('order__region') }} = 'EU' OR {{ Dimension('order__status') }} = 'paid'" }] };
  ok('a filter outside f1\'s grammar: filter_shape', translateDbt(orFilter, P5_DATASETS, {}, DEFAULT_CALENDAR).skipped.some((s) => s.name === 'eu_revenue_7d' && s.reason === 'filter_shape'));
  const noMeasure = JSON.parse(JSON.stringify(P5));
  noMeasure.metrics.find((x: { name: string }) => x.name === 'revenue_7d').type_params.measure = null; // dbt's newer spec names input_metric; its manifest is not in the docs
  ok('no measure input (the newer spec): unreadable', translateDbt(noMeasure, P5_DATASETS, {}, DEFAULT_CALENDAR).skipped.some((s) => s.name === 'revenue_7d' && s.reason === 'unreadable'));
  ok('translating twice is the same', JSON.stringify(translateDbt(P5, P5_DATASETS, {}, DEFAULT_CALENDAR)) === JSON.stringify({ model, skipped }));

  // ── § route ────────────────────────────────────────────────────────────────
  const seedProject = async (name: string, only?: Array<keyof typeof P5_COLUMNS>): Promise<{ P: string; ds: Record<string, string> }> => H.as(H.ORG_A, async () => {
    await H.projects.init();
    const P = (await H.projects.createProject(name)).id;
    const ds: Record<string, string> = {};
    for (const n of only ?? (['orders', 'balances', 'events'] as const)) {
      const d = await H.datasets.saveDataset(P, { name: n, sourceKind: 'csv', columns: P5_COLUMNS[n], rows: csvRows(path.join(P5_DIR, `${n}.csv`), P5_COLUMNS[n]) });
      if (!d) throw new Error(`dataset ${n} not saved`);
      ds[n] = d.id;
    }
    return { P, ds };
  });
  const planOf = async (P: string): Promise<Reply> => (await post('model:importPlan', { projectId: P, fileToken: await uploadJson(P5) })).value;
  const applyOf = async (P: string, planHash: string): Promise<Reply> => (await post('model:importApply', { projectId: P, fileToken: await uploadJson(P5), planHash })).value;
  const fileId = (dbt: string): string | undefined => model.metrics.find((x) => x.importedFrom?.name === dbt)?.id;
  const itemFor = (plan: Reply, dbt: string): Reply | undefined => plan.plan?.items.find((i: Reply) => i.key === `metric:${fileId(dbt)}` || i.key === `metric:dbt:${dbt}`);
  const BECAUSE: Record<string, string> = { eu_share_7d: 'eu_revenue_7d', aov_7d: 'revenue_7d' }; // a formula falls with its input, listed under it
  const stored = async (P: string) => H.as(H.ORG_A, async () => {
    const metricsMod: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
    return Promise.all((await metricsMod.listMetrics(P)).map((x) => metricsMod.getMetric(P, x.id)));
  });

  const S = await seedProject('dbt part 5');
  const plan = await planOf(S.P);
  ok('the dry run answers', plan.ok === true, show(plan));
  ok('the bases are new (the editor\'s own checks passed)', model.metrics.every((x) => itemFor(plan, x.importedFrom?.name as string)?.status === 'new'), show(plan.plan?.items.filter((i: Reply) => i.kind === 'metric' && i.status !== 'new' && i.status !== 'skipped')));
  const planReason = (n: string, why: string): string => (BECAUSE[n] ? 'depends_on_skipped' : why);
  ok('each skip is listed with its reason', SKIPS.every(([n, why]) => itemFor(plan, n)?.status === 'skipped' && itemFor(plan, n)?.reason === planReason(n, why)), show(SKIPS.map(([n]) => itemFor(plan, n)).filter((i) => i?.status !== 'skipped' || i.reason !== planReason(i.name, SKIPS.find(([x]) => x === i.name)?.[1] ?? ''))));
  ok('… a formula over a window under that window', Object.entries(BECAUSE).every(([n, input]) => itemFor(plan, n)?.because === `metric:dbt:${input}`));
  const done = await applyOf(S.P, plan.plan.hash);
  ok('the apply writes every one and fails none', done.ok === true && done.failed.length === 0 && done.written.length === plan.plan.counts.new + plan.plan.counts.updated, show(done));
  const again = await planOf(S.P);
  ok('a re-import writes nothing', again.plan.counts.new + again.plan.counts.updated + again.plan.counts.renamed + again.plan.counts.conflict === 0, show(again.plan.items.filter((i: Reply) => i.status !== 'unchanged' && i.status !== 'skipped')));
  const after = await stored(S.P);
  const idOf = (name: string): string => (after.find((x) => x?.name === name) as { id: string }).id;
  ok('no window is stored', !after.some((x) => x?.importedFrom && WINDOWS.includes(x.importedFrom.name)));

  // The calendar decides, and moves the hash (RF 3).
  const S2 = await seedProject('dbt part 5, calendar', ['orders']);
  const before = await planOf(S2.P);
  const setFy = async (fiscalYearStart: number) => ok(`(setup) fiscal year from month ${fiscalYearStart}`, (await post('formats:set', { fiscalYearStart })).status === 200);
  await setFy(4);
  const late = await applyOf(S2.P, before.plan.hash);
  ok('a calendar change between the dry run and the apply is refused', late.ok === false && late.error === modelPlanChanged(), show(late));
  const fiscal = await planOf(S2.P);
  ok('under April, a year or quarter to date is calendar_differs, a month to date and a 7-day window period_agg_last', ['revenue_ytd', 'revenue_qtd'].every((n) => itemFor(fiscal, n)?.reason === 'calendar_differs') && ['revenue_mtd', 'revenue_7d'].every((n) => itemFor(fiscal, n)?.reason === 'period_agg_last'), show(['revenue_ytd', 'revenue_mtd'].map((n) => itemFor(fiscal, n))));
  await setFy(1);
  ok('NEGATIVE CONTROL: back on January, the year to date is period_agg_last again', itemFor(await planOf(S2.P), 'revenue_ytd')?.reason === 'period_agg_last');

  // ── § figures: the period metric the import would write, held to MetricFlow (period_agg_last's control) ──
  const EXPECTED: { byDay: Record<string, Record<string, number>>; byPeriod: Array<[string, string, string, number]>; controls: { revenue_7d_first: Record<string, number>; revenue_7d_average: Record<string, number>; revenue_rolling_month: Record<string, number>; revenue_ly: Record<string, number>; visit_to_buy: number } } = JSON.parse(fs.readFileSync(path.join(P5_DIR, 'expected.json'), 'utf8'));
  const PINNED = new Set<string>(); // float differences in the last bits, each by name: none on this seed (whole-unit amounts)
  const hand = async (name: string, definition: object, datasetId = S.ds.orders, filters?: unknown[]): Promise<string> => {
    const r = (await post('metric:save', { projectId: S.P, input: { name, datasetId, definition, ...(filters && { filters }) } })).value;
    if (r.ok !== true) throw new Error(`${name}: ${show(r)}`);
    return r.metric.id as string;
  };
  const handIds = new Map<string, string>();
  for (const n of WINDOWS) {
    const dbt = (P5.metrics as Array<{ name: string; type_params: unknown }>).find((x) => x.name === n) as { type_params: unknown };
    const w = cumulativeWindow(dbt.type_params, DEFAULT_CALENDAR);
    if (!('window' in w)) throw new Error(`${n}: ${show(w)}`);
    handIds.set(n, await hand(`${n} by hand`, { base: idOf('revenue'), window: w.window }, S.ds.orders, n === 'eu_revenue_7d' ? [{ type: 'filter', column: 'region', op: '=', value: 'EU' }] : undefined));
  }
  const HELD = WINDOWS;
  const DAY = 86_400_000;
  const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
  const at = (d: string): number => Date.parse(`${d}T00:00:00Z`);
  const tiles = async (names: string[], from: string, to: string): Promise<Map<string, number | null>> => {
    const r = await post('metric:values', { projectId: S.P, ids: names.map((n) => handIds.get(n) as string), filters: [{ type: 'filter', column: 'order_date', op: 'period', period: { preset: 'custom', from, to } }] });
    const list = r.value as unknown as Reply[];
    if (!Array.isArray(list) || list.some((x) => x.ok !== true)) throw new Error(`metric:values ${from}..${to}: ${show(r.value)}`);
    return new Map(names.map((n, i) => [n, (list[i].value ?? null) as number | null]));
  };
  let days = 0;
  const dayMiss: string[] = [];
  for (let t = at('2023-01-01'); t <= at('2024-06-30'); t += DAY) {
    const d = iso(t);
    const got = await tiles(HELD, d, d);
    for (const n of HELD) {
      days += 1;
      if (!Object.is(got.get(n), EXPECTED.byDay[n][d] ?? null) && !PINNED.has(`${n}:${d}`)) dayMiss.push(`${n} ${d}: ${got.get(n)} vs ${EXPECTED.byDay[n][d] ?? null}`);
    }
  }
  ok(`each window, by day, sums dbt's rows: equal to MetricFlow on every day, no figure on a day it leaves out (${days} figures)`, dayMiss.length === 0 && days === HELD.length * 547, show(dayMiss.slice(0, 12)));

  const periodsOf = (grain: string): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    const next = (d: string): string => {
      const x = new Date(at(d));
      if (grain === 'week') return iso(at(d) + 7 * DAY);
      x.setUTCMonth(x.getUTCMonth() + ({ month: 1, quarter: 3, year: 12 } as Record<string, number>)[grain]);
      return iso(x.getTime());
    };
    for (let d = grain === 'week' ? '2022-12-26' : '2023-01-01'; at(next(d)) <= at('2024-07-01'); d = next(d)) out.push([d, iso(at(next(d)) - DAY)]);
    return out;
  };
  const mfPeriod = new Map(EXPECTED.byPeriod.map(([n, g, s0, v]) => [`${n}:${g}:${s0}`, v]));
  const periodMiss: string[] = [];
  const parted: string[] = [];
  let periods = 0;
  for (const grain of ['week', 'month', 'quarter', 'year']) {
    for (const [from, to] of periodsOf(grain)) {
      const got = await tiles(HELD, from, to);
      for (const n of HELD) {
        periods += 1;
        const mf = mfPeriod.get(`${n}:${grain}:${from}`) ?? null;
        if (Object.is(got.get(n), mf) || PINNED.has(`${n}:${grain}:${from}`)) continue;
        const lastEmpty = EXPECTED.byDay[n][to] === undefined; // the window ending on the period's last day holds no row
        if (lastEmpty && got.get(n) === null && mf !== null) parted.push(`${n} ${grain} ${from}`);
        else periodMiss.push(`${n} ${grain} ${from}: ${got.get(n)} vs ${mf}`);
      }
    }
  }
  ok(`at every ended week, month, quarter and year it equals MetricFlow but where its last window holds no row (${periods} figures)`, periodMiss.length === 0 && periods > 500, show(periodMiss.slice(0, 12)));
  ok('NEGATIVE CONTROL: there it has no figure and MetricFlow an earlier day\'s, at 14 periods: period_agg_last is load-bearing', parted.length === 14, show(parted));

  // ── § controls: each skip is load-bearing ──────────────────────────────────
  const someDiffers = async (pairs: Record<string, number>, get: (k: string) => Promise<number | null>): Promise<boolean> => {
    for (const [k, want] of Object.entries(pairs)) {
      const got = await get(k);
      if (typeof got === 'number' && !Object.is(got, want)) return true; // a figure, and another one: never just no figure
    }
    return false;
  };
  const monthRange = (mo: string): [string, string] => { const s0 = `${mo}-01`; const x = new Date(at(s0)); x.setUTCMonth(x.getUTCMonth() + 1); return [s0, iso(x.getTime() - DAY)]; };
  const tile = async (id: string, from: string, to: string, column = 'order_date'): Promise<number | null> =>
    ((await post('metric:values', { projectId: S.P, ids: [id], filters: [{ type: 'filter', column, op: 'period', period: { preset: 'custom', from, to } }] })).value as unknown as Reply[])[0]?.value ?? null;
  ok('period_agg first: Ordinate\'s end-of-month window differs from dbt\'s first day (RF 1)', await someDiffers(EXPECTED.controls.revenue_7d_first, (mo) => tile(handIds.get('revenue_7d') as string, ...monthRange(mo))));
  ok('period_agg average: and from dbt\'s average of the days', await someDiffers(EXPECTED.controls.revenue_7d_average, (mo) => tile(handIds.get('revenue_7d') as string, ...monthRange(mo))));
  const lastMonth = await hand('last 1 month', { base: idOf('revenue'), window: { last: 1, unit: 'month' } });
  ok('a 1-month window differs from dbt\'s rolling month (RF 2)', await someDiffers(EXPECTED.controls.revenue_rolling_month, (d) => tile(lastMonth, d, d)));
  const prior = await hand('LY prior', { base: idOf('revenue'), compare: { vs: 'previous_year', show: 'prior' } });
  const lyFeb = await tile(prior, '2024-02-01', '2024-02-29');
  ok('a year compare differs from dbt\'s offset in leap February 2024 (RF 5)', typeof lyFeb === 'number' && !Object.is(lyFeb, EXPECTED.controls.revenue_ly['2024-02']), show([await tile(prior, '2024-02-01', '2024-02-29'), EXPECTED.controls.revenue_ly['2024-02']]));
  const counted = await hand('orders 7d', { base: idOf('orders'), window: { last: 7, unit: 'day' } });
  const quiet = Object.keys(EXPECTED.controls.revenue_rolling_month).find((d) => EXPECTED.byDay.orders_7d[d] === undefined) as string; // a day whose window holds no order
  ok('a count over a window with no row is 0 here, where MetricFlow has no figure: count_window is load-bearing', !!quiet && (await tile(counted, quiet, quiet)) === 0, show([quiet, await tile(counted, quiet, quiet)]));
  const funnel = await hand('hand funnel', { funnel: { entity: 'user_id', event: 'event', time: 'ts', steps: ['visit', 'buy'], window: { n: 7, unit: 'days' } }, show: 'rate' }, S.ds.events);
  const funnelRate = ((await post('metric:values', { projectId: S.P, ids: [funnel] })).value as unknown as Reply[])[0]?.value ?? null;
  ok('a funnel differs from dbt\'s conversion with a repeat visitor (RF 5)', typeof funnelRate === 'number' && !Object.is(funnelRate, EXPECTED.controls.visit_to_buy), show([funnelRate, EXPECTED.controls.visit_to_buy]));

  // ── § old imports ──────────────────────────────────────────────────────────
  const GOLDEN_TEXT = fs.readFileSync(path.join(__dirname, 'fixtures', 'golden', 'dbt-f1', 'translation.json'), 'utf8');
  ok('f1\'s golden is the one recorded before any f2 code (sha256)', createHash('sha256').update(GOLDEN_TEXT).digest('hex') === '88d664b6ddd4b7b2a444106cc6a23ba357da840ebca694d9773d9de27c324305');
  const GOLDEN_F1 = JSON.parse(GOLDEN_TEXT);
  const f1Now = translateDbt(F1_MANIFEST, F1_DATASETS, {}, DEFAULT_CALENDAR);
  const pair = (t: { model: unknown; skipped: unknown }) => ({ model: t.model, skipped: t.skipped });
  ok('f1\'s translation is byte-identical outside the four kinds', stableStringify(pair(withoutFourKinds(JSON.parse(stableStringify(f1Now)), GOLDEN_F1))) === stableStringify(pair(withoutFourKinds(GOLDEN_F1, GOLDEN_F1))));
  ok('… and of the four, only Cumulative revenue moved, to its window\'s reason', isDeepStrictEqual(f1Now.skipped.filter((x) => !GOLDEN_F1.skipped.some((g: { dbt: string; reason: string }) => g.dbt === x.dbt && g.reason === x.reason)).map((x) => [x.dbt, x.reason]), [['cumulative_revenue', 'window_unit']]));
  ok('a manifest without the four kinds translates to f1\'s model byte for byte', stableStringify(pair(withoutFourKinds(JSON.parse(stableStringify(translateDbt(dropFourKinds(F1_MANIFEST), F1_DATASETS, {}, DEFAULT_CALENDAR))), GOLDEN_F1))) === stableStringify(pair(withoutFourKinds(GOLDEN_F1, GOLDEN_F1))));
  ok('NEGATIVE CONTROL: f1\'s whole manifest is not that model (the four kinds are in it)', stableStringify(pair(JSON.parse(stableStringify(f1Now)))) !== stableStringify(pair(withoutFourKinds(GOLDEN_F1, GOLDEN_F1))));

  await close();
  finish();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
