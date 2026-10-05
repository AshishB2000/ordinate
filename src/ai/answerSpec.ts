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
// Relative periods ("last quarter") are resolved by the app against the data's
// own latest date — never the model's idea of today — and stored as the period,
// not the dates, so a refreshed dataset moves the answer with it.

import type { ParsedColumn } from '../data/parse';
import type { Cell, FilterStep } from '../data/transforms';
import { FILTER_OPS, LIST_OPS, VALUELESS_OPS } from '../data/filterOps';
import type { FilterOp } from '../data/filterOps';
import type { VizAggregation, VizMeasure } from '../analysis/visuals';
import { dateBucket, dateBucketLabel, isDateGrain, parseDateCell } from '../analysis/categoryKey';
import type { CivilDate, DateGrain } from '../analysis/categoryKey';

// ── Shapes ───────────────────────────────────────────────────────────────────

export type AnswerPeriod = 'last_month' | 'last_quarter' | 'last_year';
const PERIODS: ReadonlySet<string> = new Set(['last_month', 'last_quarter', 'last_year']);

/** One filter as the APP stores it: an ordinary comparison, or a relative period. */
export type AnswerFilter =
  | { column: string; op: FilterOp; value?: Cell; values?: Cell[] }
  | { column: string; period: AnswerPeriod; yearsBack?: number };

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
}

/** What validation needs to know about a dataset: names and declared types only. */
export interface SpecDataset {
  id: string;
  name: string;
  columns: ParsedColumn[];
}

/** A defined metric the spec may name instead of a column. Formula metrics cannot chart. */
export interface SpecMetric {
  id: string;
  name: string;
  datasetId: string;
  column?: string;
  aggregation?: string;
  /** A metric with its own row filters means something a bare column cannot, so it never becomes a chart measure. */
  hasFilters?: boolean;
}

export type SpecResult = { ok: true; spec: AnswerSpec } | { ok: false; reason: string };

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
const NUMERIC_AGGS: ReadonlySet<string> = new Set(['sum', 'avg', 'min', 'max']);

// ── Name resolution ──────────────────────────────────────────────────────────

/** Case, spaces, underscores and punctuation are not part of a column's identity to a reader. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * A model-written column name → the dataset's real column name, or null.
 *
 * Exact first, then case-insensitive, then "squashed" ("Order date" →
 * order_date). Each looser pass must be UNAMBIGUOUS: two columns that squash to
 * the same key resolve to neither, because picking one is a guess.
 */
export function resolveColumn(name: unknown, columns: ParsedColumn[]): ParsedColumn | null {
  if (typeof name !== 'string' || !name.trim()) return null;
  const n = name.trim();
  const exact = columns.find((c) => c.name === n);
  if (exact) return exact;
  const lower = columns.filter((c) => c.name.toLowerCase() === n.toLowerCase());
  if (lower.length === 1) return lower[0];
  const key = squash(n);
  if (!key) return null;
  const loose = columns.filter((c) => squash(c.name) === key);
  return loose.length === 1 ? loose[0] : null;
}

const AGG_ALIASES: Record<string, VizAggregation> = {
  sum: 'sum', total: 'sum',
  avg: 'avg', average: 'avg', mean: 'avg',
  count: 'count', number: 'count',
  min: 'min', minimum: 'min', lowest: 'min',
  max: 'max', maximum: 'max', highest: 'max',
};

function parseAgg(raw: unknown): VizAggregation | null {
  if (typeof raw !== 'string') return null;
  return AGG_ALIASES[raw.trim().toLowerCase()] || null;
}

/** "sum(revenue)" → ['sum', 'revenue']; "revenue" → [null, 'revenue']. */
function splitCall(s: string): [string | null, string] {
  const m = /^\s*([a-zA-Z]+)\s*\(\s*(.+?)\s*\)\s*$/.exec(s);
  return m ? [m[1], m[2]] : [null, s];
}

