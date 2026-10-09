// The LIVE query IR and its three adapters — MAIN PROCESS, PURE: no fs, no
// DuckDB, no warehouse. docs/live-data/00-plan.md L2.2 (D3).
//
// A live dataset has no rows here: its questions are compiled to SQL and the
// warehouse answers them. This file is the narrow waist between "what a chart,
// a KPI tile or an AI answer asks" and that compiler. Each adapter takes EXACTLY
// what its extract twin takes today, so routing a door to live (L2.4) is a swap
// of one call, not a change of shape:
//
//   fromVizEncoding  ← vizDataFor / residentVizData / buildVizData (encoding + filters)
//   fromAnswerSpec   ← answers.computeCard (an AnswerSpec)
//   fromMetric       ← dashboards.metricFor / computeMetricResident (spec + filters)
//
// THE RULE: an adapter either returns an IR that means exactly what the extract
// path computes, or a TYPED REFUSAL with a catalog sentence (D6, D7). Never a
// "close enough" IR — there are no rows to fall back on, so a wrong IR is a
// wrong number on screen. Everything the extract skips WITH A WARNING (a filter
// on a column this dataset lacks, an empty `in` list, a period that resolves to
// nothing) is skipped here with the byte-identical warning, because a dashboard
// filter spanning heterogeneous datasets depends on it.
//
// Deliberate differences from the extract, each pinned by a test:
//   - sum/avg/min/max over a column not declared `number` is REFUSED (the
//     extract draws nulls). Loud beats a column of blanks that looks like data.
//   - `contains` on a number column is refused: the extract matches the JS
//     spelling of the number (`String(1200)`), which a warehouse prints its own
//     way (`1200.0`).
//   - a split by a date column is refused: the extract names one series per
//     stored date TEXT, which a warehouse DATE does not carry.
//   - a period on a column that is not a date is refused (the extract parses
//     text cells with Date.parse, which SQL has no twin of).

import type { ParsedColumn } from '../../data/parse';
import type { Cell, FilterStep } from '../../data/transforms';
import type { VizEncoding } from '../../analysis/visuals';
import type { AnswerPeriod, AnswerSpec } from '../../ai/answerSpec';
import type { DateGrain } from '../../analysis/categoryKey';
import { isDateGrain, sanitizeBins } from '../../analysis/categoryKey';
import type { WeekCal } from '../../analysis/retailCalendar';
import { activeWeekCal } from '../../analysis/retailCalendar';
import { FILTER_OPS, emptyListWarning, periodSkipWarning } from '../../data/filterOps';
import { getCalendar, resolvePeriod, todayIso } from '../../analysis/dateIntel';
import * as msg from '../liveRefusals';

// ── The IR ───────────────────────────────────────────────────────────────────

/**
 * One column of a live dataset's STORED schema — the only place an identifier
 * may come from (D4). `sourceType` is the warehouse's verbatim type name when the
 * schema sync recorded it; it only matters where a dialect's safe cast refuses a
 * non-string input (Snowflake, Redshift), and its absence means "the warehouse
 * type matches the declared type".
 */
export interface LiveColumn extends ParsedColumn {
  sourceType?: string;
}

export type LiveAgg = 'sum' | 'avg' | 'count' | 'min' | 'max';
export const LIVE_AGGS: ReadonlySet<string> = new Set<LiveAgg>(['sum', 'avg', 'count', 'min', 'max']);
/** The aggregations that need a number column — `answerSpec.NUMERIC_AGGS`. */
export const NUMERIC_AGGS: ReadonlySet<string> = new Set<LiveAgg>(['sum', 'avg', 'min', 'max']);

export interface LiveMeasure {
  column: string;
  aggregation: LiveAgg;
}

/**
 * The category axis, by the column's DECLARED type — the same three rewrites
 * `vizData.rewriteCategory` makes: a number bins, a date rolls up to a grain
 * (absent = the finest that fits, chosen from the data), a text column keeps its
 * top 50 and folds the rest into "Other".
 */
export type LiveCategory =
  | { column: string; kind: 'text' }
  | { column: string; kind: 'date'; grain?: DateGrain }
  | { column: string; kind: 'bins'; bins?: number };

export type CompareOp = '=' | '!=' | '>' | '<' | '>=' | '<=';

/**
 * A filter the compiler understands. `range` is the RESOLVED form of both kinds
 * of period (inclusive ISO days, either end open); `latest` is a period relative
 * to the data's own latest date (answers' "last quarter"), which the executor
 * resolves with one MAX() query (`resolvePeriods`) before compiling.
 */
