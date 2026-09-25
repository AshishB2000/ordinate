'use strict';

// residentQuery — compute answers DIRECTLY against a dataset's Parquet file.
// MAIN PROCESS ONLY. Never throws: every entry point returns `null` when the
// bridge is down or the query fails, and the caller keeps its working JS path.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// Phase 1 measured the killer: loading 100k rows INTO DuckDB costs ~1,914 ms
// while the GROUP BY itself costs 4 ms. Phase 2 moved the table to Parquet on
// disk but the payoff never landed, because `datasets.getDataset` still hydrates
// the whole file into `Cell[][]` and every consumer still takes `(columns,
// rows)` (docs/phase-2/README.md §6). `parquetStore.relationSql()` was built for
// exactly this and nothing called it.
//
// This module calls it. There is NO materialisation step: the Parquet file IS
// the relation, and the only thing that crosses the bridge is the answer — one
// scalar for a metric, one row per group for an aggregate.
//
// ── What it must reproduce, exactly ──────────────────────────────────────────
// `computeMetricResident` ≡ `metricValue.computeMetric` and `aggregateResident`
// ≡ the aggregated branch of `vizData.buildVizData`, both read off the SAME
// Parquet file via `parquetStore.readTable`. That equivalence is the whole
// point, and `scripts/test-residentQuery.ts` asserts it differentially rather
// than against hand-written numbers.
//
// The four non-negotiable DuckDB divergences (docs/phase-0/04 §5, 06 §4):
//   1. `count` counts NON-EMPTY cells. Bare `count(col)` over-counts, because
//      `''` and whitespace-only are cells to SQL and empty to us. → an explicit
//      `count(*) FILTER (WHERE NOT sqlEmpty(c))`, sharing `sqlGen.sqlEmpty` so
//      there is one definition of "empty" in the codebase.
//   2. sum/avg/min/max of an all-empty column is `null`, and MUST NOT be
//      COALESCE'd to 0. SQL already agrees; the failure mode is an over-
//      defensive implementer "fixing" it. There is deliberately no COALESCE in
//      this file.
//   3. Aggregating a column whose DECLARED type is not `number` yields `null`,
//      not a binder error and — far worse — not an implicit VARCHAR→DOUBLE cast
//      that turns `'007'` into 7. The gate is in TS, on `column.type`, before
//      any SQL is generated. `TRY_CAST` is used only to READ a column already
//      declared numeric, NEVER to decide whether it is one.
//   4. Every aggregate is wrapped in `CAST(… AS DOUBLE)`. `sum(INTEGER)` is
//      HUGEINT in DuckDB, which the bridge hands to JS as a decimal STRING.
//
// ── The category key ─────────────────────────────────────────────────────────
// A Category on a high-cardinality column draws thousands of unreadable marks,
// so `vizData` bins a number column into ten buckets, rolls a date column up to
// a grain and caps a text column at its top 50. `resolveCatKey` reproduces
// those decisions with pre-queries over the SAME relation and the SAME WHERE as
// the aggregate that follows, and `residentCategory` spells the resulting key
// in SQL. SQL returns a bucket ID; `analysis/categoryKey` writes every label,
// on both paths. A date column carrying anything but the two canonical shapes
// is declined outright — SQL has no `Date.parse`, and a half-implemented
// grammar would bucket the leftovers differently from the reference.
//
// ── The ordinal ──────────────────────────────────────────────────────────────
// `transforms.stepGroupAggregate` emits groups in FIRST-SEEN row order. A bare
// `GROUP BY` does not: measured on this repo's own 60k fixture, DuckDB returns
// `g10, g21, g70, g76, g147…` — stable per run, but not row order, and phase-0
// §3 proved it can also move across runs.
//
// The ordinal used here is `read_parquet(…, file_row_number=true)`, which
// surfaces the row's index WITHIN THE FILE. It is a physical property of the
// stored data, so unlike `row_number() OVER ()` it does not depend on the order
// rows happen to reach a window operator under parallel scan. `ORDER BY
// min(file_row_number)` then reproduces first-seen order exactly. Both were
// measured stable over 60k across repeated runs; `file_row_number` is chosen
// because it is stable BY CONSTRUCTION rather than by observation.
// `row_number() OVER ()` is kept as an automatic fallback for a DuckDB build
// that does not support the option — see `ordinalMode`.
//
// ── What could NOT be reproduced ─────────────────────────────────────────────
// FLOAT SUMMATION ORDER. `metricValue`/`transforms` sum with a JS left-fold in
// row order; DuckDB sums in vectorised, parallel chunks and combines partial
// sums. Measured on 200,000 pseudo-random doubles: JS 99080170.3834587335587,
// DuckDB 99080170.3834598213434 — a ~49 ULP difference, reproducible run to
// run. Integer-valued data (which is every fixture in this repo, and most real
// dashboard data) is exact. This is inherent to parallel summation and cannot be
// fixed in SQL; it is documented, tested for its magnitude, and reported.
// `avg` is emitted as `sum(x)/count(x)` rather than `avg(x)` because that is
// literally the JS formula — measured `avg(x)` = 0.4 where JS and `sum/count`
// both give 0.39999999999999997.
//
// STRING COLLATION on an ORDERING filter (`<`, `>`, `<=`, `>=`) over a text
// column. JS compares UTF-16 CODE UNITS; DuckDB compares UTF-8 BYTES. They
// agree for everything in the BMP but invert for astral-plane characters:
// measured, `'\u{10000}' > '�'` is FALSE in JS (its lead surrogate D800 <
// FFFD) and TRUE in DuckDB (F0 90 80 80 > EF BF BD). `=`, `!=` and `contains`
// are byte-for-byte equivalent and unaffected, as is every numeric comparison.
// This is inherited verbatim from `sqlGen.ts`, which builds the same expression;
// fixing it would mean re-encoding both sides to UTF-16 in SQL on every row,
// which costs far more than the case is worth. Pinned by a test so it stays
// visible rather than being discovered by a user.

