// The ANSWER spec — MAIN PROCESS, PURE: no fs, no model.
//
// When a question in the dock or Home's ask bar is answerable from data
// ("revenue by region last quarter", "top 5 products by profit"), the model's
// action line proposes
//
//   {"kind":"answer","intent":"…","spec":{dataset, category, measures, filters, chartType?, top?}}
//
// and the APP turns it into a chart. The model names columns; it never names a
// figure. This file is the gate between the two: every name in the spec is
// resolved against the dataset's REAL columns (the same discipline
// analysisPlan.validateVisual applies to a plan), and anything that does not
// resolve rejects the whole spec. Rejection, not repair, is deliberate for
// filters: "revenue for West" with the West filter silently dropped is a
// different, wrong answer that looks right.
//
// Relative periods ("last quarter") are resolved by the app exactly as a
// dashboard date filter resolves them — against today, under the workspace
// calendar — never by the model's idea of today, and stored as the period, not
// the dates, so a later draw moves the answer with the clock.

import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep } from '../data/transforms';
import { hasTermType, termError } from '../data/termStep';
import { FILTER_OPS, LIST_OPS, VALUELESS_OPS } from '../data/filterOps';
import type { FilterOp } from '../data/filterOps';
import type { VizAggregation, VizMeasure } from '../analysis/visuals';
import { civilFromDays, dateBucket, dateBucketLabel, daysFromCivil, isDateGrain, parseDateCell } from '../analysis/categoryKey';
import type { CivilDate, DateGrain } from '../analysis/categoryKey';
import { daysFromIso, getCalendar, isoFromDays, N_PRESETS, PERIOD_PRESETS, resolvePeriod, sanitizePeriod, todayIso } from '../analysis/dateIntel';
import type { CalendarPrefs, PeriodPreset } from '../analysis/dateIntel';
import { sameDayLastYear, weekCalOf } from '../analysis/retailCalendar';
import { grainWord, nextGrain, nextLevel } from '../analysis/drillLevels';
import type { NavHierarchy } from '../analysis/drillLevels';
// Pure, like this file: the rules for what people call a column, `squash` among them.
import { squash, taughtColumn } from '../app/columnNames';
// Pure too, and it takes only this file's TYPES back: what a loosely matched filter value remembers.
import { sanitizeMatched } from './answerValues';
import { matchTerm } from './termFacts';
import type { SpecTerm } from './termFacts';
import type { ValueMatch } from './answerValues';
import { NUMBER_AGGREGATIONS } from '../data/aggregations';

// ── Shapes ───────────────────────────────────────────────────────────────────

/** A relative period: any dashboard date-filter preset but a custom range (`dateIntel.PERIOD_PRESETS`). */
export type AnswerPeriod = Exclude<PeriodPreset, 'custom'>;
const PERIODS: ReadonlySet<string> = new Set(PERIOD_PRESETS.filter((p) => p !== 'custom'));

/** One filter as the APP stores it: an ordinary comparison, a relative period, or a reference to a glossary term (a door expands it). */
export type AnswerFilter =
  | { column: string; op: FilterOp; value?: Cell; values?: Cell[] }
  | PeriodFilter
  | { term: string };

/** `n`: how many, on a last-N period only ("last 30 days"). `yearsBack`: the same period that many years earlier. */
export type PeriodFilter = { column: string; period: AnswerPeriod; n?: number; yearsBack?: number }; // a type, not an interface: it passes as a Record (verifiedPick)

/** A period filter as stored: `n` as a dashboard's (`sanitizePeriod`: 1–3660, 1 when absent), only where it is read; `yearsBack` 1–20 or none. */
function periodFilter(column: string, period: AnswerPeriod, n: unknown, yearsBack: unknown): PeriodFilter {
  const out: PeriodFilter = { column, period };
  if (N_PRESETS.has(period)) out.n = sanitizePeriod({ preset: period, n })!.n;
  if (typeof yearsBack === 'number' && Number.isInteger(yearsBack) && yearsBack > 0 && yearsBack <= 20) out.yearsBack = yearsBack;
  return out;
}

/** A spec whose every name resolved against a real dataset. What a turn persists. */
export interface AnswerSpec {
  datasetId: string;
  category: string;
  measures: VizMeasure[];
  series?: string;
  filters: AnswerFilter[];
  chartType: string;
  /** Keep the N largest categories by the first measure. Never on a date axis. */
  top?: number;
  /** A date category's roll-up, carried over when a saved chart is explained. */
  grain?: DateGrain;
  /** The question restated — the card's title. App-trimmed, never a figure source. */
  title: string;
  /** Filter values the app matched loosely to the one the data holds, for the card's note (./answerValues). */
  matched?: ValueMatch[];
}

