// The live compiler: IR + dialect + source + declared columns → one statement
// and its bound parameters. PURE — builds strings, queries nothing.
// docs/live-data/00-plan.md L2.2 (D3, D4, D7).
//
// Five statements, each a cheap question the executor (L2.3) asks in order:
//
//   compileLatestDates  MAX(day) per column a data-relative period reads
//   compileBinRange     min/max of a number category (the bin edges)
//   compileGrainProbe   distinct buckets per grain (a date axis with no grain)
//   compileChart        the chart itself — categories, series, measures
//   compileMetric       one number
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
//
// Aliases are distinct at every stage (`lv_a…` aggregates, `lv_b…` re-aggregates,
// `o_…` outputs) because ClickHouse resolves an alias before a column of the
// same name — `sum(x) AS x` is a cycle there.

import type { DateGrain } from '../../analysis/categoryKey';
import { CATEGORY_CAP, DATE_GRAINS, OTHER_LABEL } from '../../analysis/categoryKey';
import type { WeekCal } from '../../analysis/retailCalendar';
import type { LiveColumn, LiveIR, LiveMeasure, LiveRefusal } from './liveSpec';
import { LIVE_AGGS, NUMERIC_AGGS, columnOf, isRefusal, refuse } from './liveSpec';
import type { CompileDialectId, SqlDialect } from './dialect';
import { dialectFor } from './dialects';
import type { CompiledQuery } from './sqlParams';
import { ParamSink, hasNul } from './sqlParams';
import type { Ctx } from './compileFilter';
import { dateOf, emptyOf, nullsLast, numberOf, predicate, textOf } from './compileFilter';

export type { CompiledQuery } from './sqlParams';

/** Where a live dataset's rows are: a table (quoted per dialect) or its defining query. */
export type LiveSource = { kind: 'table'; parts: string[] } | { kind: 'sql'; sql: string };

export interface CompileEnv {
  dialect: CompileDialectId | SqlDialect;
  source: LiveSource;
  /** The dataset's DECLARED columns — the only identifiers a statement may name. */
  columns: LiveColumn[];
}

/** The category key once its probe has answered: what `compileChart` groups by. */
export type LiveKey =
  | { kind: 'text' }
  | { kind: 'date'; grain: DateGrain }
  /** Grouped by DAY; ./shape.ts rolls days up into the week calendar's buckets. */
  | { kind: 'days'; grain?: DateGrain; weekCal: WeekCal }
  | { kind: 'bins'; lo: number; hi: number; width: number; bins: number };

export type Compiled = { ok: true; query: CompiledQuery } | LiveRefusal;

/** A measure's parts: s = sum, c = count, n = min, x = max. `avg` is s + c. */
export type Part = 's' | 'c' | 'n' | 'x';

export function partsOf(m: LiveMeasure): Part[] {
  switch (m.aggregation) {
    case 'sum': return ['s'];
    case 'avg': return ['s', 'c'];
    case 'count': return ['c'];
    case 'min': return ['n'];
    default: return ['x'];
  }
}

// ── Preparation: the checks every statement shares ───────────────────────────

interface Prepared {
  c: Ctx;
  from: string;
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
  for (const m of ir.measures || []) names.push(m.column);
  for (const f of ir.filters || []) names.push(f.column);
  return names;
}

function prepare(ir: LiveIR, env: CompileEnv): Prepared | LiveRefusal {
  if (!ir || typeof ir !== 'object' || !Array.isArray(ir.measures) || !Array.isArray(ir.filters)) return refuse('badQuery');
  const d = dialectFor(env.dialect);
  if (!d) return refuse('badQuery');
  const columns = Array.isArray(env.columns) ? env.columns : [];
  for (const name of namesOf(ir)) {
    if (badName(name)) return refuse('badIdentifier');
    if (!columnOf(columns, name)) return refuse('unknownColumn', name);
  }
  for (const m of ir.measures) {
    if (!LIVE_AGGS.has(m.aggregation)) return refuse('unknownAggregation', String(m.aggregation));
    // THE GATE: a text column is never summed — loud, never a wrong figure.
    if (NUMERIC_AGGS.has(m.aggregation) && columnOf(columns, m.column)!.type !== 'number') return refuse('notNumeric', m.column);
  }
  const from = fromItem(d, env.source);
  if (isRefusal(from)) return from;
  return { c: { d, b: new ParamSink(), columns }, from };
}