import type { ColumnType, ParsedColumn } from '../data/parse';
import { coerceValue } from '../data/parse';
import type { Cell, FilterStep } from '../data/transforms';
import type { FilterOp } from '../data/filterOps';
import { FILTER_OPS, COMPARE_OPS, LIST_OPS } from '../data/filterOps';
import type { MetricAggregation } from '../analysis/metricValue';
import {
  CATEGORY_CAP, DATE_GRAINS, OTHER_LABEL, OTHER_NOTE,
  binPlan, chooseGrain, isDateGrain,
} from '../analysis/categoryKey';
import type { CategoryInfo, DateGrain } from '../analysis/categoryKey';
import { sqlEmpty } from './sqlGen';
import { relationSql } from './parquetStore';
// The group key — expressions and labels — lives in its own file since this one
// hit the 800-line cap. One-way: nothing there imports back.
import { bomSafe, catKeyExpr, catLabel, dateBucketSql, phys, sqlCanonicalDate, sqlNum } from './residentCategory';
import type { ResidentCatKey } from './residentCategory';
import * as duck from './duckdb';

export type { ResidentCatKey } from './residentCategory';

// ── Public shapes ────────────────────────────────────────────────────────────

export interface ResidentSource {
  /** Absolute path to the dataset's `.parquet` file. */
  parquetPath: string;
  /**
   * The record's stored `ParsedColumn[]`, POSITIONALLY ALIGNED to the file —
   * the same contract `parquetStore.readTable(path, schema)` takes. Names and
   * declared types live only here; the file itself is all-VARCHAR `c0..cN`.
   */
  columns: ParsedColumn[];
}

export interface ResidentMeasure {
  column: string;
  aggregation: MetricAggregation;
}

export interface ResidentSeries {
  name: string;
  values: (number | null)[];
}

export interface ResidentChartData {
  labels: (string | number)[];
  series: ResidentSeries[];
}

// ── Constants shared with transforms.ts ──────────────────────────────────────

const AGG_FNS: ReadonlySet<string> = new Set(['sum', 'avg', 'count', 'min', 'max']);
const SQL_OP: Record<string, string> = { '=': '=', '!=': '<>', '>': '>', '<': '<', '>=': '>=', '<=': '<=' };

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * True when a query can be served straight off Parquet. Starts the DuckDB
 * worker on first call (this is the "is the fast path up?" probe, so it has to
 * actually try). Never throws — a false answer means: use the JS path.
 */
export function isResident(): boolean {
  try {
    return duck.isAvailable();
  } catch {
    return false;
  }
}

