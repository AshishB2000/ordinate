// The live compiler: IR + dialect + source + declared columns → one statement
// and its bound parameters. PURE — builds strings, queries nothing.
// docs/live-data/00-plan.md L2.2 (D3, D4, D7).
//
// Five statements, each a cheap question the executor (L2.3) asks in order
// (the first only for an empty answer's note, ipc/liveAnswers):
//
//   compileLatestDates  MAX(day) of one date column, under the caller's lock
//   compileBinRange     min/max of a number category (the bin edges)
//   compileGrainProbe   distinct buckets per grain (a date axis with no grain)
//   compileChart        the chart itself — categories, series, measures
//   compileMetric       one number
//
// …and two lookups asked on their own:
//
//   compileCaseMatches  the stored spellings of the text values a question names
//                       (an AI answer asks it before the five above, L2.4)
//   compileKeyCheck     a declared key's rows, empties and repeats ("Check now", spec D2)
//
// THE RULES (copied from the resident layer so live and extract mean the same):
//   - Identifiers come ONLY from the declared schema, quoted per dialect; a name
//     the schema does not declare is refused. Values ONLY as parameters.
//   - Every aggregate is CAST to DOUBLE (FLOAT64, Float64…). `avg` is compiled
//     as sum + count and divided in OUR code (./shape.ts), so "Other", a retail
//     roll-up and a split stay exact: a mean of means is never taken.
//   - A text axis keeps its top 50 and folds the rest into "Other" IN ONE QUERY:
//     group, rank by the first measure, re-aggregate everything ranked past 50.
//   - ORDER IS EXPLICIT. A warehouse has no row order, so live orders dates and
//     bins ascending and text by the first measure (largest first), each ending
//     on the key itself, so every tie is broken and every LIMIT is
//     deterministic. The extract's text order is FIRST-SEEN instead — a
//     deliberate, documented difference (docs/live-data/log.md, L2.2), and so are
//     ties AT a cut (the 50th category, the Nth of a top N): first-seen wins
//     there, the label wins here. A NULL key sorts last.
//   - Bucket ids, not labels, come back: an epoch day, a bin index. Every label
//     is written by `analysis/categoryKey` in ./shape.ts, never by SQL.
//   - A text key folds '' into NULL, as every import stores '' (./compileFilter.ts
//     `keyText`): one blank category, never two rows labelled ''.
//
// Aliases are distinct at every stage (`lv_a…` aggregates, `lv_b…` re-aggregates,
// `o_…` outputs) because ClickHouse resolves an alias before a column of the
// same name — `sum(x) AS x` is a cycle there.

import type { DateGrain } from '../../analysis/categoryKey';
import { CATEGORY_CAP, DATE_GRAINS, OTHER_LABEL } from '../../analysis/categoryKey';
import type { WeekCal } from '../../analysis/retailCalendar';
import type { LiveColumn, LiveColumnMeasure, LiveFilter, LiveIR, LiveMeasure, LiveRefusal } from './liveSpec';
import { LIVE_AGGS, NUMERIC_AGGS, columnOf, isMetricMeasure, isRefusal, refuse } from './liveSpec';
import { refuseLayer } from './semantic/semanticRefusals';
import type { CompileDialectId, SqlDialect } from './dialect';
import { dialectFor } from './dialects';
import type { CompiledQuery } from './sqlParams';
import { ParamSink, hasNul } from './sqlParams';
import type { Ctx } from './compileFilter';
import { dateOf, emptyOf, keyText, nullsLast, numberOf, predicates } from './compileFilter';
import { keyOf } from './profileSql';
import type { Total } from './compileDistinct';
import { distinctKey, foldedDistinct, totalAt, withTotals } from './compileDistinct';
import type { LiveCalc } from '../../data/liveCalcs';
import { calcFrom, namesCalc } from './calcLayers';

export type { CompiledQuery } from './sqlParams';

/** Where a live dataset's rows are: a table (quoted per dialect) or its defining query; and its calculated fields, in every cache key. */
export type LiveSource = ({ kind: 'table'; parts: string[] } | { kind: 'sql'; sql: string }) & { calcs?: LiveCalc[] };

export interface CompileEnv {
  dialect: CompileDialectId | SqlDialect;
  source: LiveSource;
  /** The dataset's DECLARED columns — the only identifiers a statement may name. */
  columns: LiveColumn[];
  /** The dataset's base filters (./liveBase), AND-ed into every statement over its rows. */
  base?: LiveFilter[];
}