/** What validation needs to know about a dataset: names and declared types only. */
export interface SpecDataset {
  id: string;
  name: string;
  columns: ParsedColumn[];
  /** column → what people call it: its display name and "Also called" names (app/columnNames `taughtNames`). */
  names?: Record<string, string[]>;
  /** column → its display name, where it has one: what a suggestion is labelled with (app/columnNames `shownNames`). */
  shown?: Record<string, string>;
}

/** A defined metric the spec may name instead of a column. Formula metrics cannot chart. */
export interface SpecMetric {
  id: string;
  name: string;
  datasetId: string;
  column?: string;
  aggregation?: string;
  /** A metric with its own row filters or a snapshot means something a bare column cannot, so it never becomes a chart measure. */
  hasFilters?: boolean;
  /** The date it counts by (D9): a period the spec gives no column lands on it. */
  timeColumn?: string;
  /** Governance (part 4): only orders the vocabulary; a retired metric still computes. */
  status?: { state: 'certified' | 'needs_review' | 'retired' };
  /** A layer's metric (part 7 mirror): no column; a measure of it on its own semantic dataset names it by id. */
  external?: true;
}

/**
 * What a refused spec could not find, when it was a NAME — never a cap, a bad
 * aggregation or a bad value. `said` is the model's word; `index` is which
 * measure or filter. ./answerSuggest offers what it may have meant.
 */
export interface SpecMiss { part: 'dataset' | 'category' | 'measure' | 'series' | 'filter'; said: string; datasetId?: string; index?: number }

export type SpecResult = { ok: true; spec: AnswerSpec } | { ok: false; reason: string; miss?: SpecMiss };

const MAX_TOP = 50;
const MAX_TITLE = 120;
const MAX_MEASURES = 4;
const MAX_FILTERS = 8;

/**
 * Chart types an answer may be drawn as: the ones whose input IS "a category
 * and some measures". Not the maps (they need a geo level the model is never
 * asked for), not a pivot (a different encoding), not scatter/bubble/histogram/
 * boxplot/candlestick/sankey/gauge (each reads its series as something other
 * than values per category). Spelled out rather than imported because the
 * app's full list lives in analysisPlan.ts, which pulls in fs and the stores — and
 * this file must stay pure; scripts/test-answerSpec.ts asserts it is a subset.
 */
export const ANSWER_CHART_TYPES: ReadonlySet<string> = new Set([
  'column', 'bar', 'clustered_column', 'clustered_bar', 'stacked_column', 'stacked_bar',
  'pct_stacked_column', 'pct_stacked_bar', 'line', 'line_markers', 'area', 'stacked_area',
  'pie', 'donut', 'treemap', 'funnel', 'heatmap', 'table',
  // Category-and-measures types too: a Pareto is "top N by X" with its
  // cumulative share, a waterfall is the steps between them, a bullet reads a
  // second measure as its target, a radar compares several measures.
  'pareto', 'waterfall', 'bullet', 'radar',
]);

/** Aggregations that need a number column — the rule analysisPlan.NUMERIC_AGGS states. */
const NUMERIC_AGGS: ReadonlySet<string> = new Set<string>(NUMBER_AGGREGATIONS);

// ── Name resolution ──────────────────────────────────────────────────────────

/**
 * A model-written column name → the dataset's real column name, or null.
 *
 * Exact first, then case-insensitive, then "squashed" ("Order date" →
 * order_date). Each looser pass must be UNAMBIGUOUS: two columns that squash to
 * the same key resolve to neither, because picking one is a guess.
 *
 * Only then the names people TAUGHT (`names`: a column's display name and its
 * "Also called" list — app/columnNames `taughtColumn`), under the same rule. So
 * a real column name always beats another column's taught name, and two real
 * columns the name cannot tell apart are never settled by a third's alias.
 */
export function resolveColumn(name: unknown, columns: ParsedColumn[], names?: Record<string, string[]>): ParsedColumn | null {
  if (typeof name !== 'string' || !name.trim()) return null;
  const n = name.trim();
  const exact = columns.find((c) => c.name === n);
  if (exact) return exact;
  const lower = columns.filter((c) => c.name.toLowerCase() === n.toLowerCase());
  if (lower.length === 1) return lower[0];
  const key = squash(n);
  const loose = key ? columns.filter((c) => squash(c.name) === key) : [];
  if (loose.length || !names) return loose.length === 1 ? loose[0] : null;
  return taughtColumn(n, columns, names);
}