/**
 * The ONE number a metric card shows, computed without hydrating a single row.
 *
 * Byte-for-byte the semantics of `metricValue.computeMetric` applied to
 * `parquetStore.readTable(src.parquetPath, src.columns)`, with `filters`
 * applied first exactly as `transforms.applyPipeline` would apply them.
 *
 * Returns `null` for: an unknown column, an unsupported aggregation, a column
 * with no finite numeric cells (NEVER 0, NEVER NaN) — and also when the bridge
 * is unavailable or the query fails, in which case the caller must fall back.
 * `count` is the exception that returns 0 rather than null over no rows.
 */
export function computeMetricResident(
  src: ResidentSource,
  spec: { column: string; aggregation: MetricAggregation },
  filters?: FilterStep[],
): number | null {
  try {
    const cols = schemaOf(src);
    if (!cols) return null;
    // The guards stay in TS, before any SQL exists. In DuckDB an unknown column
    // is a binder error and an unknown aggregation a catalog error; today both
    // of those render "—" via a null, not an error state (phase-0/04 R-METRIC-07).
    if (!spec || typeof spec.column !== 'string' || !AGG_FNS.has(spec.aggregation)) return null;
    const ci = colIndex(cols, spec.column);
    if (ci < 0) return null;

    const params: duck.DuckValue[] = [];
    const where = whereClause(cols, filters, params);
    const expr = aggExpr(cols, ci, spec.aggregation);

    // No GROUP BY, so a global aggregate over zero qualifying rows returns ONE
    // row: count → 0, sum/avg/min/max → NULL. That is exactly metricValue's
    // asymmetric empty-table contract (R-METRIC-08), for free and with no
    // HAVING and no COALESCE.
    const sql = `SELECT ${expr} AS m0 FROM ${plainFrom(src.parquetPath)}${where};`;
    const out = duck.query(sql, params);
    if (out.length === 0) return null;
    return metricNumber(out[0].m0);
  } catch {
    // Bridge down, missing file, non-Parquet bytes, width mismatch, overflow —
    // one answer: the caller keeps its working JS path.
    return null;
  }
}

/**
 * One group per distinct value of `category`, first-seen order preserved, one
 * series per measure — the exact `{labels, series}` object
 * `vizData.buildVizData` produces for the aggregated (no-split) encoding, and
 * therefore the exact shape `chartRender.buildChart` already consumes.
 *
 * Returns `null` when the bridge is unavailable, the query fails, `category` is
 * unknown, or `measures` is empty. The last two are cases where `buildVizData`
 * short-circuits to an empty result WITH A WARNING, and warnings are not part of
 * this API — so the honest answer is "fall back", not a silently warning-free
 * empty chart.
 */
export function aggregateResident(
  src: ResidentSource,
  category: string,
  measures: ResidentMeasure[],
  filters?: FilterStep[],
  catKey: ResidentCatKey = { kind: 'raw' },
): ResidentChartData | null {
  try {
    const cols = schemaOf(src);
    if (!cols) return null;
    if (typeof category !== 'string' || category === '') return null;
    const gi = colIndex(cols, category);
    if (gi < 0) return null;
    const list = Array.isArray(measures) ? measures : [];
    if (list.length === 0) return null;

    const out = runAggregate(src, cols, gi, list, filters, catKey);
    if (out === null) return null;

    const catType = cols[gi].type;
    const labels = out.map((r) => catLabel(r.g0 ?? null, catType, catKey));
    const series = list.map((m, i) => ({
      name: measureLabel(m),
      // vizData.numOrNull: ONLY a finite number survives; anything else is null,
      // because every renderer tests `typeof v === 'number'`.
      values: out.map((r) => finiteOrNull(r[`m${i}`] ?? null)),
    }));
    return { labels, series };
  } catch {
    return null;
  }
}

/**
 * The pre-queries that turn a category column into a `ResidentCatKey`, plus the
 * `CategoryInfo` the renderer shows — the resident twin of the first half of
 * `vizData.rewriteCategory`.
 *
 * Every probe below runs against the SAME relation with the SAME WHERE as the
 * aggregate that follows, through `filterPredicates`/`relationSql`, so the bins,
 * the grain and the top-50 cut describe exactly what will be plotted.
 *
 * `null` means "no resident answer" — notably a date column carrying anything
 * but the two canonical shapes, which SQL does not implement and the JS
 * `Date.parse` fallback does.
 */