function resolveMeasure(
  raw: unknown,
  columns: ParsedColumn[],
  metrics: SpecMetric[],
  datasetId: string,
): VizMeasure | string {
  let colName: unknown;
  let aggRaw: unknown;
  if (typeof raw === 'string') {
    const [a, c] = splitCall(raw);
    aggRaw = a;
    colName = c;
  } else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    colName = o.column ?? o.name ?? o.metric;
    aggRaw = o.aggregation ?? o.agg;
  } else {
    return 'A measure must name a column.';
  }

  const col = resolveColumn(colName, columns);
  if (!col) {
    // A defined metric by NAME — the project's own vocabulary. Only a simple
    // column metric on THIS dataset can become a chart measure.
    const name = typeof colName === 'string' ? colName.trim().toLowerCase() : '';
    const m = metrics.find((x) => x.datasetId === datasetId && x.name.trim().toLowerCase() === name);
    if (m && m.column && !m.hasFilters && resolveColumn(m.column, columns)) {
      const agg = parseAgg(m.aggregation) || 'sum';
      return { column: resolveColumn(m.column, columns)!.name, aggregation: agg, metricId: m.id };
    }
    return `Unknown measure column "${String(colName)}".`;
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

function coerce(v: unknown, col: ParsedColumn): Cell | undefined {
  if (v === null) return null;
  if (col.type === 'number') {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  return undefined;
}

function resolveFilter(raw: unknown, columns: ParsedColumn[]): AnswerFilter | string {
  if (!raw || typeof raw !== 'object') return 'A filter must be an object.';
  const o = raw as Record<string, unknown>;
  const col = resolveColumn(o.column, columns);
  if (!col) return `Unknown filter column "${String(o.column)}".`;

  if (o.period !== undefined) {
    const p = typeof o.period === 'string' ? o.period.trim().toLowerCase() : '';
    if (!PERIODS.has(p)) return `Unknown period "${String(o.period)}".`;
    if (col.type !== 'date') return `"${col.name}" is not a date, so it cannot be filtered to a period.`;
    const yb = typeof o.yearsBack === 'number' && Number.isInteger(o.yearsBack) && o.yearsBack > 0 && o.yearsBack <= 20
      ? o.yearsBack : 0;
    return yb ? { column: col.name, period: p as AnswerPeriod, yearsBack: yb } : { column: col.name, period: p as AnswerPeriod };
  }

  const opKey = typeof o.op === 'string' ? o.op.trim().toLowerCase() : Array.isArray(o.values) || Array.isArray(o.value) ? 'in' : '=';
  const op = OP_ALIASES[opKey];
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
    const loose = datasets.filter((d) => squash(d.name) === squash(r));
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
  opts: { defaultDatasetId?: string; metrics?: SpecMetric[]; title?: string } = {},
): SpecResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'The answer has no spec.' };
  const o = raw as Record<string, unknown>;
  const ds = resolveDataset(o.dataset ?? o.datasetId, datasets, opts.defaultDatasetId);
  if (!ds) return { ok: false, reason: `Unknown dataset "${String(o.dataset ?? '')}".` };

  const cat = resolveColumn(o.category, ds.columns);
  if (!cat) return { ok: false, reason: `Unknown category column "${String(o.category)}".` };

  const measuresRaw = Array.isArray(o.measures) ? o.measures : o.measure !== undefined ? [o.measure] : [];
  if (!measuresRaw.length) return { ok: false, reason: 'The answer names no measure.' };
  if (measuresRaw.length > MAX_MEASURES) return { ok: false, reason: `At most ${MAX_MEASURES} measures.` };
  const measures: VizMeasure[] = [];
  for (const m of measuresRaw) {
    const r = resolveMeasure(m, ds.columns, opts.metrics || [], ds.id);
    if (typeof r === 'string') return { ok: false, reason: r };
    measures.push(r);
  }

  let series: string | undefined;
  if (o.series !== undefined && o.series !== null && o.series !== '') {
    const s = resolveColumn(o.series, ds.columns);
    if (!s) return { ok: false, reason: `Unknown split column "${String(o.series)}".` };
    if (s.name === cat.name) return { ok: false, reason: 'The split cannot be the category.' };
    series = s.name;
  }

  const filtersRaw = Array.isArray(o.filters) ? o.filters : [];
  if (filtersRaw.length > MAX_FILTERS) return { ok: false, reason: `At most ${MAX_FILTERS} filters.` };
  const filters: AnswerFilter[] = [];
  for (const f of filtersRaw) {
    const r = resolveFilter(f, ds.columns);
    if (typeof r === 'string') return { ok: false, reason: r };
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
    .filter((m: any) => m && typeof m.column === 'string' && typeof m.aggregation === 'string' && AGG_ALIASES[m.aggregation] === m.aggregation)
    .slice(0, MAX_MEASURES)
    .map((m: any) => (typeof m.metricId === 'string' && UUID_RE.test(m.metricId)
      ? { column: m.column, aggregation: m.aggregation, metricId: m.metricId }
      : { column: m.column, aggregation: m.aggregation }));
  if (!measures.length) return undefined;
  const filters: AnswerFilter[] = [];
  for (const f of Array.isArray(o.filters) ? o.filters.slice(0, MAX_FILTERS) : []) {
    if (!f || typeof f.column !== 'string') continue;
    if (typeof f.period === 'string' && PERIODS.has(f.period)) {
      const yb = Number.isInteger(f.yearsBack) && f.yearsBack > 0 && f.yearsBack <= 20 ? f.yearsBack : 0;
      filters.push(yb ? { column: f.column, period: f.period, yearsBack: yb } : { column: f.column, period: f.period });
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
  return spec;
}

// ── Periods: resolved by the APP against the data's own latest date ──────────

const PERIOD_GRAIN: Record<AnswerPeriod, 'month' | 'quarter' | 'year'> = {
  last_month: 'month', last_quarter: 'quarter', last_year: 'year',
};

/** The latest real date in a column's cells, or null. */
export function latestDate(cells: Cell[]): CivilDate | null {
  let best: CivilDate | null = null;
  for (const c of cells) {
    const d = parseDateCell(c);
    if (!d) continue;
    if (!best || d.y > best.y || (d.y === best.y && (d.m > best.m || (d.m === best.m && d.d > best.d)))) best = d;
  }
  return best;
}

/**
 * A relative period → the bucket it names and its label ("2024-Q4").
 *
 * "Last quarter" is the latest quarter the DATA reaches, not the calendar's:
 * a dataset that ends in December 2024 asked about "last quarter" in 2026 means
 * Q4 2024, and an answer of "no rows" would be pedantically right and useless.
 * `yearsBack` shifts the same period back ("same for last year").
 */
export function resolvePeriod(
  period: AnswerPeriod,
  latest: CivilDate,
  yearsBack = 0,
): { grain: 'month' | 'quarter' | 'year'; bucket: number; label: string } {
  const grain = PERIOD_GRAIN[period];
  const at: CivilDate = { y: latest.y - yearsBack, m: latest.m, d: Math.min(latest.d, 28) };
  const bucket = dateBucket(at, grain);
  return { grain, bucket, label: dateBucketLabel(bucket, grain) };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A period bucket → its first and last day as ISO text. */
export function periodBounds(grain: 'month' | 'quarter' | 'year', bucket: number): { from: string; to: string } {
  const from = dateBucketLabel(bucket, 'day');
  const [y, m] = from.split('-').map(Number);
  const next: CivilDate = grain === 'year' ? { y: y + 1, m: 1, d: 1 }
    : grain === 'quarter' ? { y: m + 3 > 12 ? y + 1 : y, m: ((m + 2) % 12) + 1, d: 1 }
      : { y: m === 12 ? y + 1 : y, m: (m % 12) + 1, d: 1 };
  return { from, to: dateBucketLabel(dateBucket(next, 'day') - 1, 'day') };
}

/**
 * The spec's filters → ordinary FilterSteps over THIS dataset's cells.
 *
 * A period over a column of plain ISO days becomes two bounds. Over any other
 * date text it becomes an `in` list of the column's distinct cells that fall in
 * the period's bucket — not bounds, because a date column is stored and
 * compared as TEXT and only plain ISO days order correctly that way, where the
 * bucket test uses the same parser every date axis in the app groups by.
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
    const ci = columns.findIndex((c) => c.name === f.column);
    if (ci < 0) continue;
    if ('period' in f) {
      const cells = rows.map((r) => (r ? r[ci] ?? null : null));
      const latest = latestDate(cells);
      if (!latest) {
        steps.push({ type: 'filter', column: f.column, op: 'in', values: [] });
        labels.push(`${f.column}: no dates`);
        continue;
      }
      const p = resolvePeriod(f.period, latest, f.yearsBack || 0);
      labels.push(`${f.column}: ${p.label}`);
      // Plain ISO days compare correctly as text, so the period is two bounds —
      // which is also what a user reading the saved chart's filter expects.
      if (cells.every((c) => c === null || c === '' || (typeof c === 'string' && ISO_DAY.test(c)))) {
        const b = periodBounds(p.grain, p.bucket);
        steps.push({ type: 'filter', column: f.column, op: '>=', value: b.from });
        steps.push({ type: 'filter', column: f.column, op: '<=', value: b.to });
        continue;
      }
      const keep = new Set<string>();
      const values: Cell[] = [];
      for (const c of cells) {
        const d = parseDateCell(c);
        if (!d || dateBucket(d, p.grain) !== p.bucket) continue;
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
 *                          back a year, and an all-time answer narrows to the
 *                          data's latest year.
 *   - "Show as table"    — unless it already is one.
 */
export function answerChips(
  spec: AnswerSpec,
  ctx: { columns: ParsedColumn[]; splitCandidates: string[] },
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

  const periodIdx = spec.filters.findIndex((f) => 'period' in f);
  const dateCol = ctx.columns.find((c) => c.type === 'date');
  if (periodIdx >= 0) {
    const f = spec.filters[periodIdx] as Extract<AnswerFilter, { period: AnswerPeriod }>;
    const filters = spec.filters.slice();
    filters[periodIdx] = { column: f.column, period: f.period, yearsBack: (f.yearsBack || 0) + 1 };
    chips.push({ label: 'Same for last year', spec: { ...spec, filters, title: cleanTitle(`${spec.title}, a year earlier`) } });
  } else if (dateCol && dateCol.name !== spec.category) {
    chips.push({
      label: 'Same for last year',
      spec: {
        ...spec,
        filters: spec.filters.concat([{ column: dateCol.name, period: 'last_year' }]),
        title: cleanTitle(`${spec.title}, latest year`),
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
