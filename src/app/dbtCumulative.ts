// Why a dbt cumulative metric is not imported (semantic layer part 7, f2; docs/semantic-layer/07-portability.md D10,
// 05-metrics-depth.md D8–D9). PURE: ./dbtImport.ts calls it with f1's readers. What MetricFlow does is in
// scripts/fixtures/dbt-part5/README.md, each from dbt's docs; scripts/test-dbtPart5.ts holds it to the figures.
//
// No cumulative metric is imported: none matches dbt at every period. MetricFlow sums a day's window as
// (t − N days, t] or [start of grain, t], which is Ordinate's `last N days` and `to_date` ending on t (`cumulativeWindow`
// reads it so, and the suite proves it day by day). But it reads a week, month, quarter or year through `period_agg`:
// `last` takes the last day whose window holds rows, where Ordinate takes the period's last day and shows no figure when
// that window is empty; `first` (the default) and `average` read the period otherwise. Each metric is named with the
// first thing that stands between it and an exact period metric, `period_agg_last` when only that does:
// - a window of N days or N weeks (7N days; Ordinate's "last N weeks" is whole calendar weeks), up to 366 days;
// - a month to date while the calendar is Gregorian, a quarter or year to date while the year also starts in January;
//   never a week to date (MetricFlow's week is its warehouse's date_trunc, which dbt's docs leave open);
// - over the unfiltered simple metric f1 translated on the same measure, never a count (a window with no row counts 0
//   here, where MetricFlow's join leaves that day out), with filters f1's grammar reads.

import type { FilterStep } from '../data/transforms';
import type { CalendarPrefs } from '../analysis/dateIntel';
import type { MetricWindow } from '../analysis/periodMetric';
import type { ModelMetric } from './modelFormat';
import type { DbtSkip } from './dbtImport';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o: unknown, k: string): unknown => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const given = (v: unknown): boolean => v !== undefined && v !== null;

/** A simple metric f1 translated: its measure, and whether it has a filter of its own. */
export interface SimpleTranslation { metric: ModelMetric; measure: string | null; filtered: boolean }

export interface CumulativeCtx {
  /** f1's reading of a measure input (a name or `{ name, filter, fill_nulls_with, … }`). */
  input: (v: unknown) => Obj | null;
  /** The measure by name: its semantic model, whether that has a dataset here, whether it is a balance. */
  measure: (name: string) => { model: string; hasDataset: boolean; nonAdditive: boolean } | undefined;
  /** Every simple metric f1 translated, by dbt name, in dbt-name order. */
  simple: () => ReadonlyMap<string, SimpleTranslation>;
  /** The input's filter, then the metric's own, as filter steps on `model`; null when f1's grammar does not read one. */
  filters: (inp: Obj, m: Obj, model: string) => FilterStep[] | null;
  calendar: CalendarPrefs;
}

/** Two copies of a window or a grain say the same, in what is read of them (a window's count and unit): never a whole nested value. */
const sameRead = (a: unknown, b: unknown): boolean => (isObj(a) && isObj(b) ? Object.is(own(a, 'count'), own(b, 'count')) && Object.is(own(a, 'granularity'), own(b, 'granularity')) : Object.is(a, b));
const UNIT_DAYS: Readonly<Record<string, number>> = { day: 1, days: 1, week: 7, weeks: 7 }; // singular or plural: dbt's docs do not say which the manifest writes
const MAX_DAYS = 366;
const TO_DATE: ReadonlySet<string> = new Set(['week', 'month', 'quarter', 'year']);
const COUNTS: ReadonlySet<string> = new Set(['count', 'countd']);

/** The calendar a to-date at `grain` matches MetricFlow's on (Gregorian months; quarters and years from January). */
const dbtCalendar = (grain: string, cal: CalendarPrefs): boolean => grain !== 'week' && (!cal.calendarType || cal.calendarType === 'gregorian') && (grain === 'month' || cal.fiscalYearStart === 1);

/** The Ordinate window that sums the rows dbt's does each day, from `cumulative_type_params` (else an older manifest's top-level fields), or why there is none; `period_agg` other than `last` reads periods otherwise. */
export function cumulativeWindow(typeParams: unknown, cal: CalendarPrefs): { window: MetricWindow } | { skip: 'cumulative' | 'unreadable' | 'all_time' | 'window_unit' | 'calendar_differs' | 'period_agg' } {
  const ctp = own(typeParams, 'cumulative_type_params');
  const both = (k: string): { v: unknown; clash: boolean } => {
    const inner = own(ctp, k);
    const top = own(typeParams, k);
    return { v: given(inner) ? inner : top, clash: given(inner) && given(top) && !sameRead(inner, top) };
  };
  const w = both('window');
  const g = both('grain_to_date');
  if (w.clash || g.clash) return { skip: 'unreadable' }; // two copies that disagree
  if (given(w.v) && given(g.v)) return { skip: 'cumulative' };
  let window: MetricWindow;
  if (given(w.v)) {
    const count = own(w.v, 'count');
    if (!Number.isInteger(count) || (count as number) < 1) return { skip: 'unreadable' };
    const unit = own(UNIT_DAYS, String(own(w.v, 'granularity'))) as number | undefined;
    if (!unit || (count as number) * unit > MAX_DAYS) return { skip: 'window_unit' };
    window = { last: (count as number) * unit, unit: 'day' };
  } else if (given(g.v)) {
    if (!TO_DATE.has(String(g.v))) return { skip: 'window_unit' };
    if (!dbtCalendar(String(g.v), cal)) return { skip: 'calendar_differs' };
    window = { to_date: g.v as 'month' | 'quarter' | 'year' };
  } else return { skip: 'all_time' };
  return own(ctp, 'period_agg') === 'last' ? { window } : { skip: 'period_agg' };
}

/** Why a cumulative metric is not imported: the first thing between it and an exact period metric (see the header). */
export function cumulativeSkip(m: Obj, ctx: CumulativeCtx): { skip: DbtSkip; model?: string } {
  const tp = own(m, 'type_params');
  const inp = ctx.input(own(tp, 'measure'));
  const measure = inp ? ctx.measure(own(inp, 'name') as string) : undefined;
  if (!inp || !measure) return { skip: 'unreadable' }; // dbt's newer spec (input_metric) has no documented manifest
  const at = { model: measure.model };
  if (!measure.hasDataset) return { skip: 'no_dataset', ...at };
  if (measure.nonAdditive) return { skip: 'cumulative', ...at };
  if (given(own(inp, 'fill_nulls_with'))) return { skip: 'fill_nulls', ...at };
  const w = cumulativeWindow(tp, ctx.calendar);
  if ('skip' in w) return { skip: w.skip, ...at };
  const base = [...ctx.simple().values()].find((s) => s.measure === own(inp, 'name') && !s.filtered && !(s.metric.definition as { snapshot?: unknown }).snapshot && !!s.metric.timeColumn);
  if (!base) return { skip: 'no_base_metric', ...at };
  if (COUNTS.has(String((base.metric.definition as { aggregation?: unknown }).aggregation))) return { skip: 'count_window', ...at }; // no row in the window: 0 here, no figure in dbt
  if (!ctx.filters(inp, m, measure.model)) return { skip: 'filter_shape', ...at };
  return { skip: 'period_agg_last', ...at }; // the day's window is Ordinate's; dbt's last day with rows is not the period's last day
}