export function resolveCatKey(
  src: ResidentSource,
  category: string,
  measures: ResidentMeasure[],
  filters?: FilterStep[],
  grain?: DateGrain,
  bins?: number,
): { key: ResidentCatKey; info: CategoryInfo } | null {
  try {
    const cols = schemaOf(src);
    if (!cols) return null;
    if (typeof category !== 'string' || category === '') return null;
    const gi = colIndex(cols, category);
    if (gi < 0) return null;
    const list = Array.isArray(measures) ? measures : [];
    if (list.length === 0) return null;

    const type = cols[gi].type;
    if (type === 'number') return binKey(src, cols, gi, filters, bins);
    if (type === 'date') return dateKey(src, cols, gi, filters, grain);
    return textKey(src, cols, gi, list[0], filters);
  } catch {
    return null;
  }
}

/** min/max of the FILTERED numeric cells → the bin edges. */
function binKey(
  src: ResidentSource,
  cols: ParsedColumn[],
  gi: number,
  filters: FilterStep[] | undefined,
  bins: number | undefined,
): { key: ResidentCatKey; info: CategoryInfo } | null {
  const params: duck.DuckValue[] = [];
  const where = whereClause(cols, filters, params);
  const n = sqlNum(phys(gi));
  const sql =
    `SELECT CAST(min(${n}) AS DOUBLE) AS lo, CAST(max(${n}) AS DOUBLE) AS hi ` +
    `FROM ${plainFrom(src.parquetPath)}${where};`;
  const out = duck.query(sql, params);
  if (out.length === 0) return null;
  // binPlan is shared with the JS path, so the degenerate cases (one distinct
  // value, no numeric cells at all) collapse to one bucket identically.
  const plan = binPlan(finiteOrNull(out[0].lo), finiteOrNull(out[0].hi), bins);
  return { key: { kind: 'bin', ...plan }, info: { kind: 'number', binned: true } };
}

/**
 * The canonical-shape probe, and — when the encoding did not name a grain — the
 * five distinct-bucket counts that pick the default. One query either way.
 */
function dateKey(
  src: ResidentSource,
  cols: ParsedColumn[],
  gi: number,
  filters: FilterStep[] | undefined,
  grain: DateGrain | undefined,
): { key: ResidentCatKey; info: CategoryInfo } | null {
  const p = phys(gi);
  const d = sqlCanonicalDate(p);
  const named = isDateGrain(grain) ? grain : null;

  // Empty is null OR '' OR whitespace, spelled out by sqlEmpty rather than
  // trim(). CASE WHEN rather than FILTER (WHERE …), as everywhere in this file.
  const select = [`CAST(sum(CASE WHEN NOT ${sqlEmpty(p)} AND ${d} IS NULL THEN 1 ELSE 0 END) AS DOUBLE) AS bad`];
  if (!named) {
    for (const g of DATE_GRAINS) select.push(`CAST(count(DISTINCT ${dateBucketSql(d, g)}) AS DOUBLE) AS g_${g}`);
  }

  const params: duck.DuckValue[] = [];
  const where = whereClause(cols, filters, params);
  const out = duck.query(`SELECT ${select.join(', ')} FROM ${plainFrom(src.parquetPath)}${where};`, params);
  if (out.length === 0) return null;
  // sum() over zero qualifying rows is NULL, and zero rows means zero unparsable
  // cells — so `?? 0` is the right reading, not a defensive coalesce.
  if ((finiteOrNull(out[0].bad) ?? 0) !== 0) return null;

  let g: DateGrain;
  if (named) {
    g = named;
  } else {
    const counts = {} as Record<DateGrain, number>;
    // count(DISTINCT …) skips NULLs, exactly as the JS side counts only parsed
    // buckets. An unreadable count is Infinity so chooseGrain coarsens past it.
    for (const x of DATE_GRAINS) counts[x] = finiteOrNull(out[0][`g_${x}`]) ?? Infinity;
    g = chooseGrain(counts);
  }
  return { key: { kind: 'date', grain: g }, info: { kind: 'date', grain: g } };
}

/**
 * The top-(CATEGORY_CAP + 1) probe. Asking for one more group than we keep is
 * what answers BOTH questions in one query: fewer rows come back and the column
 * is under the cap, so no rewrite happens at all.
 */