const AGG_ALIASES: Record<string, VizAggregation> = {
  sum: 'sum', total: 'sum',
  avg: 'avg', average: 'avg', mean: 'avg',
  count: 'count', number: 'count',
  min: 'min', minimum: 'min', lowest: 'min',
  max: 'max', maximum: 'max', highest: 'max',
  countd: 'countd', count_distinct: 'countd', 'count distinct': 'countd', distinct: 'countd', unique: 'countd',
};

export function parseAgg(raw: unknown): VizAggregation | null {
  if (typeof raw !== 'string') return null;
  return AGG_ALIASES[raw.trim().toLowerCase()] || null;
}

/** "sum(revenue)" → ['sum', 'revenue']; "revenue" → [null, 'revenue']. */
function splitCall(s: string): [string | null, string] {
  const m = /^\s*([a-zA-Z]+)\s*\(\s*(.+?)\s*\)\s*$/.exec(s);
  return m ? [m[1], m[2]] : [null, s];
}

/** A raw measure as written — "sum(revenue)", or {column | name | metric, aggregation | agg} — as its name and aggregation. */
export function readMeasure(raw: unknown): { column: unknown; agg: unknown } | null {
  if (typeof raw === 'string') {
    const [agg, column] = splitCall(raw);
    return { column, agg };
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return { column: o.column ?? o.name ?? o.metric, agg: o.aggregation ?? o.agg };
}

/** A name that resolved to nothing, as a resolver hands it back. */
interface Unknown { unknown: unknown }

/** The refusal for a name nothing answers to — typed (`SpecMiss`) when a name was actually said. */
function unknownName(part: SpecMiss['part'], what: string, said: unknown, datasetId?: string, index?: number): SpecResult {
  const reason = `Unknown ${what} "${String(said)}".`;
  if (typeof said !== 'string' || !said.trim()) return { ok: false, reason };
  return { ok: false, reason, miss: { part, said, ...(datasetId ? { datasetId } : {}), ...(index === undefined ? {} : { index }) } };
}

function resolveMeasure(
  raw: unknown,
  columns: ParsedColumn[],
  metrics: SpecMetric[],
  datasetId: string,
  names?: Record<string, string[]>,
): VizMeasure | string | Unknown {
  const read = readMeasure(raw);
  if (!read) return 'A measure must name a column.';
  const { column: colName, agg: aggRaw } = read;

  let col = resolveColumn(colName, columns);
  if (!col) {
    // A defined metric by NAME — the project's own vocabulary. Only a simple
    // column metric on THIS dataset can become a chart measure.
    const name = typeof colName === 'string' ? colName.trim().toLowerCase() : '';
    const m = metrics.find((x) => x.datasetId === datasetId && x.name.trim().toLowerCase() === name);
    if (m?.external) return { column: '', aggregation: 'sum', metricId: m.id }; // a layer's metric: the layer computes it
    if (m && m.column && !m.hasFilters && resolveColumn(m.column, columns)) {
      const agg = parseAgg(m.aggregation) || 'sum';
      return { column: resolveColumn(m.column, columns)!.name, aggregation: agg, metricId: m.id };
    }
    // A name the user gave a METRIC is that metric, usable here or not — never
    // a column that is also called that, which would be a different number. So it is
    // no unknown NAME either: "Did you mean" would offer exactly that column.
    if (m) return `Unknown measure column "${String(colName)}".`;
    col = resolveColumn(colName, columns, names);
    // A metric of that name on ANOTHER dataset is that metric too: refused plainly, never offered as a column here.
    if (!col) return metrics.some((x) => x.name.trim().toLowerCase() === name) ? `Unknown measure column "${String(colName)}".` : { unknown: colName };
  }

  let agg = aggRaw === undefined || aggRaw === null || aggRaw === '' ? null : parseAgg(aggRaw);
  if (aggRaw !== undefined && aggRaw !== null && aggRaw !== '' && !agg) {
    return `Unknown aggregation "${String(aggRaw)}".`;
  }
  // The default is the column's own: a number is summed, anything else counted.
  if (!agg) agg = col.type === 'number' ? 'sum' : 'count';
  if (NUMERIC_AGGS.has(agg) && col.type !== 'number') {
    const verb: Record<string, string> = { sum: 'summed', avg: 'averaged', min: 'given a minimum', max: 'given a maximum' };
    return `"${col.name}" is ${col.type}, so it cannot be ${verb[agg]}.`;
  }
  return { column: col.name, aggregation: agg };
}

const OP_ALIASES: Record<string, FilterOp> = {
  '=': '=', '==': '=', eq: '=', is: '=', equals: '=',
  '!=': '!=', '<>': '!=', ne: '!=', not: '!=',
  '>': '>', gt: '>', '<': '<', lt: '<', '>=': '>=', gte: '>=', '<=': '<=', lte: '<=',
  contains: 'contains', in: 'in', 'not in': 'not in', not_in: 'not in',
  is_empty: 'is_empty', not_empty: 'not_empty',
};

/** A raw filter's operator as the validator reads it: its aliases, and a bare list meaning `in`. Null: no operator it knows. */
export function filterOp(o: Record<string, unknown>): FilterOp | null {
  const key = typeof o.op === 'string' ? o.op.trim().toLowerCase() : Array.isArray(o.values) || Array.isArray(o.value) ? 'in' : '=';
  return Object.prototype.hasOwnProperty.call(OP_ALIASES, key) ? OP_ALIASES[key] : null;
}

function coerce(v: unknown, col: ParsedColumn): Cell | undefined {
  if (v === null) return null;
  if (col.type === 'number') {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  return undefined;
}

/** `periodOn`: the column a period with none of its own lands on (the date the spec's metrics count by), or ''. */
function resolveFilter(raw: unknown, columns: ParsedColumn[], names?: Record<string, string[]>, periodOn = ''): AnswerFilter | string | Unknown {
  if (!raw || typeof raw !== 'object') return 'A filter must be an object.';
  const o = raw as Record<string, unknown>;
  const col = resolveColumn(o.period !== undefined && (o.column === undefined || o.column === null || o.column === '') && periodOn ? periodOn : o.column, columns, names);
  if (!col) return { unknown: o.column };

  if (o.period !== undefined) {
    const p = typeof o.period === 'string' ? o.period.trim().toLowerCase() : '';
    if (!PERIODS.has(p)) return `Unknown period "${String(o.period)}".`;
    if (col.type !== 'date') return `"${col.name}" is not a date, so it cannot be filtered to a period.`;
    return periodFilter(col.name, p as AnswerPeriod, o.n, o.yearsBack);
  }

  const op = filterOp(o);
  if (!op || !FILTER_OPS.has(op)) return `Unknown filter operator "${String(o.op)}".`;
  if (VALUELESS_OPS.has(op)) return { column: col.name, op };
  if (LIST_OPS.has(op)) {
    const list = Array.isArray(o.values) ? o.values : Array.isArray(o.value) ? o.value : [o.value];
    const values = list.map((v) => coerce(v, col));
    if (!values.length || values.some((v) => v === undefined)) return `A value in the "${col.name}" filter does not fit a ${col.type} column.`;
    return { column: col.name, op, values: values as Cell[] };
  }
  const value = coerce(Array.isArray(o.value) ? o.value[0] : o.value, col);
  if (value === undefined) return `The "${col.name}" filter value does not fit a ${col.type} column.`;
  return { column: col.name, op, value };
}

function resolveDataset(raw: unknown, datasets: SpecDataset[], defaultId?: string): SpecDataset | null {
  if (typeof raw === 'string' && raw.trim()) {
    const r = raw.trim();
    const byId = datasets.find((d) => d.id === r);
    if (byId) return byId;
    const byName = datasets.filter((d) => d.name.trim().toLowerCase() === r.toLowerCase());
    if (byName.length === 1) return byName[0];
    const key = squash(r); // '' (a name of symbols only) matches nothing, as for a column
    const loose = key ? datasets.filter((d) => squash(d.name) === key) : [];
    if (loose.length === 1) return loose[0];
    return null;
  }
  if (defaultId) return datasets.find((d) => d.id === defaultId) || null;
  return datasets.length === 1 ? datasets[0] : null;
}

/** The default chart for a resolved spec: a line over dates, clusters for a split, else columns. */
export function defaultAnswerChart(categoryType: string, hasSeries: boolean): string {
  if (categoryType === 'date') return 'line';
  return hasSeries ? 'clustered_column' : 'column';
}

/**
 * The model's raw spec → a spec every name of which resolved, or the first
 * reason it could not. Never throws.
 *
 * `defaultDatasetId` is the dataset in context (the open dataset page); with
 * none, a project holding exactly one dataset is unambiguous.
 */
export function validateAnswerSpec(
  raw: unknown,
  datasets: SpecDataset[],
  opts: { defaultDatasetId?: string; metrics?: SpecMetric[]; title?: string; terms?: SpecTerm[] } = {},
): SpecResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'The answer has no spec.' };
  const o = raw as Record<string, unknown>;
  const ds = resolveDataset(o.dataset ?? o.datasetId, datasets, opts.defaultDatasetId);
  if (!ds) return unknownName('dataset', 'dataset', o.dataset ?? '');

  const cat = resolveColumn(o.category, ds.columns, ds.names);
  if (!cat) return unknownName('category', 'category column', o.category, ds.id);

  const measuresRaw = Array.isArray(o.measures) ? o.measures : o.measure !== undefined ? [o.measure] : [];
  if (!measuresRaw.length) return { ok: false, reason: 'The answer names no measure.' };
  if (measuresRaw.length > MAX_MEASURES) return { ok: false, reason: `At most ${MAX_MEASURES} measures.` };
  const measures: VizMeasure[] = [];
  for (const [i, m] of measuresRaw.entries()) {
    const r = resolveMeasure(m, ds.columns, opts.metrics || [], ds.id, ds.names);
    if (typeof r === 'string') return { ok: false, reason: r };
    if ('unknown' in r) return unknownName('measure', 'measure column', r.unknown, ds.id, i);
    measures.push(r);
  }

  let series: string | undefined;
  if (o.series !== undefined && o.series !== null && o.series !== '') {
    const s = resolveColumn(o.series, ds.columns, ds.names);
    if (!s) return unknownName('series', 'split column', o.series, ds.id);
    if (s.name === cat.name) return { ok: false, reason: 'The split cannot be the category.' };
    series = s.name;
  }

  const filtersRaw = Array.isArray(o.filters) ? o.filters : [];
  if (filtersRaw.length > MAX_FILTERS) return { ok: false, reason: `At most ${MAX_FILTERS} filters.` };
  const filters: AnswerFilter[] = [];
  // D9: the one date the spec's metric measures count by, when it is a date column here — where "last month" lands.
  const dates = new Set(measures.filter((m) => m.metricId).map((m) => (opts.metrics || []).find((x) => x.id === m.metricId)?.timeColumn ?? ''));
  const shared = dates.size === 1 ? [...dates][0] : '';
  const periodOn = shared && ds.columns.some((c) => c.name === shared && c.type === 'date') ? shared : '';
  for (const [i, f] of filtersRaw.entries()) {
    if (f && typeof f === 'object' && 'term' in f) { // a glossary term, by its name, an alias or its id (./termFacts)
      const said = (f as { term: unknown }).term;
      const t = matchTerm(said, opts.terms || []);
      if (!t) return { ok: false, reason: `There is no glossary term called "${String(said)}".` };
      if (t.datasetId !== ds.id) return { ok: false, reason: `"${t.name}" is a term of another dataset, not ${ds.name}.` }; // an answer never joins
      filters.push({ term: t.id });
      continue;
    }
    const r = resolveFilter(f, ds.columns, ds.names, periodOn);
    if (typeof r === 'string') return { ok: false, reason: r };
    if ('unknown' in r) return unknownName('filter', 'filter column', r.unknown, ds.id, i);
    filters.push(r);
  }

  const wanted = typeof o.chartType === 'string' ? o.chartType.trim() : '';
  const chartType = wanted && ANSWER_CHART_TYPES.has(wanted) ? wanted : defaultAnswerChart(cat.type, !!series);

  const spec: AnswerSpec = {
    datasetId: ds.id,
    category: cat.name,
    measures,
    filters,
    chartType,
    title: cleanTitle(opts.title) || defaultTitle(measures, cat.name),
  };
  if (series) spec.series = series;
  const top = typeof o.top === 'number' ? o.top : typeof o.limit === 'number' ? o.limit : NaN;
  if (Number.isInteger(top) && top > 0 && cat.type !== 'date') spec.top = Math.min(top, MAX_TOP);
  // A date axis's roll-up, when the spec carries one: a refined answer keeps its chart's (./answerRefine).
  if (isDateGrain(o.grain) && cat.type === 'date') spec.grain = o.grain;
  return { ok: true, spec };
}

