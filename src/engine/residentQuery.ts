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

import type { ColumnType, ParsedColumn } from '../parse';
import { coerceValue } from '../parse';
import type { Cell, FilterStep } from '../transforms';
import type { FilterOp } from '../filterOps';
import { FILTER_OPS, COMPARE_OPS, LIST_OPS } from '../filterOps';
import type { MetricAggregation } from '../metricValue';
import { sqlEmpty } from './sqlGen';
import { relationSql } from './parquetStore';
import * as duck from './duckdb';

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
): ResidentChartData | null {
  try {
    const cols = schemaOf(src);
    if (!cols) return null;
    if (typeof category !== 'string' || category === '') return null;
    const gi = colIndex(cols, category);
    if (gi < 0) return null;
    const list = Array.isArray(measures) ? measures : [];
    if (list.length === 0) return null;

    const out = runAggregate(src, cols, gi, list, filters, ordinalMode);
    if (out === null) return null;

    const catType = cols[gi].type;
    const labels = out.map((r) => labelOf(r.g0 ?? null, catType));
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

// ── Ordinal mode ─────────────────────────────────────────────────────────────
//
// `file_row_number=true` is the ordinal (see the header). If a DuckDB build
// rejects the option we downgrade ONCE, permanently, to `row_number() OVER ()`
// in a subquery — measured stable over 60k here, just not stable by
// construction. The happy path costs no probe query.

type OrdinalMode = 'file_row_number' | 'row_number';
let ordinalMode: OrdinalMode = 'file_row_number';

function runAggregate(
  src: ResidentSource,
  cols: ParsedColumn[],
  gi: number,
  measures: ResidentMeasure[],
  filters: FilterStep[] | undefined,
  mode: OrdinalMode,
): duck.DuckRow[] | null {
  const params: duck.DuckValue[] = [];
  const where = whereClause(cols, filters, params);
  const { from, ord } = orderedFrom(src.parquetPath, mode);

  const key = groupKeyExpr(cols, gi);
  const select = [`${key.label} AS g0`];
  measures.forEach((m, i) => {
    const ci = colIndex(cols, m.column);
    select.push(`${aggExpr(cols, ci, m.aggregation)} AS m${i}`);
  });

  const sql =
    `SELECT ${select.join(', ')} FROM ${from}${where} ` +
    `GROUP BY ${key.group} ORDER BY min(${ord});`;

  try {
    return duck.query(sql, params);
  } catch (err) {
    if (mode === 'file_row_number' && /file_row_number/i.test(String((err as Error)?.message ?? ''))) {
      ordinalMode = 'row_number';
      return runAggregate(src, cols, gi, measures, filters, 'row_number');
    }
    throw err;
  }
}

// ── FROM targets ─────────────────────────────────────────────────────────────
//
// `parquetStore.relationSql` is the ONLY place a path becomes SQL: it validates
// the path and escapes the string literal. The ordinal variant is derived from
// its output by re-opening the argument list rather than by re-implementing the
// escaping — there is one escaper, and it is the tested one.

function plainFrom(parquetPath: string): string {
  return relationSql(parquetPath);
}

function orderedFrom(parquetPath: string, mode: OrdinalMode): { from: string; ord: string } {
  const base = relationSql(parquetPath); // read_parquet('…')  — validated + escaped
  if (mode === 'file_row_number') {
    return { from: `${base.slice(0, -1)}, file_row_number=true)`, ord: 'file_row_number' };
  }
  // A window function cannot be nested inside min(), so it is materialised by a
  // subquery first.
  return { from: `(SELECT row_number() OVER () AS __ord, * FROM ${base})`, ord: '__ord' };
}

// ── Physical column expressions ──────────────────────────────────────────────
//
// Physical names are positional `c0..cN`, the same contract `sqlGen.ts` and
// `parquetStore.ts` use. User-facing names never reach SQL, so identifier
// quoting, duplicate names and column-name injection are all structurally out of
// reach.

function phys(i: number): string {
  return `c${i}`;
}

/** A finite JS number, or NULL. Mirrors `sqlGen`'s private `sqlNum`. */
function sqlNum(p: string): string {
  return `CASE WHEN isfinite(TRY_CAST(${p} AS DOUBLE)) THEN TRY_CAST(${p} AS DOUBLE) END`;
}

/** `transforms.cellToString` for a stored cell: NULL becomes ''. */
function sqlStr(p: string): string {
  return `coalesce(CAST(${p} AS VARCHAR), '')`;
}

// The transport in src/duckdb.ts loses exactly ONE leading U+FEFF from every
// returned string (documented there; below the JS layer, unfixable there).
// Doubling a leading BOM at projection time is an exact inverse, and a value
// that does not start with one is untouched — the same fix `parquetStore.readTable`
// applies. Group LABELS are user data, so they get it; aggregates are DOUBLEs
// and cannot be affected.
const BOM = 'chr(65279)';
function bomSafe(p: string): string {
  const v = `CAST(${p} AS VARCHAR)`;
  return `CASE WHEN starts_with(${v}, ${BOM}) THEN ${BOM} || ${v} ELSE ${v} END`;
}

/**
 * The GROUP BY key and its label projection.
 *
 * `transforms.stepGroupAggregate` keys on the ROUND-TRIPPED cell, so a `number`
 * column groups on the JS number (`'1'` and `'1.0'` are one group; a
 * non-numeric or non-finite value is `null`) while a text/date column groups on
 * the string verbatim (`null` and `''` stay two distinct groups). Grouping on
 * the raw VARCHAR would split `1` from `1.0`; grouping on a cast would fuse
 * `'007'` with `'7'`. Hence: cast ONLY when the DECLARED type is number.
 */
function groupKeyExpr(cols: ParsedColumn[], gi: number): { group: string; label: string } {
  const p = phys(gi);
  if (cols[gi].type === 'number') {
    const n = sqlNum(p);
    return { group: n, label: n };
  }
  return { group: p, label: bomSafe(p) };
}

/**
 * One aggregation, mirroring `transforms.aggregate` / `metricValue.computeMetric`.
 * `ci < 0` (unknown measure column) yields NULL — transforms warns and returns
 * null there, and a null value is faithfully reproducible; the warning is not.
 */
function aggExpr(cols: ParsedColumn[], ci: number, fn: MetricAggregation): string {
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

/**
 * The inverse of `String(cell)`, identical to `parquetStore.toCell` /
 * `pipelineDuck.toCell`. NOT a re-parse: `''` stays `''` for a text column.
 */
function toCell(raw: duck.DuckValue, type: ColumnType): Cell {
  if (raw == null) return null;
  if (type !== 'number') return typeof raw === 'string' ? raw : String(raw);
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** `vizData.labelVal` over a round-tripped group key. */
function labelOf(raw: duck.DuckValue, type: ColumnType): string | number {
  const cell = toCell(raw, type);
  if (typeof cell === 'number') return cell;
  return cell == null ? '' : String(cell);
}

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