function textKey(
  src: ResidentSource,
  cols: ParsedColumn[],
  gi: number,
  first: ResidentMeasure,
  filters: FilterStep[] | undefined,
): { key: ResidentCatKey; info: CategoryInfo } | null {
  const p = phys(gi);
  const params: duck.DuckValue[] = [];
  const where = whereClause(cols, filters, params);
  const agg = aggExpr(cols, colIndex(cols, first.column), first.aggregation);

  // DESC NULLS LAST then the ordinal: the JS twin sorts the first-seen group
  // list by value descending with nulls last and breaks ties on position.
  const out = runOrdered(
    src.parquetPath,
    (from, ord) =>
      `SELECT ${bomSafe(p)} AS g0, ${agg} AS m0 FROM ${from}${where} ` +
      `GROUP BY ${p} ORDER BY m0 DESC NULLS LAST, min(${ord}) LIMIT ${CATEGORY_CAP + 1};`,
    params,
  );
  if (out.length <= CATEGORY_CAP) return { key: { kind: 'raw' }, info: { kind: 'text' } };

  const keep: string[] = [];
  let keepNull = false;
  for (const r of out.slice(0, CATEGORY_CAP)) {
    const v = r.g0;
    if (v == null) keepNull = true;
    else keep.push(typeof v === 'string' ? v : String(v));
  }
  return {
    key: { kind: 'other', keep, keepNull, label: OTHER_LABEL },
    info: { kind: 'text', note: OTHER_NOTE },
  };
}

// ── Ordinal mode ─────────────────────────────────────────────────────────────
//
// `file_row_number=true` is the ordinal (see the header). If a DuckDB build
// rejects the option we downgrade ONCE, permanently, to `row_number() OVER ()`
// in a subquery — measured stable over 60k here, just not stable by
// construction. The happy path costs no probe query.

type OrdinalMode = 'file_row_number' | 'row_number';
let ordinalMode: OrdinalMode = 'file_row_number';

/**
 * Run a statement that needs the ordinal, downgrading the mode ONCE and
 * permanently if the build rejects `file_row_number`. `sqlFor` is called again
 * on the retry with the fallback FROM/ordinal; `params` is unchanged by the
 * ordinal, so the same array is reused.
 */
// EXPORTED for `engine/pivotResident`: a pivot runs the same kind of ordered
// group-by over several grouping sets, and a second copy of the ordinal
// downgrade / the aggregate SQL / the FROM target is exactly the silent
// divergence this layer's differential tests exist to prevent.
export function runOrdered(
  parquetPath: string,
  sqlFor: (from: string, ord: string) => string,
  params: duck.DuckValue[],
): duck.DuckRow[] {
  const first = orderedFrom(parquetPath, ordinalMode);
  try {
    return duck.query(sqlFor(first.from, first.ord), params);
  } catch (err) {
    if (ordinalMode === 'file_row_number' && /file_row_number/i.test(String((err as Error)?.message ?? ''))) {
      ordinalMode = 'row_number';
      const next = orderedFrom(parquetPath, 'row_number');
      return duck.query(sqlFor(next.from, next.ord), params);
    }
    throw err;
  }
}

function runAggregate(
  src: ResidentSource,
  cols: ParsedColumn[],
  gi: number,
  measures: ResidentMeasure[],
  filters: FilterStep[] | undefined,
  catKey: ResidentCatKey,
): duck.DuckRow[] | null {
  // Params are positional, so they are pushed in STATEMENT-TEXT order: the key
  // expression's, then the WHERE's.
  const params: duck.DuckValue[] = [];
  const key = catKeyExpr(cols, gi, catKey, params);
  const where = whereClause(cols, filters, params);

  const aggs = measures.map((m, i) => `${aggExpr(cols, colIndex(cols, m.column), m.aggregation)} AS m${i}`);

  if (catKey.kind === 'raw') {
    // Unchanged: the label projection and the group key differ here (bomSafe vs
    // the raw column) and neither carries a parameter.
    return runOrdered(
      src.parquetPath,
      (from, ord) =>
        `SELECT ${key.label} AS g0, ${aggs.join(', ')} FROM ${from}${where} ` +
        `GROUP BY ${key.group} ORDER BY min(${ord});`,
      params,
    );
  }
  // A BUCKETED key is one expression serving as both the label and the group,
  // and it carries bound parameters. Computing it once in a subquery and
  // grouping by NAME keeps each parameter bound exactly once — repeating the
  // expression in GROUP BY would mean binding the same values twice, in an
  // order that has to stay in step with the statement text.
  return runOrdered(
    src.parquetPath,
    (from, ord) =>
      `SELECT __k AS g0, ${aggs.join(', ')} FROM ` +
      `(SELECT ${key.label} AS __k, ${ord} AS __o, * FROM ${from}${where}) ` +
      `GROUP BY __k ORDER BY min(__o);`,
    params,
  );
}