/** The category key once its probe has answered: what `compileChart` groups by. */
export type LiveKey =
  | { kind: 'text' }
  | { kind: 'date'; grain: DateGrain }
  /** Grouped by DAY; ./shape.ts rolls days up into the week calendar's buckets. */
  | { kind: 'days'; grain?: DateGrain; weekCal: WeekCal }
  | { kind: 'bins'; lo: number; hi: number; width: number; bins: number };

export type Compiled = { ok: true; query: CompiledQuery } | LiveRefusal;

/** A measure's parts: s = sum, c = count, n = min, x = max, d = a distinct count (never re-aggregated); `avg` is s + c. v = a semantic layer's own value. */
export type Part = 's' | 'c' | 'n' | 'x' | 'd' | 'v';
type ColumnPart = Exclude<Part, 'v'>;

export function partsOf(m: LiveColumnMeasure): ColumnPart[];
export function partsOf(m: LiveMeasure): Part[];
export function partsOf(m: LiveMeasure): Part[] {
  if (isMetricMeasure(m)) return ['v'];
  switch (m.aggregation) {
    case 'sum': return ['s'];
    case 'avg': return ['s', 'c'];
    case 'count': return ['c'];
    case 'min': return ['n'];
    case 'countd': return ['d'];
    default: return ['x'];
  }
}

// ── Preparation: the checks every statement shares ───────────────────────────

interface Prepared {
  c: Ctx;
  from: string;
  /** The base filters `whereOf` ANDs in: none when they already sit innermost, in the calc layers. */
  base: LiveFilter[];
  /** The IR's measures, every one a column's (a layer metric was refused). */
  ms: LiveColumnMeasure[];
}

function badName(name: unknown): boolean {
  return typeof name !== 'string' || name === '' || hasNul(name);
}

/** The source as a FROM item. A defining query sits on its own lines (rule F3). */
function fromItem(d: SqlDialect, src: LiveSource): string | LiveRefusal {
  if (!src || typeof src !== 'object') return refuse('badSource');
  if (src.kind === 'table') {
    if (!Array.isArray(src.parts) || src.parts.length === 0) return refuse('badSource');
    if (src.parts.some(badName)) return refuse('badIdentifier');
    return `${src.parts.map((p) => d.ident(p)).join('.')} AS lv_src`;
  }
  if (src.kind === 'sql' && typeof src.sql === 'string') {
    // A trailing `;` would end the statement inside the parentheses. Only
    // trailing ones go; the query was validated when the dataset was made.
    const sql = src.sql.replace(/[\s;]+$/, '');
    if (sql.trim() === '') return refuse('badSource');
    if (hasNul(sql)) return refuse('badIdentifier');
    return `(\n${sql}\n) AS lv_src`;
  }
  return refuse('badSource');
}

/** Every column the IR names must be declared, and quotable. */
function namesOf(ir: LiveIR): string[] {
  const names: string[] = [];
  if (ir.category) names.push(ir.category.column);
  if (ir.series) names.push(ir.series);
  for (const m of ir.measures || []) if (!isMetricMeasure(m)) names.push(m.column);
  for (const f of ir.filters || []) names.push(f.column);
  return names;
}

function prepare(ir: LiveIR, env: CompileEnv): Prepared | LiveRefusal {
  if (!ir || typeof ir !== 'object' || !Array.isArray(ir.measures) || !Array.isArray(ir.filters)) return refuse('badQuery');
  // A layer's metric has no SQL here: aggregating a table ourselves would go around the layer (part 7, D12).
  const metric = ir.measures.find(isMetricMeasure);
  if (metric) return refuseLayer('metricOnTable', { dataset: '', layer: '', metric: metric.metric });
  const ms = ir.measures as LiveColumnMeasure[];
  const d = dialectFor(env.dialect);
  if (!d) return refuse('badQuery');
  const columns = Array.isArray(env.columns) ? env.columns : [];
  const names = namesOf(ir);
  for (const name of names) {
    if (badName(name)) return refuse('badIdentifier');
    if (!columnOf(columns, name)) return refuse('unknownColumn', name);
  }
  for (const m of ms) {
    if (!LIVE_AGGS.has(m.aggregation)) return refuse('unknownAggregation', String(m.aggregation));
    // THE GATE: a text column is never summed — loud, never a wrong figure.
    if (NUMERIC_AGGS.has(m.aggregation) && columnOf(columns, m.column)!.type !== 'number') return refuse('notNumeric', m.column);
  }
  const c: Ctx = { d, b: new ParamSink(), columns };
  const inner = fromItem(d, env.source);
  // A calc the statement reads: one derived table per calc it needs (./calcLayers), the base filters innermost,
  // before any calc exists. None: today's FROM and WHERE, byte for byte.
  const layered = !isRefusal(inner) && namesCalc(names, env.source);
  const from = layered ? calcFrom(c, env.source, names, inner, env.base) : inner;
  if (isRefusal(from)) return from;
  return { c, from, base: layered ? [] : env.base ?? [], ms };
}