function cleanTitle(t: unknown): string {
  if (typeof t !== 'string') return '';
  const s = t.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const cut = s.length > MAX_TITLE ? s.slice(0, MAX_TITLE - 1).trimEnd() + '…' : s;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

function measureWords(m: VizMeasure): string {
  if (m.aggregation === 'count') return `count of ${m.column}`;
  if (m.aggregation === 'sum') return m.column;
  if (m.aggregation === 'countd') return `distinct ${m.column}`;
  return `${m.aggregation} ${m.column}`;
}

export function defaultTitle(measures: VizMeasure[], category: string): string {
  return cleanTitle(`${measures.map(measureWords).join(' and ')} by ${category}`);
}

// ── Stored-shape re-sanitising (a persisted turn is untrusted on read) ───────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SHAPE-only whitelist of a stored spec — for copilot.json on load. Column
 * existence is checked again when the card is computed (the dataset may have
 * changed since), so this only guarantees the object is the right shape.
 */
export function sanitizeStoredSpec(raw: unknown): AnswerSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, any>;
  if (typeof o.datasetId !== 'string' || !UUID_RE.test(o.datasetId)) return undefined;
  if (typeof o.category !== 'string' || !o.category) return undefined;
  const measures: VizMeasure[] = (Array.isArray(o.measures) ? o.measures : [])
    .filter((m: any) => m && typeof m.column === 'string' && typeof m.aggregation === 'string' && (AGG_ALIASES[m.aggregation] === m.aggregation))
    .slice(0, MAX_MEASURES)
    .map((m: any) => (typeof m.metricId === 'string' && UUID_RE.test(m.metricId)
      ? { column: m.column, aggregation: m.aggregation, metricId: m.metricId }
      : { column: m.column, aggregation: m.aggregation }));
  if (!measures.length) return undefined;
  const filters: AnswerFilter[] = [];
  for (const f of Array.isArray(o.filters) ? o.filters.slice(0, MAX_FILTERS) : []) {
    if (f && typeof f.column !== 'string' && typeof f.term === 'string' && UUID_RE.test(f.term)) {
      filters.push({ term: f.term }); // a reference to a glossary term: kept whole, nothing else of it
      continue;
    }
    if (!f || typeof f.column !== 'string') continue;
    if (typeof f.period === 'string' && PERIODS.has(f.period)) {
      filters.push(periodFilter(f.column, f.period as AnswerPeriod, f.n, f.yearsBack));
    } else if (typeof f.op === 'string' && FILTER_OPS.has(f.op)) {
      const out: AnswerFilter = { column: f.column, op: f.op as FilterOp };
      if (f.value === null || typeof f.value === 'string' || typeof f.value === 'number') out.value = f.value;
      if (Array.isArray(f.values)) out.values = f.values.filter((v: unknown) => v === null || typeof v === 'string' || typeof v === 'number');
      filters.push(out);
    }
  }
  const spec: AnswerSpec = {
    datasetId: o.datasetId,
    category: o.category,
    measures,
    filters,
    chartType: typeof o.chartType === 'string' && ANSWER_CHART_TYPES.has(o.chartType) ? o.chartType : 'column',
    title: cleanTitle(o.title) || defaultTitle(measures, o.category),
  };
  if (typeof o.series === 'string' && o.series) spec.series = o.series;
  if (Number.isInteger(o.top) && o.top > 0) spec.top = Math.min(o.top, MAX_TOP);
  if (isDateGrain(o.grain)) spec.grain = o.grain;
  const matched = sanitizeMatched(o.matched, filters);
  if (matched.length) spec.matched = matched;
  return spec;
}