function whereOf(p: Prepared, ir: LiveIR): string | LiveRefusal {
  const preds: string[] = [];
  for (const f of ir.filters) {
    const s = predicate(p.c, f);
    if (isRefusal(s)) return s;
    preds.push(s);
  }
  return preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
}

/** The column a measure aggregates: a finite number, or for `count` a non-empty flag. */
function measureInput(c: Ctx, m: LiveMeasure): string {
  const col = columnOf(c.columns, m.column)!;
  if (m.aggregation !== 'count') return numberOf(c, col);
  // `count` counts NON-EMPTY cells of any type (transforms.aggregate).
  return col.type === 'number' ? numberOf(c, col) : `CASE WHEN NOT ${emptyOf(c, col)} THEN 1 END`;
}

const AGG_OF: Record<Part, string> = { s: 'sum', c: 'count', n: 'min', x: 'max' };
/** Re-aggregating a part: counts and sums add, minima and maxima stay minima and maxima. */
const REAGG_OF: Record<Part, string> = { s: 'sum', c: 'sum', n: 'min', x: 'max' };

// ── One number ───────────────────────────────────────────────────────────────

/**
 * `metricValue.computeMetric` as one aggregate with no GROUP BY: over zero rows
 * that is ONE row — count 0, everything else NULL — which is exactly the
 * extract's asymmetric empty contract, with no COALESCE anywhere.
 */
export function compileMetric(ir: LiveIR, env: CompileEnv): Compiled {
  const p = prepare(ir, env);
  if (isRefusal(p)) return p;
  if (ir.measures.length !== 1) return refuse('badQuery');
  const m = ir.measures[0];
  const v = measureInput(p.c, m);
  const sel: string[] = [];
  const cols: string[] = [];
  for (const part of partsOf(m)) {
    sel.push(`${p.c.d.toDouble(`${AGG_OF[part]}(${v})`)} AS o_m0${part}`);
    cols.push(`o_m0${part}`);
  }
  const where = whereOf(p, ir);
  if (isRefusal(where)) return where;
  return { ok: true, query: p.c.b.finish(`SELECT ${sel.join(', ')} FROM ${p.from}${where}`, p.c.d, cols) };
}

// ── The probes ───────────────────────────────────────────────────────────────

/** The distinct columns the IR's data-relative periods read, in IR order. */
export function latestColumns(ir: LiveIR): string[] {
  const out: string[] = [];
  for (const f of ir.filters || []) if (f.kind === 'latest' && !out.includes(f.column)) out.push(f.column);
  return out;
}

/**
 * The latest day per period column, as an epoch day. Over ALL rows, no WHERE:
 * `answerSpec.latestDate` reads every cell of the column, not the filtered ones.
 */