/** The dataset's base filters, then the question's: every statement's WHERE. */
function whereOf(p: Prepared, ir: LiveIR): string | LiveRefusal {
  const preds = predicates(p.c, [...p.base, ...ir.filters]);
  if (isRefusal(preds)) return preds;
  return preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
}

/** The column a measure aggregates: a finite number, for `count` a non-empty flag, for `countd` what it counts. */
function measureInput(c: Ctx, m: LiveColumnMeasure): string {
  const col = columnOf(c.columns, m.column)!;
  if (m.aggregation === 'countd') return distinctKey(c, col);
  if (m.aggregation !== 'count') return numberOf(c, col);
  // `count` counts NON-EMPTY cells of any type (transforms.aggregate).
  return col.type === 'number' ? numberOf(c, col) : `CASE WHEN NOT ${emptyOf(c, col)} THEN 1 END`;
}

const AGG_OF: Record<Exclude<ColumnPart, 'd'>, string> = { s: 'sum', c: 'count', n: 'min', x: 'max' };
/** Re-aggregating a part: counts and sums add, minima and maxima stay minima and maxima. A distinct count never does. */
const REAGG_OF: Record<Exclude<ColumnPart, 'd'>, string> = { s: 'sum', c: 'sum', n: 'min', x: 'max' };

/** A part's aggregate over a measure's input `v`. */
const aggOf = (d: SqlDialect, pt: ColumnPart, v: string): string => (pt === 'd' ? d.countDistinct(v) : `${AGG_OF[pt]}(${v})`);

// ── One number ───────────────────────────────────────────────────────────────

/**
 * `metricValue.computeMetric` as one aggregate with no GROUP BY: over zero rows
 * that is ONE row — count 0, everything else NULL — which is exactly the
 * extract's asymmetric empty contract, with no COALESCE anywhere.
 */
export function compileMetric(ir: LiveIR, env: CompileEnv): Compiled {
  const p = prepare(ir, env);
  if (isRefusal(p)) return p;
  if (p.ms.length !== 1) return refuse('badQuery');
  const m = p.ms[0];
  const v = measureInput(p.c, m);
  const sel: string[] = [];
  const cols: string[] = [];
  for (const part of partsOf(m)) {
    sel.push(`${p.c.d.toDouble(aggOf(p.c.d, part, v))} AS o_m0${part}`);
    cols.push(`o_m0${part}`);
  }
  const where = whereOf(p, ir);
  if (isRefusal(where)) return where;
  return { ok: true, query: p.c.b.finish(`SELECT ${sel.join(', ')} FROM ${p.from}${where}`, p.c.d, cols) };
}

// ── The probes ───────────────────────────────────────────────────────────────

/**
 * The latest day of one date column, as an epoch day: what an empty answer's note says the data ends on
 * (ipc/liveAnswers). Over every row a copy would hold, not the question's: `answerSpec.latestDate` reads every
 * cell of the column. Only a row lock (`lock`, row-policy D13) and the dataset's base filters narrow it.
 */
export function compileLatestDates(column: string, env: CompileEnv, lock: LiveFilter[] = []): Compiled {
  const probe: LiveIR = { kind: 'metric', category: { column, kind: 'date' }, measures: [], filters: lock, order: 'natural', weekCal: null }; // the column read, for its name checks and a calc's layer
  const p = prepare(probe, env);
  if (isRefusal(p)) return p;
  const where = whereOf(p, probe);
  if (isRefusal(where)) return where;
  const col = columnOf(p.c.columns, column)!;
  if (col.type !== 'date') return refuse('periodNotDate', col.name);
  return { ok: true, query: p.c.b.finish(`SELECT ${p.c.d.epochDay(`max(${dateOf(p.c, col)})`)} AS o_l0 FROM ${p.from}${where}`, p.c.d, ['o_l0']) };
}

