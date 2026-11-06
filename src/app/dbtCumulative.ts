// A dbt cumulative metric as a part 5 period metric (semantic layer part 7, f2; docs/semantic-layer/07-portability.md
// D10, 05-metrics-depth.md D8–D9). PURE: ./dbtImport.ts calls it with f1's readers. What MetricFlow does is in
// scripts/fixtures/dbt-part5/README.md, each from dbt's docs.
//
// MetricFlow sums a day's window as (t − N days, t] or [start of grain, t], which is Ordinate's `last N days` and
// `to_date` ending on t. So, exactly:
// - a window of N days or N weeks (7N days; Ordinate's "last N weeks" is whole calendar weeks) → `last 7N days`, up to 366;
// - a month to date while the calendar is Gregorian, a quarter or year to date while the year also starts in January;
//   never a week to date (MetricFlow's week is its warehouse's date_trunc, which dbt's docs leave open);
// - and only `period_agg: last`: dbt's default, `first`, reads a month at its first day, Ordinate at its last.
// The base is the unfiltered simple metric f1 translated on the same measure, never one made up; the metric's own
// filters (its input's, then its own) become the period metric's filters. Never a count: a window with no row in it
// counts 0 here, where MetricFlow's join leaves that day out.

import type { FilterStep } from '../data/transforms';
import type { CalendarPrefs } from '../analysis/dateIntel';
import type { MetricWindow } from '../analysis/periodMetric';
import { sanitizeDefinition } from '../analysis/metrics';
import type { ModelMetric } from './modelFormat';
import type { DbtSkip } from './dbtImport';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o: unknown, k: string): unknown => (isObj(o) && Object.hasOwn(o, k) ? o[k] : undefined);
const given = (v: unknown): boolean => v !== undefined && v !== null;

/** What the dry run says about the windows it imports (the web words them). */
export type DbtNote = 'in_progress' | 'follows_calendar';

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
  /** f1's id, name, description and `importedFrom`, on `datasetId`. */
  shell: (datasetId: string) => Pick<ModelMetric, 'id' | 'name' | 'dataset' | 'base' | 'importedFrom'> & { description?: string };
  calendar: CalendarPrefs;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const UNIT_DAYS: Readonly<Record<string, number>> = { day: 1, days: 1, week: 7, weeks: 7 }; // singular or plural: dbt's docs do not say which the manifest writes
const MAX_DAYS = 366;
const TO_DATE: ReadonlySet<string> = new Set(['week', 'month', 'quarter', 'year']);
const COUNTS: ReadonlySet<string> = new Set(['count', 'countd']);

/** The calendar a to-date at `grain` matches MetricFlow's on (Gregorian months; quarters and years from January). */
const dbtCalendar = (grain: string, cal: CalendarPrefs): boolean => grain !== 'week' && (!cal.calendarType || cal.calendarType === 'gregorian') && (grain === 'month' || cal.fiscalYearStart === 1);

/** A cumulative metric's window, from `cumulative_type_params` (else an older manifest's top-level fields), or why it does not map. */
export function cumulativeWindow(typeParams: unknown, cal: CalendarPrefs): { window: MetricWindow } | { skip: 'cumulative' | 'all_time' | 'window_unit' | 'calendar_differs' | 'period_agg' } {
  const ctp = own(typeParams, 'cumulative_type_params');
  const both = (k: string): { v: unknown; clash: boolean } => {
    const inner = own(ctp, k);
    const top = own(typeParams, k);
    return { v: given(inner) ? inner : top, clash: given(inner) && given(top) && !sameJson(inner, top) };
  };
  const w = both('window');
  const g = both('grain_to_date');
  if (w.clash || g.clash || (given(w.v) && given(g.v))) return { skip: 'cumulative' };
  let window: MetricWindow;
  if (given(w.v)) {
    const count = own(w.v, 'count');
    if (!Number.isInteger(count) || (count as number) < 1) return { skip: 'cumulative' };
    const unit = UNIT_DAYS[String(own(w.v, 'granularity'))];
    if (!unit || (count as number) * unit > MAX_DAYS) return { skip: 'window_unit' };
    window = { last: (count as number) * unit, unit: 'day' };
  } else if (given(g.v)) {
    if (!TO_DATE.has(String(g.v))) return { skip: 'window_unit' };
    if (!dbtCalendar(String(g.v), cal)) return { skip: 'calendar_differs' };
    window = { to_date: g.v as 'month' | 'quarter' | 'year' };
  } else return { skip: 'all_time' };
  return own(ctp, 'period_agg') === 'last' ? { window } : { skip: 'period_agg' };
}

/** A cumulative metric as a period metric over its measure's plain simple metric, or why not. */
export function translateCumulative(m: Obj, ctx: CumulativeCtx): { metric: ModelMetric; model: string } | { skip: DbtSkip; model?: string } {
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
  const filters = ctx.filters(inp, m, measure.model);
  if (!filters) return { skip: 'filter_shape', ...at };
  const definition = sanitizeDefinition({ base: base.metric.id, window: w.window });
  return { metric: { ...ctx.shell(base.metric.dataset), definition, format: base.metric.format, ...(filters.length && { filters }) }, model: measure.model };
}

/** The dry run's notes for the metrics translated: every window has a period in progress; a to-date follows the calendar. */
export function cumulativeNotes(metrics: readonly ModelMetric[]): DbtNote[] {
  const windows = metrics.map((x) => (x.definition as { window?: MetricWindow }).window).filter((x) => !!x);
  return [...(windows.some((x) => 'to_date' in x) ? ['follows_calendar' as const] : []), ...(windows.length ? ['in_progress' as const] : [])];
}