// ── Periods: resolved by the APP as a dashboard date filter is ──────────────

/** The date-axis bucket a period may be exactly one of, for its label; a last-N, to-date period has none and is named by its days. */
const PERIOD_GRAIN: Partial<Record<AnswerPeriod, DateGrain>> = {
  today: 'day', yesterday: 'day', this_week: 'week', last_week: 'week', this_month: 'month', last_month: 'month',
  this_quarter: 'quarter', last_quarter: 'quarter', this_year: 'year', last_year: 'year',
};

/** The latest real date in a column's cells, or null. What an empty answer's note says the data ends on. */
export function latestDate(cells: Cell[]): CivilDate | null {
  let best: CivilDate | null = null;
  for (const c of cells) {
    const d = parseDateCell(c);
    if (!d) continue;
    if (!best || d.y > best.y || (d.y === best.y && (d.m > best.m || (d.m === best.m && d.d > best.d)))) best = d;
  }
  return best;
}

/** The same day `n` years back: by fiscal position under a week calendar (week 53 → week 52), else by the calendar. */
function yearsAgo(today: string, n: number, cal: CalendarPrefs): string {
  const t = daysFromIso(today);
  if (t === null || n <= 0) return today;
  const wc = weekCalOf(cal);
  if (wc) {
    let day = t;
    for (let i = 0; i < n; i += 1) day = sameDayLastYear(day, wc);
    return isoFromDays(day);
  }
  const c = civilFromDays(t);
  return isoFromDays(daysFromCivil(c.y - n, c.m, Math.min(c.d, 28)));
}