/** min/max of the FILTERED numeric category cells → `categoryKey.binPlan`. */
export function compileBinRange(ir: LiveIR, env: CompileEnv): Compiled {
  const p = prepare(ir, env);
  if (isRefusal(p)) return p;
  const cat = ir.category;
  if (!cat || cat.kind !== 'bins') return refuse('badQuery');
  const col = columnOf(p.c.columns, cat.column)!;
  if (col.type !== 'number') return refuse('categoryType', col.name);
  const n = numberOf(p.c, col);
  const where = whereOf(p, ir);
  if (isRefusal(where)) return where;
  const sql = `SELECT ${p.c.d.toDouble(`min(${n})`)} AS o_lo, ${p.c.d.toDouble(`max(${n})`)} AS o_hi FROM ${p.from}${where}`;
  return { ok: true, query: p.c.b.finish(sql, p.c.d, ['o_lo', 'o_hi']) };
}

/** Distinct buckets per grain over the FILTERED dates → `categoryKey.chooseGrain`. */
export function compileGrainProbe(ir: LiveIR, env: CompileEnv): Compiled {
  const p = prepare(ir, env);
  if (isRefusal(p)) return p;
  const cat = ir.category;
  if (!cat || cat.kind !== 'date') return refuse('badQuery');
  const col = columnOf(p.c.columns, cat.column)!;
  if (col.type !== 'date') return refuse('categoryType', col.name);
  const dt = dateOf(p.c, col);
  // count(DISTINCT …) skips NULL, as the extract counts only the dates it parsed.
  const sel = DATE_GRAINS.map((g) => `${p.c.d.toDouble(`count(DISTINCT ${g === 'day' ? dt : p.c.d.trunc(dt, g)})`)} AS o_${g}`);
  const where = whereOf(p, ir);
  if (isRefusal(where)) return where;
  return { ok: true, query: p.c.b.finish(`SELECT ${sel.join(', ')} FROM ${p.from}${where}`, p.c.d, DATE_GRAINS.map((g) => `o_${g}`)) };
}

// ── The chart ────────────────────────────────────────────────────────────────

/** The group key over the source: text, an epoch-day bucket, or a bin index. */
function keyExpr(c: Ctx, col: LiveColumn, key: LiveKey): string | LiveRefusal {
  if (key.kind === 'text') {
    if (col.type !== 'text') return refuse('categoryType', col.name);
    return keyText(c, col);
  }
  if (key.kind === 'bins') {
    if (col.type !== 'number') return refuse('categoryType', col.name);
    const n = numberOf(c, col);
    // `categoryKey.binIndex` on the same two bound doubles: subtract, divide,
    // floor — no reassociation, so bit-identical. NULL stays NULL explicitly
    // (some engines' greatest/least ignore a NULL argument).
    const lo = c.b.bind('number', key.lo);
    const width = c.b.bind('number', key.width);
    return `CASE WHEN ${n} IS NULL THEN NULL ELSE ${c.d.toInt(`greatest(least(floor((${n} - ${lo}) / ${width}), ${key.bins - 1}), 0)`)} END`;
  }
  if (col.type !== 'date') return refuse('categoryType', col.name);
  const dt = dateOf(c, col);
  if (key.kind === 'days' || key.grain === 'day') return c.d.epochDay(dt);
  return c.d.epochDay(c.d.trunc(dt, key.grain));
}

/** The first measure's value over a window — the rank a category or a series is ordered by. */
function totalOver(c: Ctx, m: LiveColumnMeasure, name: (p: ColumnPart) => string, partition: string): string {
  const w = `OVER (PARTITION BY ${partition})`;
  const d = c.d;
  switch (m.aggregation) {
    case 'sum': return d.toDouble(`sum(${name('s')}) ${w}`);
    case 'count': return d.toDouble(`sum(${name('c')}) ${w}`);
    case 'min': return d.toDouble(`min(${name('n')}) ${w}`);
    case 'max': return d.toDouble(`max(${name('x')}) ${w}`);
    // A partition of ONE group (no split): its distinct count is its total. A split's is counted again (./compileDistinct.ts).
    case 'countd': return d.toDouble(`max(${name('d')}) ${w}`);
    default:
      return `CASE WHEN sum(${name('c')}) ${w} > 0 THEN ${d.toDouble(`sum(${name('s')}) ${w}`)} / ${d.toDouble(`sum(${name('c')}) ${w}`)} END`;
  }
}

