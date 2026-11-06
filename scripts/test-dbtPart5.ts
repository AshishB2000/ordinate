// The dbt import of part 5's shapes (semantic layer part 7, f2; docs/semantic-layer/07-portability.md D10,
// 05-metrics-depth.md D8–D9), over scripts/fixtures/dbt-part5/ (README.md says what MetricFlow does, from dbt's docs).
//
// § cumulative  cumulativeWindow and translateDbt: a rolling window in days or weeks becomes `last N days`, a month,
//               quarter or year to date becomes `to_date` while the calendar is dbt's, over the unfiltered simple
//               metric on the same measure; every other cumulative shape is skipped with its reason, and so are
//               conversions, time offsets and window groupings.
// § route       model:importPlan and model:importApply: the windows are new, the plan carries the notes, the editor's own
//               save takes every one; a calendar changed between the dry run and the apply is refused, and under a
//               fiscal year from April a year to date is skipped while a 7-day window is not.
// § figures     every imported window over the seed, at every day and every week, month, quarter and year ended by
//               today (2024-07-01), equals expected.json (Object.is). A period whose last window holds no row has no
//               figure here, where MetricFlow repeats its last day with one (README): held to null, and shown to happen.
// § controls    NEGATIVE CONTROLS, each skip load-bearing: period_agg first, a 1-month window, a year compare and a funnel
//               each give another figure than MetricFlow's.
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

  const { model, skipped, notes } = translateDbt(P5, P5_DATASETS, {}, DEFAULT_CALENDAR);
  const m = (n: string): ModelMetric => metricNamed(model, n);
  ok('a window over the simple metric on its measure', isDeepStrictEqual(m('revenue_7d')?.definition, { base: m('revenue')?.id, window: { last: 7, unit: 'day' } }), show(m('revenue_7d')));
  ok('… on the base\'s dataset', !!m('revenue_7d') && m('revenue_7d').dataset === m('revenue').dataset);
  ok('weeks become days', isDeepStrictEqual(m('revenue_2w')?.definition, { base: m('revenue')?.id, window: { last: 14, unit: 'day' } }));
  ok('to date', ['month', 'quarter', 'year'].every((g) => isDeepStrictEqual(m(`revenue_${g[0]}td`)?.definition, { base: m('revenue')?.id, window: { to_date: g } })));
  ok('a period metric stores no timeColumn and takes its base\'s format', !!m('revenue_7d') && m('revenue_7d').timeColumn === undefined && isDeepStrictEqual(m('revenue_7d').format, m('revenue').format));
  ok('its own filter becomes its filters, over the unfiltered base', isDeepStrictEqual(m('eu_revenue_7d')?.filters, [{ type: 'filter', column: 'region', op: '=', value: 'EU' }]) && (m('eu_revenue_7d')?.definition as { base: string })?.base === m('revenue')?.id, show(m('eu_revenue_7d')));
  ok('an unfiltered window carries no filters key', !!m('revenue_7d') && !('filters' in m('revenue_7d')));
  ok('importedFrom carries the dbt name', isDeepStrictEqual(m('revenue_ytd')?.importedFrom, { kind: 'dbt', name: 'revenue_ytd' }));
  ok('a derived metric over two windows becomes f1\'s formula, counting by their base\'s date (as the editor\'s save gives it)', (m('eu_share_7d')?.definition as { formula?: string })?.formula === '([eu_revenue_7d] / [revenue_7d])' && m('eu_share_7d')?.timeColumn === 'order_date', show(m('eu_share_7d')));
  const SKIPS: Array<[string, string]> = [
    ['revenue_wtd', 'calendar_differs'], ['revenue_7d_first', 'period_agg'], ['revenue_all_time', 'all_time'], ['revenue_rolling_month', 'window_unit'],
    ['revenue_7d_filled', 'fill_nulls'], ['refunds_7d', 'no_base_metric'], ['mrr_7d', 'cumulative'], ['orders_7d', 'count_window'], ['aov_7d', 'count_window'], ['visit_to_buy', 'conversion'], ['revenue_ly', 'time_offset'],
    ['revenue_yoy_change', 'time_offset'], ['revenue_yoy_growth', 'time_offset'], ['mrr', 'window_groupings'], ['mrr_two', 'window_groupings'], ['mrr_first', 'window_groupings'],
  ];
  for (const [name, why] of SKIPS) ok(`${name}: skipped, ${why} (RF 1, 2, 5)`, skipped.some((s) => s.name === name && s.kind === 'metric' && s.reason === why) && !m(name), show(skipped.filter((s) => s.name === name)));
  ok('every metric is translated or named, never both', allMetricNames(P5).every((n) => !!m(n) !== skipped.some((s) => s.name === n && s.kind === 'metric')));
  ok('six windows, a formula and three bases', model.metrics.length === 10, show(model.metrics.map((x) => x.name)));
  ok('a formula over a count window falls with it', skipped.some((s) => s.name === 'aov_7d' && s.because === 'orders_7d'));
  ok('notes', isDeepStrictEqual(notes, ['follows_calendar', 'in_progress']), show(notes));
  ok('… on the model\'s dbt source too, for the plan', isDeepStrictEqual(model.dbt?.notes, ['follows_calendar', 'in_progress']));
  ok('windows only, no to-date: no follows_calendar', isDeepStrictEqual(translateDbt(P5, P5_DATASETS, {}, { ...DEFAULT_CALENDAR, calendarType: '445' }).notes, ['in_progress']));
  const noWindow = translateDbt(dropFourKinds(F1_MANIFEST), F1_DATASETS, {}, DEFAULT_CALENDAR);
  ok('no window metric, no notes, and no notes key on the source', noWindow.notes.length === 0 && !!noWindow.model.dbt && !('notes' in noWindow.model.dbt));
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
  ok('translating twice is the same', JSON.stringify(translateDbt(P5, P5_DATASETS, {}, DEFAULT_CALENDAR)) === JSON.stringify({ model, skipped, notes }));

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
  const stored = async (P: string) => H.as(H.ORG_A, async () => {
    const metricsMod: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
    return Promise.all((await metricsMod.listMetrics(P)).map((x) => metricsMod.getMetric(P, x.id)));
  });

  const S = await seedProject('dbt part 5');
  const plan = await planOf(S.P);
  ok('the dry run answers', plan.ok === true, show(plan));
  ok('every window and formula is new (the editor\'s own checks passed)', model.metrics.every((x) => itemFor(plan, x.importedFrom?.name as string)?.status === 'new'), show(plan.plan?.items.filter((i: Reply) => i.kind === 'metric' && i.status !== 'new' && i.status !== 'skipped')));
  ok('the notes are on the plan', isDeepStrictEqual(plan.plan?.source?.notes, ['follows_calendar', 'in_progress']), show(plan.plan?.source));
  const planReason = (n: string, why: string): string => (n === 'aov_7d' ? 'depends_on_skipped' : why); // it falls with orders_7d, listed under it
  ok('each skip is listed with its reason', SKIPS.every(([n, why]) => itemFor(plan, n)?.status === 'skipped' && itemFor(plan, n)?.reason === planReason(n, why)), show(SKIPS.map(([n]) => itemFor(plan, n)).filter((i) => i?.status !== 'skipped' || i.reason !== planReason(i.name, SKIPS.find(([x]) => x === i.name)?.[1] ?? ''))));
  ok('… a formula over a count window under that window', itemFor(plan, 'aov_7d')?.because === 'metric:dbt:orders_7d');
  const done = await applyOf(S.P, plan.plan.hash);
  ok('the apply writes every one and fails none', done.ok === true && done.failed.length === 0 && done.written.length === plan.plan.counts.new + plan.plan.counts.updated, show(done));
  const again = await planOf(S.P);
  ok('a re-import writes nothing', again.plan.counts.new + again.plan.counts.updated + again.plan.counts.renamed + again.plan.counts.conflict === 0, show(again.plan.items.filter((i: Reply) => i.status !== 'unchanged' && i.status !== 'skipped')));
  const after = await stored(S.P);
  const idOf = (name: string): string => (after.find((x) => x?.name === name) as { id: string }).id;
  ok('a window is stored on its base, with dbt\'s name', isDeepStrictEqual(after.find((x) => x?.name === 'revenue_7d')?.definition, { base: idOf('revenue'), window: { last: 7, unit: 'day' } }) && after.find((x) => x?.name === 'revenue_7d')?.importedFrom?.name === 'revenue_7d');

  // The calendar decides, and moves the hash (RF 3).
  const S2 = await seedProject('dbt part 5, calendar', ['orders']);
  const before = await planOf(S2.P);
  const setFy = async (fiscalYearStart: number) => ok(`(setup) fiscal year from month ${fiscalYearStart}`, (await post('formats:set', { fiscalYearStart })).status === 200);
  await setFy(4);
  const late = await applyOf(S2.P, before.plan.hash);
  ok('a calendar change between the dry run and the apply is refused', late.ok === false && late.error === modelPlanChanged(), show(late));
  const fiscal = await planOf(S2.P);
  ok('under April, a year or quarter to date is skipped, and a month to date and a 7-day window are not', ['revenue_ytd', 'revenue_qtd'].every((n) => itemFor(fiscal, n)?.reason === 'calendar_differs') && ['revenue_mtd', 'revenue_7d'].every((n) => itemFor(fiscal, n)?.status === 'new'), show(['revenue_ytd', 'revenue_mtd'].map((n) => itemFor(fiscal, n))));
  await setFy(1);
  ok('NEGATIVE CONTROL: back on January, the year to date is new again', itemFor(await planOf(S2.P), 'revenue_ytd')?.status === 'new');

  // ── § figures ──────────────────────────────────────────────────────────────
  const EXPECTED: { byDay: Record<string, Record<string, number>>; byPeriod: Array<[string, string, string, number]>; controls: { revenue_7d_first: Record<string, number>; revenue_rolling_month: Record<string, number>; revenue_ly: Record<string, number>; visit_to_buy: number } } = JSON.parse(fs.readFileSync(path.join(P5_DIR, 'expected.json'), 'utf8'));
  const PINNED = new Set<string>(); // float differences in the last bits, each by name: none on this seed (whole-unit amounts)
  const HELD = ['revenue_7d', 'revenue_2w', 'revenue_mtd', 'revenue_qtd', 'revenue_ytd', 'eu_revenue_7d', 'eu_share_7d'];
  ok('every imported window and formula is held to a figure', model.metrics.filter((x) => x.importedFrom && !['revenue', 'orders', 'refunds_card'].includes(x.name)).every((x) => HELD.includes(x.name) && !!EXPECTED.byDay[x.name]));
  const DAY = 86_400_000;
  const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
  const at = (d: string): number => Date.parse(`${d}T00:00:00Z`);
  const tiles = async (names: string[], from: string, to: string): Promise<Map<string, number | null>> => {
    const r = await post('metric:values', { projectId: S.P, ids: names.map(idOf), filters: [{ type: 'filter', column: 'order_date', op: 'period', period: { preset: 'custom', from, to } }] });
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
  ok(`every window on every day equals MetricFlow, a day it leaves out has no figure (${days} figures)`, dayMiss.length === 0 && days === HELD.length * 547, show(dayMiss.slice(0, 12)));

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
  let empty = 0;
  let periods = 0;
  for (const grain of ['week', 'month', 'quarter', 'year']) {
    for (const [from, to] of periodsOf(grain)) {
      const got = await tiles(HELD, from, to);
      for (const n of HELD) {
        periods += 1;
        const mf = mfPeriod.get(`${n}:${grain}:${from}`) ?? null;
        const lastEmpty = EXPECTED.byDay[n][to] === undefined; // the window ending on the period's last day holds no row
        if (lastEmpty && mf !== null) empty += 1;
        const fine = lastEmpty ? got.get(n) === null : Object.is(got.get(n), mf) || PINNED.has(`${n}:${grain}:${from}`);
        if (!fine) periodMiss.push(`${n} ${grain} ${from}: ${got.get(n)} vs ${mf}`);
      }
    }
  }
  ok(`every window at every ended week, month, quarter and year equals MetricFlow, or has no figure where its last window holds no row (${periods} figures)`, periodMiss.length === 0 && periods > 600, show(periodMiss.slice(0, 12)));
  ok('NEGATIVE CONTROL: the seed has periods whose last window holds no row while MetricFlow repeats an earlier day (the note is load-bearing)', empty === 20, String(empty));

  // ── § controls: each skip is load-bearing ──────────────────────────────────
  const someDiffers = async (pairs: Record<string, number>, get: (k: string) => Promise<number | null>): Promise<boolean> => {
    for (const [k, want] of Object.entries(pairs)) {
      const got = await get(k);
      if (typeof got === 'number' && !Object.is(got, want)) return true; // a figure, and another one: never just no figure
    }
    return false;
  };
  const monthRange = (mo: string): [string, string] => { const s0 = `${mo}-01`; const x = new Date(at(s0)); x.setUTCMonth(x.getUTCMonth() + 1); return [s0, iso(x.getTime() - DAY)]; };
  const hand = async (name: string, definition: object, datasetId = S.ds.orders): Promise<string> => {
    const r = (await post('metric:save', { projectId: S.P, input: { name, datasetId, definition } })).value;
    if (r.ok !== true) throw new Error(`${name}: ${show(r)}`);
    return r.metric.id as string;
  };
  const tile = async (id: string, from: string, to: string, column = 'order_date'): Promise<number | null> =>
    ((await post('metric:values', { projectId: S.P, ids: [id], filters: [{ type: 'filter', column, op: 'period', period: { preset: 'custom', from, to } }] })).value as unknown as Reply[])[0]?.value ?? null;
  ok('period_agg first: Ordinate\'s end-of-month window differs from dbt\'s first day (RF 1)', await someDiffers(EXPECTED.controls.revenue_7d_first, (mo) => tile(idOf('revenue_7d'), ...monthRange(mo))));
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