export type LiveFilter =
  | { kind: 'compare'; column: string; op: CompareOp; value: Cell }
  | { kind: 'contains'; column: string; value: string }
  | { kind: 'empty'; column: string; negate: boolean }
  | { kind: 'in'; column: string; values: Cell[]; negate: boolean }
  | { kind: 'range'; column: string; from?: string; to?: string }
  | { kind: 'latest'; column: string; period: AnswerPeriod; yearsBack: number };

/**
 * The whole question. A plain JSON value — the executor's cache key is
 * `stableStringify(ir)` (L2.3), so everything that changes the answer lives here,
 * including the week calendar the dates roll up under.
 *
 * `order`: `natural` is a chart's (dates and bins ascending; text by the first
 * measure, largest first, then label); `value` is an answer's ranking (largest
 * first by the first measure, then the natural key). `top` keeps the first N
 * categories in that order and needs `value`.
 */
export interface LiveIR {
  kind: 'chart' | 'metric';
  category?: LiveCategory;
  /** A split column: one series per distinct value, first measure only. */
  series?: string;
  measures: LiveMeasure[];
  filters: LiveFilter[];
  order: 'natural' | 'value';
  top?: number;
  weekCal: WeekCal | null;
}

// ── Refusals ─────────────────────────────────────────────────────────────────

export type LiveRefusalCode =
  | 'pivot' | 'cohort' | 'funnel' | 'drivers' | 'facet' | 'map' | 'related' | 'raw'
  | 'noCategory' | 'noMeasure' | 'unknownColumn' | 'notNumeric' | 'unknownAggregation'
  | 'withinKm' | 'containsNumber' | 'dateSeries' | 'periodNotDate' | 'unresolvedPeriod'
  | 'badIdentifier' | 'badSource' | 'categoryType' | 'rankOnDate' | 'rowShape' | 'badQuery'
  | 'columnMissing';

/**
 * A question live cannot answer, said in a catalog sentence (`message`, through
 * `t()` in ../liveRefusals.ts). `key` and `params` name the same sentence in
 * the catalog, for a caller that renders it itself. Never an empty result.
 */
export interface LiveRefusal {
  ok: false;
  code: LiveRefusalCode;
  key: string;
  params: Record<string, string>;
  message: string;
}

interface Sentence {
  /** The catalog key ../liveRefusals.ts's function renders — pinned by test-liveCompile. */
  key: string;
  /** The ICU parameter the one argument fills, if the sentence has one. */
  param?: 'column' | 'aggregation';
  text: (arg: string) => string;
}

const MESSAGES: Record<LiveRefusalCode, Sentence> = {
  pivot: { key: 'liveRefusals.a_pivot_table_cannot_be_drawn', text: () => msg.livePivotRefused() },
  cohort: { key: 'liveRefusals.a_cohort_chart_cannot_be_drawn', text: () => msg.liveCohortRefused() },
  funnel: { key: 'liveRefusals.an_event_funnel_cannot_be_drawn', text: () => msg.liveFunnelRefused() },
  drivers: { key: 'liveRefusals.key_drivers_cannot_be_worked_out', text: () => msg.liveDriversRefused() },
  facet: { key: 'liveRefusals.small_multiples_cannot_be_drawn_from', text: () => msg.liveFacetRefused() },
  map: { key: 'liveRefusals.a_map_cannot_be_drawn_from', text: () => msg.liveMapRefused() },
  related: { key: 'liveRefusals.a_field_from_a_related_dataset', text: () => msg.liveRelatedRefused() },
  raw: { key: 'liveRefusals.a_live_chart_needs_a_total', text: () => msg.liveRawRefused() },
  noCategory: { key: 'liveRefusals.choose_a_category_for_this_chart', text: () => msg.liveNoCategory() },
  noMeasure: { key: 'liveRefusals.choose_a_measure_for_this_chart', text: () => msg.liveNoMeasure() },
  unknownColumn: { key: 'liveRefusals.is_not_a_column_of_this', param: 'column', text: (c) => msg.liveUnknownColumn(c) },
  notNumeric: { key: 'liveRefusals.is_not_a_number_column_so', param: 'column', text: (c) => msg.liveNotNumeric(c) },
  unknownAggregation: {
    key: 'liveRefusals.is_not_an_aggregation_a_live', param: 'aggregation', text: (a) => msg.liveUnknownAggregation(a),
  },
  withinKm: { key: 'liveRefusals.a_distance_filter_cannot_run_on', text: () => msg.liveWithinKmRefused() },
  containsNumber: {
    key: 'liveRefusals.a_contains_filter_cannot_run_on', param: 'column', text: (c) => msg.liveContainsNumberRefused(c),
  },
  dateSeries: { key: 'liveRefusals.a_live_chart_cannot_be_split', param: 'column', text: (c) => msg.liveDateSeriesRefused(c) },
  periodNotDate: { key: 'liveRefusals.is_not_a_date_so_it', param: 'column', text: (c) => msg.livePeriodNotDate(c) },
  unresolvedPeriod: { key: 'liveRefusals.a_period_filter_reached_the_live', text: () => msg.liveUnresolvedPeriod() },
  badIdentifier: { key: 'liveRefusals.a_table_or_column_name_of', text: () => msg.liveBadIdentifier() },
  badSource: { key: 'liveRefusals.this_live_dataset_has_no_table', text: () => msg.liveBadSource() },
  categoryType: { key: 'liveRefusals.the_category_no_longer_has_the', param: 'column', text: (c) => msg.liveCategoryType(c) },
  rankOnDate: { key: 'liveRefusals.a_date_axis_keeps_time_order', text: () => msg.liveRankOnDate() },
  rowShape: { key: 'liveRefusals.the_warehouse_answered_in_a_shape', text: () => msg.liveRowShape() },
  badQuery: { key: 'liveRefusals.this_question_cannot_be_asked_of', text: () => msg.liveBadQuery() },
  columnMissing: { key: 'liveRefusals.is_no_longer_in_the_warehouse', param: 'column', text: (c) => msg.liveColumnMissing(c) },
};