export function compileLatestDates(ir: LiveIR, env: CompileEnv): Compiled {
  const p = prepare({ ...ir, filters: [] }, env);
  if (isRefusal(p)) return p;
  const names = latestColumns(ir);
  if (names.length === 0) return refuse('badQuery');
  const sel: string[] = [];
  const cols: string[] = [];
  for (let i = 0; i < names.length; i += 1) {
    if (badName(names[i])) return refuse('badIdentifier');
    const col = columnOf(p.c.columns, names[i]);
    if (!col) return refuse('unknownColumn', names[i]);
    if (col.type !== 'date') return refuse('periodNotDate', col.name);
    sel.push(`${p.c.d.epochDay(`max(${dateOf(p.c, col)})`)} AS o_l${i}`);
    cols.push(`o_l${i}`);
  }
  return { ok: true, query: p.c.b.finish(`SELECT ${sel.join(', ')} FROM ${p.from}`, p.c.d, cols) };
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
    return textOf(c, col);
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
function totalOver(c: Ctx, m: LiveMeasure, name: (p: Part) => string, partition: string): string {
  const w = `OVER (PARTITION BY ${partition})`;
  const d = c.d;
  switch (m.aggregation) {
    case 'sum': return d.toDouble(`sum(${name('s')}) ${w}`);
    case 'count': return d.toDouble(`sum(${name('c')}) ${w}`);
    case 'min': return d.toDouble(`min(${name('n')}) ${w}`);
    case 'max': return d.toDouble(`max(${name('x')}) ${w}`);
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

  const g = keyExpr(c, catCol, key);
  if (isRefusal(g)) return g;
  let s: string | null = null;
  let seriesText = false;
  if (ir.series) {
    const sc = columnOf(c.columns, ir.series)!;
    if (sc.type === 'date') return refuse('dateSeries', sc.name);
    seriesText = sc.type === 'text';
    if (seriesText) {
      s = textOf(c, sc);
    } else {
      // −0 and 0 are ONE series, as they are one stored value in an extract
      // (String(-0) is '0'); a warehouse may group them apart.
      const n = numberOf(c, sc);
      s = `CASE WHEN ${n} = 0 THEN ${d.toDouble('0')} ELSE ${n} END`;
    }
  }
  const where = whereOf(p, ir);
  if (isRefusal(where)) return where;

  const ms = ir.measures;
  const m0 = ms[0];
  const gs = s ? 'lv_g, lv_s' : 'lv_g';
  const base = [`${g} AS lv_g`];
  if (s) base.push(`${s} AS lv_s`);
  ms.forEach((m, i) => base.push(`${measureInput(c, m)} AS lv_v${i}`));
  const grp = ms.flatMap((m, i) => partsOf(m).map((pt) => `${d.toDouble(`${AGG_OF[pt]}(lv_v${i})`)} AS lv_a${i}${pt}`));
  const ctes = [
    `lv_base AS (SELECT ${base.join(', ')} FROM ${p.from}${where})`,
    `lv_grp AS (SELECT ${gs}, ${grp.join(', ')} FROM lv_base GROUP BY ${gs})`,
  ];

  // The 50-plus-"Other" fold — a text axis only, ranked on the category total
  // of the first measure exactly as `vizData.capText` ranks it.
  let last = 'lv_grp';
  let k = 'lv_g';
  let part = (i: number, pt: Part): string => `lv_a${i}${pt}`;
  const text = key.kind === 'text';
  if (text) {
    const keep = c.b.bind('text', OTHER_LABEL);
    ctes.push(
      `lv_tot AS (SELECT *, ${totalOver(c, m0, (pt) => `lv_a0${pt}`, 'lv_g')} AS lv_ct FROM lv_grp)`,
      `lv_rank AS (SELECT *, dense_rank() OVER (ORDER BY ${byValue('lv_ct', 'lv_g')}) AS lv_cr FROM lv_tot)`,
      `lv_fold AS (SELECT CASE WHEN lv_cr <= ${CATEGORY_CAP} THEN lv_g ELSE ${keep} END AS lv_k${s ? ', lv_s' : ''}, ` +
        `${ms.flatMap((m, i) => partsOf(m).map((pt) => `lv_a${i}${pt}`)).join(', ')}, max(lv_cr) OVER () AS lv_n FROM lv_rank)`,
      `lv_out AS (SELECT lv_k${s ? ', lv_s' : ''}, ` +
        `${ms.flatMap((m, i) => partsOf(m).map((pt) => `${d.toDouble(`${REAGG_OF[pt]}(lv_a${i}${pt})`)} AS lv_b${i}${pt}`)).join(', ')}, ` +
        `${d.toDouble('max(lv_n)')} AS lv_nc FROM lv_fold GROUP BY lv_k${s ? ', lv_s' : ''})`,
    );
    last = 'lv_out';
    k = 'lv_k';
    part = (i, pt) => `lv_b${i}${pt}`;
  }

  // Display order: the category rank, then the series rank.
  const valueOrdered = text || ir.order === 'value';
  const fin: string[] = [];
  if (valueOrdered) fin.push(`${totalOver(c, m0, (pt) => part(0, pt), k)} AS lv_ct2`);
  if (s && seriesText) fin.push(`${totalOver(c, m0, (pt) => part(0, pt), 'lv_s')} AS lv_st`);
  if (fin.length) {
    ctes.push(`lv_fin AS (SELECT *, ${fin.join(', ')} FROM ${last})`);
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