/** Value order: largest first, an empty value last, then the key, NULL last. */
function byValue(total: string, key: string): string {
  return `${nullsLast(total)}, ${total} DESC, ${nullsLast(key)}, ${key}`;
}

function byKey(key: string): string {
  return `${nullsLast(key)}, ${key}`;
}

/**
 * The chart statement. One row per (category, series) group, already in display
 * order, carrying the measure parts, the category's rank (`o_cr`), the series'
 * rank (`o_sr`) and — for a text axis — how many categories there were before
 * the fold (`o_nc`), which is what decides the "Other" note.
 */
export function compileChart(ir: LiveIR, key: LiveKey, env: CompileEnv): Compiled {
  const p = prepare(ir, env);
  if (isRefusal(p)) return p;
  const c = p.c;
  const d = c.d;
  if (ir.kind !== 'chart' || !ir.category || ir.measures.length === 0) return refuse('badQuery');
  const catCol = columnOf(c.columns, ir.category.column)!;
  const dated = key.kind === 'date' || key.kind === 'days';
  if (dated && (ir.order === 'value' || ir.top !== undefined)) return refuse('rankOnDate');
  if (ir.top !== undefined && (!Number.isInteger(ir.top) || ir.top < 1 || ir.order !== 'value')) return refuse('badQuery');
  // Days roll up into a week calendar's periods in ./shape.ts, which no distinct count survives (part 5, D2).
  if (key.kind === 'days' && p.ms.some((m) => m.aggregation === 'countd')) return refuse('distinctByWeekCalendar');

  const g = keyExpr(c, catCol, key);
  if (isRefusal(g)) return g;
  let s: string | null = null;
  let seriesText = false;
  if (ir.series) {
    const sc = columnOf(c.columns, ir.series)!;
    if (sc.type === 'date') return refuse('dateSeries', sc.name);
    seriesText = sc.type === 'text';
    if (seriesText) {
      s = keyText(c, sc);
    } else {
      // −0 and 0 are ONE series, as they are one stored value in an extract
      // (String(-0) is '0'); a warehouse may group them apart.
      const n = numberOf(c, sc);
      s = `CASE WHEN ${n} = 0 THEN ${d.toDouble('0')} ELSE ${n} END`;
    }
  }
  const where = whereOf(p, ir);
  if (isRefusal(where)) return where;

  const ms = p.ms;
  const m0 = ms[0];
  const gs = s ? 'lv_g, lv_s' : 'lv_g';
  const base = [`${g} AS lv_g`];
  if (s) base.push(`${s} AS lv_s`);
  ms.forEach((m, i) => base.push(`${measureInput(c, m)} AS lv_v${i}`));
  const grp = ms.flatMap((m, i) => partsOf(m).map((pt) => `${d.toDouble(aggOf(d, pt, `lv_v${i}`))} AS lv_a${i}${pt}`));
  const ctes = [
    `lv_base AS (SELECT ${base.join(', ')} FROM ${p.from}${where})`,
    `lv_grp AS (SELECT ${gs}, ${grp.join(', ')} FROM lv_base GROUP BY ${gs})`,
  ];

  // The 50-plus-"Other" fold — a text axis only, ranked on the category total
  // of the first measure exactly as `vizData.capText` ranks it.
  let last = 'lv_grp';
  let k = 'lv_g';
  let part = (i: number, pt: ColumnPart): string => `lv_a${i}${pt}`;
  const text = key.kind === 'text';
  // A distinct count is counted again from rows wherever this statement folds or ranks (./compileDistinct.ts).
  const distinct = ms.some((m) => m.aggregation === 'countd');
  const again = !!s && m0.aggregation === 'countd';
  if (text) {
    const keep = c.b.bind('text', OTHER_LABEL);
    const t = totalAt(c, again, totalOver(c, m0, (pt) => `lv_a0${pt}`, 'lv_g'), { rel: 'lv_grp', relKey: 'lv_g', text, name: 'lv_dct', from: 'lv_base', by: 'lv_g' });
    const reagg = ms.flatMap((m, i) => partsOf(m).flatMap((pt) => (pt === 'd' ? [] : [`${d.toDouble(`${REAGG_OF[pt]}(lv_a${i}${pt})`)} AS lv_b${i}${pt}`])));
    ctes.push(
      ...t.ctes,
      `lv_tot AS (${withTotals('lv_grp', [[t, 'lv_ct']])})`,
      `lv_rank AS (SELECT *, dense_rank() OVER (ORDER BY ${byValue('lv_ct', 'lv_g')}) AS lv_cr FROM lv_tot)`,
      `lv_fold AS (SELECT CASE WHEN lv_cr <= ${CATEGORY_CAP} THEN lv_g ELSE ${keep} END AS lv_k${s ? ', lv_s' : ''}${distinct ? ', lv_g' : ''}, ` +
        `${ms.flatMap((m, i) => partsOf(m).map((pt) => `lv_a${i}${pt}`)).join(', ')}, max(lv_cr) OVER () AS lv_n FROM lv_rank)`,
      `lv_out AS (SELECT ${[`lv_k${s ? ', lv_s' : ''}`, ...reagg, `${d.toDouble('max(lv_n)')} AS lv_nc`].join(', ')} FROM lv_fold GROUP BY lv_k${s ? ', lv_s' : ''})`,
      ...(distinct ? foldedDistinct(c, ms, !!s, seriesText) : []),
    );
    last = distinct ? 'lv_outd' : 'lv_out';
    k = 'lv_k';
    part = (i, pt) => `lv_b${i}${pt}`;
  }

  // Display order: the category rank, then the series rank.
  const valueOrdered = text || ir.order === 'value';
  const fin: [Total, string][] = [];
  if (valueOrdered) fin.push([totalAt(c, again, totalOver(c, m0, (pt) => part(0, pt), k), { rel: last, relKey: k, text, name: 'lv_dct2', from: text ? 'lv_bk' : 'lv_base', by: text ? 'lv_kk' : 'lv_g' }), 'lv_ct2']);
  if (s && seriesText) fin.push([totalAt(c, again, totalOver(c, m0, (pt) => part(0, pt), 'lv_s'), { rel: last, relKey: 'lv_s', text: true, name: 'lv_dst', from: 'lv_base', by: 'lv_s' }), 'lv_st']);
  if (fin.length) {
    ctes.push(...fin.flatMap(([t]) => t.ctes), `lv_fin AS (${withTotals(last, fin)})`);
    last = 'lv_fin';
  }
  const ranks = [`${d.toInt(`dense_rank() OVER (ORDER BY ${valueOrdered ? byValue('lv_ct2', k) : byKey(k)})`)} AS lv_cr2`];
  if (s) ranks.push(`${d.toInt(`dense_rank() OVER (ORDER BY ${seriesText ? byValue('lv_st', 'lv_s') : byKey('lv_s')})`)} AS lv_sr`);
  ctes.push(`lv_ord AS (SELECT *, ${ranks.join(', ')} FROM ${last})`);

  const out: string[] = [`${text ? d.label(k) : k} AS o_g`];
  const cols = ['o_g'];
  if (s) {
    out.push(`${seriesText ? d.label('lv_s') : 'lv_s'} AS o_s`);
    cols.push('o_s');
  }
  ms.forEach((m, i) => partsOf(m).forEach((pt) => {
    out.push(`${part(i, pt)} AS o_m${i}${pt}`);
    cols.push(`o_m${i}${pt}`);
  }));
  out.push('lv_cr2 AS o_cr');
  cols.push('o_cr');
  if (s) {
    out.push('lv_sr AS o_sr');
    cols.push('o_sr');
  }
  if (text) {
    out.push('lv_nc AS o_nc');
    cols.push('o_nc');
  }
  // The top-N cut. Even a validated integer travels as a parameter (D4). With a
  // split the cut is made in ./shape.ts instead: the extract keeps EVERY series
  // of the full chart (`answers.ranked` slices values, not series), so a series
  // with no value in the top N must still come back to be named.
  const top = ir.top !== undefined && !s ? ` WHERE lv_cr2 <= ${c.b.bind('number', ir.top)}` : '';
  const sql = `WITH ${ctes.join(',\n')}\nSELECT ${out.join(', ')} FROM lv_ord${top} ORDER BY lv_cr2${s ? ', lv_sr' : ''}`;
  return { ok: true, query: c.b.finish(sql, d, cols) };
}