// ── FROM targets ─────────────────────────────────────────────────────────────
//
// `parquetStore.relationSql` is the ONLY place a path becomes SQL: it validates
// the path and escapes the string literal. The ordinal variant is derived from
// its output by re-opening the argument list rather than by re-implementing the
// escaping — there is one escaper, and it is the tested one.

// EXPORTED for `engine/pivotResident`: a pivot runs the same kind of ordered
// group-by over several grouping sets, and a second copy of the ordinal
// downgrade / the aggregate SQL / the FROM target is exactly the silent
// divergence this layer's differential tests exist to prevent.
// A JOINED relation (engine/joinResident.ts) registered under a key that stands
// in for a path, so every probe and aggregate in this file runs unchanged over a
// join. The relation exposes the merged `c0..cN` plus the primary's `__ord`.
// Registered for the duration of one synchronous call and removed after it.
const joinRelations = new Map<string, string>();

export function withRelation<T>(key: string, sql: string, run: () => T): T {
  joinRelations.set(key, sql);
  try {
    return run();
  } finally {
    joinRelations.delete(key);
  }
}

export function plainFrom(parquetPath: string): string {
  return joinRelations.get(parquetPath) ?? relationSql(parquetPath);
}

function orderedFrom(parquetPath: string, mode: OrdinalMode): { from: string; ord: string } {
  const joined = joinRelations.get(parquetPath);
  if (joined) return { from: joined, ord: '__ord' };
  const base = relationSql(parquetPath); // read_parquet('…')  — validated + escaped
  if (mode === 'file_row_number') {
    return { from: `${base.slice(0, -1)}, file_row_number=true)`, ord: 'file_row_number' };
  }
  // A window function cannot be nested inside min(), so it is materialised by a
  // subquery first.
  return { from: `(SELECT row_number() OVER () AS __ord, * FROM ${base})`, ord: '__ord' };
}

/** `transforms.cellToString` for a stored cell: NULL becomes ''. */
function sqlStr(p: string): string {
  return `coalesce(CAST(${p} AS VARCHAR), '')`;
}

/**
 * One aggregation, mirroring `transforms.aggregate` / `metricValue.computeMetric`.
 * `ci < 0` (unknown measure column) yields NULL — transforms warns and returns
 * null there, and a null value is faithfully reproducible; the warning is not.
 */
// EXPORTED for `engine/pivotResident`: a pivot runs the same kind of ordered
// group-by over several grouping sets, and a second copy of the ordinal
// downgrade / the aggregate SQL / the FROM target is exactly the silent
// divergence this layer's differential tests exist to prevent.
export function aggExpr(cols: ParsedColumn[], ci: number, fn: MetricAggregation): string {
  if (ci < 0) return 'CAST(NULL AS DOUBLE)';
  const p = phys(ci);
  // Unknown fn degrades to count with no warning — transforms.aggregate:377.
  const f: MetricAggregation = (AGG_FNS.has(fn) ? fn : 'count') as MetricAggregation;

  if (f === 'count') {
    // NOT count(c): '' and '   ' are cells to SQL and empty to us (R-METRIC-04,
    // 06 §4 E8). Counts cells of ANY type, text included.
    return `CAST(count(*) FILTER (WHERE NOT ${sqlEmpty(p)}) AS DOUBLE)`;
  }
  // THE GATE. A non-number declared type has no finite numeric cells by
  // definition, so the answer is null. Never let an implicit cast decide: DuckDB
  // would happily read '007' as 7 and render a plausible wrong total.
  if (cols[ci].type !== 'number') return 'CAST(NULL AS DOUBLE)';

  const n = sqlNum(p);
  if (f === 'avg') {
    // sum/count, not avg(): measured divergence on (0.1…0.7) — avg() gives 0.4,
    // JS and sum/count both give 0.39999999999999997. The CASE keeps the
    // all-empty answer NULL without a COALESCE (sum is NULL there anyway; this
    // is belt-and-braces against 0/0).
    return `CAST(CASE WHEN count(${n}) > 0 THEN sum(${n}) / count(${n}) END AS DOUBLE)`;
  }
  // Always CAST(… AS DOUBLE): sum(INTEGER) is HUGEINT and reaches JS as a
  // decimal string. NO COALESCE — an all-empty column MUST stay null.
  return `CAST(${f}(${n}) AS DOUBLE)`;
}