export function refuse(code: LiveRefusalCode, arg = ''): LiveRefusal {
  const m = MESSAGES[code];
  return { ok: false, code, key: m.key, params: m.param ? { [m.param]: arg } : {}, message: m.text(arg) };
}

export function isRefusal(v: unknown): v is LiveRefusal {
  return !!v && typeof v === 'object' && (v as { ok?: unknown }).ok === false && typeof (v as LiveRefusal).code === 'string';
}

export type LiveAdapted = { ok: true; ir: LiveIR; warnings: string[] } | LiveRefusal;

export interface AdaptOpts {
  /** "Today" for a stored relative period (`dateIntel.resolvePeriod`); the server clock when absent. */
  today?: string;
  /** The week calendar to roll dates up under; the workspace setting when absent. */
  weekCal?: WeekCal | null;
}

// ── Shared checks ────────────────────────────────────────────────────────────

/** `transforms.colIndex`: exact, case-sensitive, first match. */
export function columnOf(columns: LiveColumn[], name: unknown): LiveColumn | null {
  if (typeof name !== 'string' || !Array.isArray(columns)) return null;
  for (const c of columns) if (c && c.name === name) return c;
  return null;
}

/** A measure the stored schema can answer, or why not. */
export function checkMeasure(columns: LiveColumn[], m: { column: unknown; aggregation: unknown }): LiveMeasure | LiveRefusal {
  const agg = String(m.aggregation);
  if (!LIVE_AGGS.has(agg)) return refuse('unknownAggregation', agg);
  const col = columnOf(columns, m.column);
  if (!col) return refuse('unknownColumn', String(m.column));
  if (NUMERIC_AGGS.has(agg) && col.type !== 'number') return refuse('notNumeric', col.name);
  return { column: col.name, aggregation: agg as LiveAgg };
}

function cellText(cell: Cell | undefined): string {
  return cell == null ? '' : String(cell);
}

/**
 * One stored filter step → an IR filter, `null` when the extract would SKIP it
 * (the warning pushed is `transforms.stepFilter`'s, byte for byte), or a refusal.
 */