// ── The answers' case fix (L2.4) ─────────────────────────────────────────────

/**
 * How many stored spellings a case-fix lookup reads back PER ASKED VALUE (plan
 * L2.4's LIMIT 20): one value asked is `LIMIT 20`, and an `in` of 25 values is
 * never cut short at 20 — a value left unfixed would silently drop its category.
 */
export const CASE_FIX_LIMIT = 20;

/**
 * The stored spellings of asked text values — `answers.canonicaliseTextFilters`
 * as one statement: `SELECT DISTINCT col … WHERE key(col) IN (…)`, where
 * `key` is `trim().toLowerCase()` on both sides (the asked keys arrive keyed,
 * each a bound parameter). Over ALL rows, as the extract reads every row.
 * Ordered by the value so the LIMIT is deterministic: where two spellings share
 * a key ("West" and "WEST") the extract keeps the first SEEN and live the first
 * in the warehouse's order — a named divergence (docs/live-data/log.md, L2.4).
 * Bounded at CASE_FIX_LIMIT rows per distinct key.
 */
export function compileCaseMatches(column: string, keys: string[], env: CompileEnv, lock: LiveFilter[] = []): Compiled {
  // `lock`: a row access lock (row-policy D13) — the stored spellings come from the caller's rows only.
  const probe: LiveIR = { kind: 'chart', category: { column, kind: 'text' }, measures: [], filters: lock, order: 'natural', weekCal: null };
  const p = prepare(probe, env);
  if (isRefusal(p)) return p;
  const col = columnOf(p.c.columns, column)!;
  if (col.type !== 'text') return refuse('categoryType', col.name);
  if (!Array.isArray(keys) || keys.length === 0 || keys.some((k) => typeof k !== 'string')) return refuse('badQuery');
  const c = p.c;
  // The GROUP key's text (L2.8's fold): an import stores '' as null, so '' is
  // never a stored spelling of a copy — nor, folded to NULL, of the warehouse.
  const v = keyText(c, col);
  const distinct = [...new Set(keys)];
  const asked = distinct.map((k) => c.b.bind('text', k)).join(', ');
  const locked = whereOf(p, probe);
  if (isRefusal(locked)) return locked;
  const sql = `SELECT DISTINCT ${c.d.label(v)} AS o_v FROM ${p.from} WHERE ${c.d.caseKey(v, c.b)} IN (${asked})${locked ? ` AND ${locked.slice(' WHERE '.length)}` : ''} ORDER BY o_v LIMIT ${CASE_FIX_LIMIT * distinct.length}`;
  return { ok: true, query: c.b.finish(sql, c.d, ['o_v']) };
}