// ── Filters ──────────────────────────────────────────────────────────────────
//
// `transforms` applies filter steps in sequence, but each one is a pure row
// predicate over an unchanged column set, so a sequence is exactly a
// conjunction. An unknown column or operator is SKIPPED (transforms skips it
// with a warning), which is what makes one dashboard-wide filter able to span
// heterogeneous datasets.

function whereClause(cols: ParsedColumn[], filters: FilterStep[] | undefined, params: duck.DuckValue[]): string {
  const preds = filterPredicates(cols, filters, params);
  return preds.length === 0 ? '' : ` WHERE ${preds.join(' AND ')}`;
}

/**
 * The filter list as SQL conjuncts, EXPORTED so a caller that already has a
 * WHERE of its own can AND these into it instead of building a second predicate
 * compiler.
 *
 * `datasetPage.readPage` is that caller: the rows behind a number and the number
 * itself must be selected by the SAME predicate, or the drill-down panel would
 * quietly contradict the figure above it. One compiler, two callers.
 *
 * Order matters: `params` is positional, so a caller must splice these
 * predicates into its statement in the same order it called this.
 */
export function filterPredicates(
  cols: ParsedColumn[],
  filters: FilterStep[] | undefined,
  params: duck.DuckValue[],
): string[] {
  if (!Array.isArray(filters) || filters.length === 0) return [];
  const preds: string[] = [];
  for (const f of filters) {
    const p = filterPredicate(cols, f, params);
    if (p) preds.push(p);
  }
  return preds;
}

/**
 * ONE filter step as a SQL predicate, or `null` when the step applies NOTHING
 * (unknown column, unknown operator, empty `in` list) — exactly the cases
 * `transforms.stepFilter` skips with a warning.
 *
 * Exported for the same reason as `filterPredicates`.
 */
export function filterPredicate(cols: ParsedColumn[], s: FilterStep, params: duck.DuckValue[]): string | null {
  if (!s || typeof s !== 'object' || s.type !== 'filter') return null;
  const ci = colIndex(cols, s.column);
  if (ci < 0) return null; // "Filter skipped: unknown column"
  if (!FILTER_OPS.has(s.op)) return null; // "Filter skipped: unknown operator"

  const p = phys(ci);
  const op: FilterOp = s.op;

  if (op === 'is_empty') return sqlEmpty(p);
  if (op === 'not_empty') return `NOT ${sqlEmpty(p)}`;
  if (op === 'contains') {
    // Always string-based regardless of column type. A null cell becomes '' and
    // an omitted needle is '' — which matches EVERY row, exactly as JS does.
    params.push(cellToString(s.value));
    return `contains(${sqlStr(p)}, CAST(? AS VARCHAR))`;
  }
  if (LIST_OPS.has(op)) {
    const values = Array.isArray(s.values) ? s.values : [];
    // Empty list → null, i.e. NO predicate. transforms skips the step with a
    // warning and applies nothing, so "apply nothing" is the row-identical
    // answer. (A caller that must not lose the warning — `ipc/visuals.ts`'s
    // warning-freedom gate — rejects this case before it ever gets here.)
    if (values.length === 0) return null;
    return sqlInPredicate(cols[ci].type, p, values, op === 'not in', params);
  }
  if (!COMPARE_OPS.has(op)) return 'FALSE';

  if (cols[ci].type === 'number') {
    // The target goes through the SAME strict gate as transforms (coerceValue →
    // isFiniteNumber), so '007' / '1,200' / 'abc' all become null and the filter
    // keeps ZERO rows for every operator, `!=` included.
    const t = coerceValue(s.value ?? null, 'number');
    const tn = typeof t === 'number' && Number.isFinite(t) ? t : null;
    if (tn === null) return 'FALSE';
    params.push(tn);
    // NULL <op> x is NULL → the row drops for every operator, matching the
    // `cn === null → false` branch.
    return `${sqlNum(p)} ${SQL_OP[op]} CAST(? AS DOUBLE)`;
  }
  params.push(cellToString(s.value));
  return `${sqlStr(p)} ${SQL_OP[op]} CAST(? AS VARCHAR)`;
}