export function adaptFilter(
  s: FilterStep,
  columns: LiveColumn[],
  opts: AdaptOpts,
  warnings: string[],
): LiveFilter | null | LiveRefusal {
  if (!s || typeof s !== 'object' || s.type !== 'filter') return null;
  const col = columnOf(columns, s.column);
  if (!col) {
    warnings.push(`Filter skipped: unknown column "${s.column}"`);
    return null;
  }
  if (!FILTER_OPS.has(s.op)) {
    warnings.push(`Filter skipped: unknown operator "${s.op}"`);
    return null;
  }
  const column = col.name;
  switch (s.op) {
    case 'within_km':
      return refuse('withinKm');
    case 'period': {
      // Resolved NOW, against the same clock and calendar `resolvePeriodNow`
      // reads, so the dates land in the IR and therefore in the cache key: the
      // answer moves at midnight without anyone invalidating anything.
      const r = s.period ? resolvePeriod(s.period, opts.today ?? todayIso(), getCalendar()) : null;
      if (!r) {
        warnings.push(periodSkipWarning(s.column));
        return null;
      }
      if (col.type !== 'date') return refuse('periodNotDate', column);
      const f: LiveFilter = { kind: 'range', column };
      if (r.from) f.from = r.from;
      if (r.to) f.to = r.to;
      return f;
    }
    case 'in':
    case 'not in': {
      const values = Array.isArray(s.values) ? s.values : [];
      if (values.length === 0) {
        warnings.push(emptyListWarning(s.column, s.op));
        return null;
      }
      return { kind: 'in', column, values: values.map((v) => (v === undefined ? null : v)), negate: s.op === 'not in' };
    }
    case 'is_empty':
    case 'not_empty':
      return { kind: 'empty', column, negate: s.op === 'not_empty' };
    case 'contains':
      if (col.type === 'number') return refuse('containsNumber', column);
      return { kind: 'contains', column, value: cellText(s.value) };
    default:
      return { kind: 'compare', column, op: s.op as CompareOp, value: s.value === undefined ? null : s.value };
  }
}

function adaptFilters(
  steps: FilterStep[] | undefined,
  columns: LiveColumn[],
  opts: AdaptOpts,
): { ok: true; filters: LiveFilter[]; warnings: string[] } | LiveRefusal {
  const filters: LiveFilter[] = [];
  const warnings: string[] = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    const f = adaptFilter(s, columns, opts, warnings);
    if (isRefusal(f)) return f;
    if (f) filters.push(f);
  }
  return { ok: true, filters, warnings };
}

// ── Charts ───────────────────────────────────────────────────────────────────

/**
 * The encoding → the chart part of the IR (no filters). Mirrors the branch
 * `buildVizData` takes: (A) aggregated, one series per measure; (B) a split,
 * FIRST MEASURE ONLY with one series per split value (`buildPivot` reads
 * `values[0]` and nothing else). (C) all-'none' raw points and (D/E) pivots,
 * cohorts and funnels are refused, as is everything that is not one dataset's
 * own columns.
 */
function chartCore(encoding: VizEncoding, columns: LiveColumn[], opts: AdaptOpts): { ok: true; ir: LiveIR } | LiveRefusal {
  if (!encoding || typeof encoding !== 'object') return refuse('noCategory');
  if (encoding.pivot) return refuse('pivot');
  if (encoding.cohort) return refuse('cohort');
  if (encoding.eventFunnel) return refuse('funnel');
  if (encoding.drivers) return refuse('drivers');
  if (encoding.facet) return refuse('facet');
  if (encoding.geo) return refuse('map');
  if (encoding.categoryDatasetId || encoding.seriesDatasetId) return refuse('related');
  if (typeof encoding.category !== 'string' || encoding.category === '') return refuse('noCategory');
  const cat = columnOf(columns, encoding.category);
  if (!cat) return refuse('unknownColumn', encoding.category);
  const values = Array.isArray(encoding.values) ? encoding.values : [];
  if (values.length === 0) return refuse('noMeasure');
  if (values.some((v) => v && v.datasetId)) return refuse('related');

  const hasSplit = typeof encoding.series === 'string' && encoding.series.length > 0;
  if (!hasSplit && values.every((v) => v && v.aggregation === 'none')) return refuse('raw');

  const measures: LiveMeasure[] = [];
  for (const v of hasSplit ? values.slice(0, 1) : values) {
    // An aggregated build sums a 'none' measure and labels it "sum of x" (vizData.ts).
    const m = checkMeasure(columns, { column: v && v.column, aggregation: v && v.aggregation === 'none' ? 'sum' : v && v.aggregation });
    if (isRefusal(m)) return m;
    measures.push(m);
  }

  const ir: LiveIR = {
    kind: 'chart',
    category: categoryOf(cat, encoding),
    measures,
    filters: [],
    order: 'natural',
    // Only a date axis reads the calendar; any other chart keeps it out of its cache key.
    weekCal: cat.type !== 'date' ? null : opts.weekCal !== undefined ? opts.weekCal : activeWeekCal(),
  };
  if (hasSplit) {
    const s = columnOf(columns, encoding.series);
    if (!s) return refuse('unknownColumn', String(encoding.series));
    if (s.type === 'date') return refuse('dateSeries', s.name);
    ir.series = s.name;
  }
  return { ok: true, ir };
}