// ── The key check (spec D2) ──────────────────────────────────────────────────

/**
 * The key check as one statement: a declared key's rows, empty rows and repeated keys —
 * `analysis/keyCheck.keyCheckJs` on the warehouse. The key is the profile's: NULL when empty
 * (`emptyOf`), else a number's finite value or the cell's text. The key is computed in a
 * derived table and grouped by its alias, because a bound value in the expression would not
 * match its twin in a `GROUP BY` (each marker becomes its own parameter). The three counts
 * are `SUM`s, NULL over no rows; `keyCheckFromRow` reads that as 0.
 */
export function compileKeyCheck(column: string, env: CompileEnv): Compiled {
  const probe: LiveIR = { kind: 'chart', category: { column, kind: 'text' }, measures: [], filters: [], order: 'natural', weekCal: null };
  const p = prepare(probe, env);
  if (isRefusal(p)) return p;
  const { c } = p;
  const col = columnOf(c.columns, column)!;
  // The dataset's base filters (D13): the key is counted over the rows the dataset holds, never more.
  const where = whereOf(p, probe);
  if (isRefusal(where)) return where;
  const sql =
    `SELECT ${c.d.toDouble('SUM(lv_n)')} AS k_rows, ` +
    `${c.d.toDouble('SUM(CASE WHEN lv_k IS NULL THEN lv_n ELSE 0 END)')} AS k_empty, ` +
    `${c.d.toDouble('SUM(CASE WHEN lv_k IS NOT NULL AND lv_n > 1 THEN 1 ELSE 0 END)')} AS k_repeated ` +
    `FROM (SELECT lv_k, COUNT(*) AS lv_n FROM (SELECT ${keyOf(c, col)} AS lv_k FROM ${p.from}${where}) lv_s GROUP BY lv_k) lv_g`;
  return { ok: true, query: c.b.finish(sql, c.d, ['k_rows', 'k_empty', 'k_repeated']) };
}
