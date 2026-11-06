// The dbt import of part 5's shapes (semantic layer part 7, f2; docs/semantic-layer/07-portability.md D10,
// 05-metrics-depth.md D8–D9), over scripts/fixtures/dbt-part5/ (README.md says what MetricFlow does, from dbt's docs).
//
// § cumulative  cumulativeWindow and translateDbt: a rolling window in days or weeks becomes `last N days`, a month,
//               quarter or year to date becomes `to_date` while the calendar is dbt's, over the unfiltered simple
//               metric on the same measure; every other cumulative shape is skipped with its reason, and so are
//               conversions, time offsets and window groupings.
//
//   npm run build:ts && node scripts/test-dbtPart5.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { close } from './liveRouteHarness';
import { P5, P5_DATASETS, F1_MANIFEST, F1_DATASETS, metricNamed, allMetricNames, dropFourKinds } from './dbtHarness';
import type { ModelMetric } from '../src/app/modelFormat';

const { isDeepStrictEqual }: typeof import('util') = require('util');
const { translateDbt }: typeof import('../src/app/dbtImport') = require('../src/app/dbtImport');
const { cumulativeWindow }: typeof import('../src/app/dbtCumulative') = require('../src/app/dbtCumulative');
const { DEFAULT_CALENDAR }: typeof import('../src/analysis/dateIntel') = require('../src/analysis/dateIntel');

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
  ok('a count\'s window is over the count', isDeepStrictEqual(m('orders_7d')?.definition, { base: m('orders')?.id, window: { last: 7, unit: 'day' } }));
  ok('a period metric stores no timeColumn and takes its base\'s format', !!m('revenue_7d') && m('revenue_7d').timeColumn === undefined && isDeepStrictEqual(m('revenue_7d').format, m('revenue').format));
  ok('its own filter becomes its filters, over the unfiltered base', isDeepStrictEqual(m('eu_revenue_7d')?.filters, [{ type: 'filter', column: 'region', op: '=', value: 'EU' }]) && (m('eu_revenue_7d')?.definition as { base: string })?.base === m('revenue')?.id, show(m('eu_revenue_7d')));
  ok('an unfiltered window carries no filters key', !!m('revenue_7d') && !('filters' in m('revenue_7d')));
  ok('importedFrom carries the dbt name', isDeepStrictEqual(m('revenue_ytd')?.importedFrom, { kind: 'dbt', name: 'revenue_ytd' }));
  ok('a derived metric over two windows becomes f1\'s formula', (m('aov_7d')?.definition as { formula?: string })?.formula === '([revenue_7d] / [orders_7d])', show(m('aov_7d')));
  const SKIPS: Array<[string, string]> = [
    ['revenue_wtd', 'calendar_differs'], ['revenue_7d_first', 'period_agg'], ['revenue_all_time', 'all_time'], ['revenue_rolling_month', 'window_unit'],
    ['revenue_7d_filled', 'fill_nulls'], ['refunds_7d', 'no_base_metric'], ['mrr_7d', 'cumulative'], ['visit_to_buy', 'conversion'], ['revenue_ly', 'time_offset'],
    ['revenue_yoy_change', 'time_offset'], ['revenue_yoy_growth', 'time_offset'], ['mrr', 'window_groupings'], ['mrr_two', 'window_groupings'], ['mrr_first', 'window_groupings'],
  ];
  for (const [name, why] of SKIPS) ok(`${name}: skipped, ${why} (RF 1, 2, 5)`, skipped.some((s) => s.name === name && s.kind === 'metric' && s.reason === why) && !m(name), show(skipped.filter((s) => s.name === name)));
  ok('every metric is translated or named, never both', allMetricNames(P5).every((n) => !!m(n) !== skipped.some((s) => s.name === n && s.kind === 'metric')));
  ok('seven windows, a formula and three bases', model.metrics.length === 11, show(model.metrics.map((x) => x.name)));
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

  await close();
  finish();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