/**
 * An answer's period → its inclusive days and the label the card and the facts show ("2026-Q3").
 *
 * "Last quarter" means what a dashboard's date filter means by it: the previous COMPLETE quarter before
 * today, under the workspace calendar (fiscal year start, week calendar) — `dateIntel.resolvePeriod`, the
 * same function, clock (`todayIso`) and calendar (`getCalendar`) every dashboard filter reads. Never the
 * data's own latest quarter: a dataset refreshed daily always reaches today, so that would be "this quarter
 * so far". A dataset that ends before the period answers no rows, and the card says why
 * (ipc/answers `stalePeriodNotes`), never another period. `yearsBack` ("Same for last year") resolves the
 * period as it stood on the same day that many years back.
 *
 * The label is the date axis's own name for the range when it is exactly one of its buckets ("2026-Q3", a
 * week calendar's "FY26 Q3"); a fiscal quarter that is no calendar quarter is named by its days
 * ("2026-08-01 to 2026-10-31"), as a dashboard names a custom range.
 */
export function answerPeriod(
  p: Pick<PeriodFilter, 'period' | 'n' | 'yearsBack'>,
  today: string = todayIso(),
  cal: CalendarPrefs = getCalendar(),
): { from: string; to: string; label: string } {
  const r = resolvePeriod({ preset: p.period, n: p.n }, yearsAgo(today, p.yearsBack || 0, cal), cal);
  if (!r || !r.from || !r.to) throw new Error(`Unreadable period ${p.period} on ${today}`); // a preset always resolves on a real day
  const grain = PERIOD_GRAIN[p.period];
  if (!grain) return { from: r.from, to: r.to, label: `${r.from} to ${r.to}` };
  const f = daysFromIso(r.from)!;
  const t = daysFromIso(r.to)!;
  const bucketOf = (day: number): number => dateBucket(civilFromDays(day), grain);
  const one = bucketOf(f) === f && bucketOf(t) === f && bucketOf(t + 1) === t + 1;
  return { from: r.from, to: r.to, label: one ? dateBucketLabel(f, grain) : `${r.from} to ${r.to}` };
}