/**
 * `in` / `not in` as one never-NULL boolean. The twin of `sqlGen.sqlInPredicate`
 * — same three rules, same order, and pinned to it by the differential tests in
 * scripts/test-residentQuery.ts:
 *
 *  1. Every value is a bound `?`; a value list is untrusted input and is the
 *     only operand here whose COUNT the renderer controls.
 *  2. Cast on the DECLARED type — `sqlNum` only for a `number` column, so
 *     `'007' in ('7')` stays false.
 *  3. `coalesce(… , FALSE)` before negating, because `NULL IN (…)` is NULL and a
 *     bare `NOT` would drop null rows. `not in` is the EXACT complement of `in`
 *     in the JS fold, so a null cell — which is in no list — has to survive.
 */
function sqlInPredicate(
  type: ColumnType,
  p: string,
  values: Cell[],
  negate: boolean,
  params: duck.DuckValue[],
): string {
  let inner: string;
  if (type === 'number') {
    // The same strict gate as transforms: an entry that is not a finite number
    // can never equal a finite cell, so it is dropped. All dropped → matches
    // nothing, exactly as `= 'abc'` on a number column keeps zero rows.
    const targets = new Set<number>();
    for (const v of values) {
      const n = coerceValue(v ?? null, 'number');
      if (typeof n === 'number' && Number.isFinite(n)) targets.add(n);
    }
    if (targets.size === 0) {
      inner = 'FALSE';
    } else {
      const holes: string[] = [];
      for (const n of targets) {
        holes.push('CAST(? AS DOUBLE)');
        params.push(n);
      }
      inner = `coalesce(${sqlNum(p)} IN (${holes.join(', ')}), FALSE)`;
    }
  } else {
    // De-duplicated to mirror the JS `Set` and to bound the parameter count.
    const targets = new Set<string>(values.map((v) => cellToString(v)));
    const holes: string[] = [];
    for (const t of targets) {
      holes.push('CAST(? AS VARCHAR)');
      params.push(t);
    }
    inner = `coalesce(${sqlStr(p)} IN (${holes.join(', ')}), FALSE)`;
  }
  return negate ? `NOT ${inner}` : inner;
}

// ── Result decoding ──────────────────────────────────────────────────────────

/** `vizData.numOrNull`: only a finite number survives. */
function finiteOrNull(raw: duck.DuckValue): number | null {
  const n = typeof raw === 'number' ? raw : raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * `metricValue` returns `number | null` and never NaN — but it CAN return
 * ±Infinity (a JS left-fold that overflows). DuckDB hands an infinite DOUBLE
 * back as the string 'Infinity', so it is converted rather than discarded, which
 * is the one place this differs from `finiteOrNull`.
 */
function metricNumber(raw: duck.DuckValue): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isNaN(n) ? null : n;
}

// ── Small mirrors of transforms.ts / vizData.ts ──────────────────────────────

/** Exact, case-sensitive, FIRST match — `transforms.colIndex`. */
function colIndex(cols: ParsedColumn[], name: string): number {
  for (let i = 0; i < cols.length; i += 1) {
    if (cols[i] && cols[i].name === name) return i;
  }
  return -1;
}

function cellToString(cell: Cell | undefined): string {
  return cell == null ? '' : String(cell);
}

/** `vizData.measureLabel` — the series name a chart legend shows. */
function measureLabel(m: ResidentMeasure): string {
  return m.aggregation === 'count' ? m.column : `${m.aggregation} of ${m.column}`;
}

function schemaOf(src: ResidentSource): ParsedColumn[] | null {
  if (!src || typeof src.parquetPath !== 'string' || !Array.isArray(src.columns)) return null;
  if (src.columns.length === 0) return null; // a 0-column file has no c0 to reference
  return src.columns;
}