function categoryOf(cat: LiveColumn, encoding: VizEncoding): LiveCategory {
  if (cat.type === 'number') {
    const bins = sanitizeBins(encoding.bins);
    return bins === undefined ? { column: cat.name, kind: 'bins' } : { column: cat.name, kind: 'bins', bins };
  }
  if (cat.type === 'date') {
    return isDateGrain(encoding.grain) ? { column: cat.name, kind: 'date', grain: encoding.grain } : { column: cat.name, kind: 'date' };
  }
  return { column: cat.name, kind: 'text' };
}

/** `vizDataFor(projectId, datasetId, encoding, filters)`'s question, for a live dataset. */
export function fromVizEncoding(
  encoding: VizEncoding,
  filters: FilterStep[],
  columns: LiveColumn[],
  opts: AdaptOpts = {},
): LiveAdapted {
  const core = chartCore(encoding, columns, opts);
  if (!core.ok) return core;
  const f = adaptFilters(filters, columns, opts);
  if (!f.ok) return f;
  return { ok: true, ir: { ...core.ir, filters: f.filters }, warnings: f.warnings };
}

// ── Answers ──────────────────────────────────────────────────────────────────

/**
 * `computeCard(projectId, spec)`'s question. A non-date axis is RANKED (largest
 * first) and cut to `top` — `answers.ranked` — in the warehouse; a date axis
 * keeps time order and never takes a top N.
 *
 * Text-filter case fixing ("west" asked, "West" stored) is NOT done here: it
 * needs the stored values, and on live it becomes a cached DISTINCT query
 * (L2.4). The IR carries the values as the spec states them.
 */
export function fromAnswerSpec(spec: AnswerSpec, columns: LiveColumn[], opts: AdaptOpts = {}): LiveAdapted {
  if (!spec || typeof spec !== 'object') return refuse('noCategory');
  // computeCard's own first check: every column the spec names must still exist.
  const used = [spec.category, ...(spec.measures || []).map((m) => m.column), ...(spec.filters || []).map((f) => f.column)]
    .concat(spec.series ? [spec.series] : []);
  const missing = used.find((n) => !columnOf(columns, n));
  if (missing !== undefined) return refuse('unknownColumn', String(missing));

  const encoding: VizEncoding = { category: spec.category, values: spec.measures || [] };
  if (spec.series) encoding.series = spec.series;
  if (spec.grain) encoding.grain = spec.grain;
  const core = chartCore(encoding, columns, opts);
  if (!core.ok) return core;
  const ir = core.ir;

  const warnings: string[] = [];
  for (const f of spec.filters || []) {
    if ('period' in f) {
      const col = columnOf(columns, f.column)!;
      if (col.type !== 'date') return refuse('periodNotDate', col.name);
      ir.filters.push({ kind: 'latest', column: col.name, period: f.period, yearsBack: f.yearsBack || 0 });
      continue;
    }
    const step: FilterStep = { type: 'filter', column: f.column, op: f.op };
    if (f.value !== undefined) step.value = f.value;
    if (f.values) step.values = f.values;
    const out = adaptFilter(step, columns, opts, warnings);
    if (isRefusal(out)) return out;
    if (out) ir.filters.push(out);
  }

  if (ir.category && ir.category.kind !== 'date') {
    ir.order = 'value';
    if (typeof spec.top === 'number' && Number.isInteger(spec.top) && spec.top > 0) ir.top = spec.top;
  }
  return { ok: true, ir, warnings };
}

// ── KPI tiles ────────────────────────────────────────────────────────────────

/** `metricFor(projectId, datasetId, spec, filters)`'s question: one number. */
export function fromMetric(
  spec: { column: string; aggregation: string },
  filters: FilterStep[],
  columns: LiveColumn[],
  opts: AdaptOpts = {},
): LiveAdapted {
  if (!spec || typeof spec !== 'object') return refuse('noMeasure');
  const m = checkMeasure(columns, spec);
  if (isRefusal(m)) return m;
  const f = adaptFilters(filters, columns, opts);
  if (!f.ok) return f;
  return {
    ok: true,
    ir: { kind: 'metric', measures: [m], filters: f.filters, order: 'natural', weekCal: null },
    warnings: f.warnings,
  };
}