/**
 * An EMPTY answer's periods that start after its data ends (a stale dataset): each one's label and the day
 * the data ends, for the card to say why (ai/answerMessages `periodAfterData`) — never another period.
 * `ends`: a period column's latest day (ISO) over the caller's rows, or null when unknown.
 */
export function periodsAfterData(spec: Pick<AnswerSpec, 'filters'>, ends: (column: string) => string | null): Array<{ label: string; ends: string }> {
  const out: Array<{ label: string; ends: string }> = [];
  for (const f of spec.filters) {
    if (!('period' in f)) continue;
    const p = answerPeriod(f);
    const e = ends(f.column);
    if (e && e < p.from) out.push({ label: p.label, ends: e });
  }
  return out;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The spec's filters → ordinary FilterSteps over THIS dataset's cells.
 *
 * A period (`answerPeriod`: today's, as a dashboard filter's) over a column of
 * plain ISO days becomes two bounds. Over any other date text it becomes an
 * `in` list of the column's distinct cells that fall in the period's days — not
 * bounds, because a date column is stored and compared as TEXT and only plain
 * ISO days order correctly that way, where the day test uses the same parser
 * every date axis in the app groups by. No row is read for the period itself,
 * so the Live path (no rows) labels and steps it the same way.
 *
 * `labels` describes each filter for the card ("order_date: 2024-Q4").
 */
export function specFilterSteps(
  spec: Pick<AnswerSpec, 'filters'>,
  columns: ParsedColumn[],
  rows: Cell[][],
): { steps: FilterStep[]; labels: string[] } {
  const steps: FilterStep[] = [];
  const labels: string[] = [];
  for (const f of spec.filters) {
    if ('term' in f || hasTermType(f)) throw termError(f); // a door expands it; never skipped, never dropped
    const ci = columns.findIndex((c) => c.name === f.column);
    if (ci < 0) continue;
    if ('period' in f) {
      const cells = rows.map((r) => (r ? r[ci] ?? null : null));
      const p = answerPeriod(f);
      labels.push(`${f.column}: ${p.label}`);
      // Plain ISO days compare correctly as text, so the period is two bounds —
      // which is also what a user reading the saved chart's filter expects.
      if (cells.every((c) => c === null || c === '' || (typeof c === 'string' && ISO_DAY.test(c)))) {
        steps.push({ type: 'filter', column: f.column, op: '>=', value: p.from });
        steps.push({ type: 'filter', column: f.column, op: '<=', value: p.to });
        continue;
      }
      const lo = daysFromIso(p.from)!;
      const hi = daysFromIso(p.to)!;
      const keep = new Set<string>();
      const values: Cell[] = [];
      for (const c of cells) {
        const d = parseDateCell(c);
        const day = d ? daysFromCivil(d.y, d.m, d.d) : NaN;
        if (!(day >= lo && day <= hi)) continue;
        const k = String(c);
        if (!keep.has(k)) { keep.add(k); values.push(c); }
      }
      // An empty list would SKIP the step (filterOps.emptyListWarning) and show
      // all time under a period's label; a value no cell holds matches nothing.
      steps.push({ type: 'filter', column: f.column, op: 'in', values: values.length ? values : ['\u0000'] });
    } else {
      const step: FilterStep = { type: 'filter', column: f.column, op: f.op };
      if (f.value !== undefined) step.value = f.value;
      if (f.values) step.values = f.values;
      steps.push(step);
      const v = f.values ? f.values.join(', ') : f.value === undefined ? '' : String(f.value);
      labels.push(`${f.column} ${f.op}${v ? ' ' + v : ''}`);
    }
  }
  return { steps, labels };
}

// ── Follow-up chips: generated by the APP from the spec ──────────────────────

export interface AnswerChip {
  label: string;
  spec: AnswerSpec;
  /** A "Did you mean" option that put a COLUMN where a name missed: that column, so the answer it runs can offer to remember the name (./answerSuggest). */
  column?: string;
}

/**
 * The next questions worth one click, derived from the spec's SHAPE. Each chip
 * carries a complete spec, so clicking it re-runs the app's computation with
 * no model call at all.
 *
 *   - "Split by <col>"   — no split yet, and a low-cardinality text column other
 *                          than the category exists (`splitCandidates`, which the
 *                          caller ranks from the data).
 *   - "Same for last year" — the dataset has a date column: a period filter moves
 *                          back a year, and an all-time answer narrows to last
 *                          year (`answerPeriod`, as a dashboard means it).
 *   - "Show as table"    — unless it already is one.
 */
export function answerChips(
  spec: AnswerSpec,
  ctx: { columns: ParsedColumn[]; splitCandidates: string[]; hierarchies?: readonly NavHierarchy[]; ladder?: readonly DateGrain[] },
): AnswerChip[] {
  const chips: AnswerChip[] = [];
  const catCol = ctx.columns.find((c) => c.name === spec.category);

  if (!spec.series) {
    const split = ctx.splitCandidates.find((c) => c !== spec.category);
    if (split) {
      chips.push({
        label: `Split by ${split}`,
        spec: {
          ...spec,
          series: split,
          chartType: catCol && catCol.type === 'date' ? 'line' : 'stacked_column',
          title: cleanTitle(`${spec.title} split by ${split}`),
        },
      });
    }
  }

  // One step down: a hierarchy's next level regroups the whole answer; a set grain steps to the finer one (an auto grain has no rung).
  // A next level that is none of `columns` (a column hidden from the caller, part 4) is no chip.
  const down = ctx.hierarchies && nextLevel(ctx.hierarchies, spec.category);
  const finer = ctx.ladder && spec.grain && catCol?.type === 'date' ? nextGrain(ctx.ladder, spec.grain) : null;
  if (down && ctx.columns.some((c) => c.name === down.next)) chips.push({ label: `By ${down.next}`, spec: { ...spec, category: down.next, title: cleanTitle(`${spec.title} by ${down.next}`) } });
  else if (finer) chips.push({ label: `By ${grainWord(finer, ctx.ladder!)}`, spec: { ...spec, grain: finer } });

  const periodIdx = spec.filters.findIndex((f) => 'period' in f);
  const dateCol = ctx.columns.find((c) => c.type === 'date');
  if (periodIdx >= 0) {
    const f = spec.filters[periodIdx] as PeriodFilter;
    const filters = spec.filters.slice();
    filters[periodIdx] = { ...f, yearsBack: (f.yearsBack || 0) + 1 };
    chips.push({ label: 'Same for last year', spec: { ...spec, filters, title: cleanTitle(`${spec.title}, a year earlier`) } });
  } else if (dateCol && dateCol.name !== spec.category) {
    chips.push({
      label: 'Same for last year',
      spec: {
        ...spec,
        filters: spec.filters.concat([{ column: dateCol.name, period: 'last_year' }]),
        title: cleanTitle(`${spec.title}, last year`),
      },
    });
  }

  if (spec.chartType !== 'table') chips.push({ label: 'Show as table', spec: { ...spec, chartType: 'table' } });
  return chips;
}

/** Text columns worth splitting by: 2–12 distinct values, fewest first. The app counts. */
export function splitCandidates(columns: ParsedColumn[], rows: Cell[][], exclude: string): string[] {
  const out: { name: string; n: number }[] = [];
  columns.forEach((c, ci) => {
    if (c.type !== 'text' || c.name === exclude) return;
    const seen = new Set<string>();
    for (const r of rows) {
      const v = r ? r[ci] : null;
      if (v === null || v === undefined || String(v).trim() === '') continue;
      seen.add(String(v));
      if (seen.size > 12) return;
    }
    if (seen.size >= 2) out.push({ name: c.name, n: seen.size });
  });
  return out.sort((a, b) => a.n - b.n).map((x) => x.name);
}
