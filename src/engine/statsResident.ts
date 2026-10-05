'use strict';

// statsResident — per-column summaries and dataset quality issues computed
// DIRECTLY against a dataset's Parquet file. MAIN PROCESS ONLY. Never throws:
// every entry point returns `null` when the bridge is down or anything at all
// goes wrong, and the caller keeps its working `datasetStats` JS path.
//
// ── Why this file exists ─────────────────────────────────────────────────────
// `dataset:stats` runs on every Explore-tab open. It hydrated the whole table
// into `Cell[][]` and then called `datasetStats.computeColumnSummary` ONCE PER
// COLUMN — N full passes over a materialised table, on top of the hydration.
// Measured through the shipped handler on a 6-column fixture at 1,000,000 rows:
// 2,227 ms, of which ~1.5 s is hydration. The answer is six numbers per column.
//
// This module computes every column in ONE statement, reading only the columns
// it needs out of the columnar file. Nothing is materialised; the only thing
// that crosses the bridge is the answer — one row of scalars.
//
// ── What it must reproduce, exactly ──────────────────────────────────────────
// `computeColumnSummariesResident` ≡ `src.columns.map((col, c) =>
// datasetStats.computeColumnSummary(col, rows.map((r) => r[c])))` and
// `findQualityIssuesResident` ≡ `datasetStats.findQualityIssues(columns, rows)`,
// where `rows` is `parquetStore.readTable(src.parquetPath, src.columns).rows` —
// the SAME bytes, read the two ways. `scripts/test-statsResident.ts` asserts
// that equivalence differentially rather than against hand-written numbers.
//
// The divergences that had to be engineered around (docs/phase-0/04 §5):
//
//   1. `nonEmpty` EXCLUDES `''` and whitespace-only cells. Bare `count(col)`
//      over-counts, and DuckDB's `trim()` strips spaces only while RE2's `\s`
//      misses NBSP — so the emptiness predicate is `sqlGen.sqlEmpty`, which
//      spells the JS `trim()` whitespace class out explicitly. One definition of
//      "empty" in the codebase, shared with sqlGen/residentQuery.
//
//   2. TWO DIFFERENT NULL CONVENTIONS IN ONE INTERFACE. `min`/`max`/`mean` must
//      be ABSENT (the key deleted, `'min' in summary === false`) when the numeric
//      count is 0, while `mostCommon` must be PRESENT AND NULL. SQL returns NULL
//      for both, so the adapter — not the SQL — decides: the numeric keys are
//      only ever assigned inside `if (count > 0)`, and `mostCommon` is always
//      assigned. the desktop's `datasets.ts` tests `typeof sum.min === 'number'`,
//      so a stray `min: null` would render identically and ship silently; the
//      test suite compares KEY SETS, not just values, for exactly this reason.
//
//   3. `mostCommon` TIES RESOLVE TO FIRST OCCURRENCE IN ROW ORDER. JS iterates a
//      `Map` in insertion order with a strict `>`, so the earliest-seen of two
//      equally-common values wins. `mode()` is unspecified on ties, so the mode
//      is picked explicitly: `first(v ORDER BY count DESC, min(<ordinal>) ASC)`.
//      The ordinal is `read_parquet(…, file_row_number=true)` — a physical property
//      of the stored file rather than an artefact of scan order, the same choice
//      and the same one-time downgrade path as `residentQuery.ts`.
//
//   4. `distinct` is over NON-EMPTY, CASE-SENSITIVE, UNTRIMMED values. DuckDB's
//      collation is binary, so case-sensitivity is free; the non-empty part is
//      not (`count(DISTINCT c)` counts `''` and `'   '` as two extra values, and
//      would flag an all-empty column as `constant_column`).
//
//   5. `count`/`min`/`max`/`mean` see only FINITE numeric cells. `NaN` sorts
//      ABOVE every value in DuckDB, so an unfiltered `max()` returns NaN, which
//      then serialises to null and renders as a blank. `sqlNum` degrades
//      non-finite to NULL before any aggregate sees it.
//
// ── Number columns: `nonEmpty` IS the finite count ───────────────────────────
// A number column's stored cells are `String(cell)` of a `Cell` that is a finite
// number or null (`parse.coerceValue` gates on `isFiniteNumber`), and
// `parquetStore.readTable` maps anything that does not read back as a finite
// number to `null`. So the hydrated cell is non-null EXACTLY when the stored
// text is a finite number, and `nonEmpty === count` for a declared-number column
// — always, by construction. Deriving it that way (rather than from the
// emptiness predicate) is what keeps a hypothetical stored `'Infinity'` from
// being counted here and not there.
//
// ── What could NOT be reproduced ─────────────────────────────────────────────
// FLOAT SUMMATION ORDER, and therefore `mean`. `computeColumnSummary` folds
// `sum += c` left-to-right in row order; DuckDB combines vectorised partial
// sums. Integer-valued data (every fixture here, and most real dashboard data)
// is exact; non-integer data can differ in the last ULPs. This is inherent to
// parallel summation — `residentQuery.ts` documents the same limitation and
// measures it at ~6.6e-14 relative. It matters slightly more here than for a
// metric card, because `ipc/datasets.ts` embeds `mean` UNROUNDED in the AI
// prompt (`mean 200.00000000000003`), so a last-ULP change is a prompt-byte
// change. It cannot change a rendered figure. Pinned by a relative-error test.
//
// A NON-CANONICAL numeric string in a number column ('0x10', '1.0') would be
// read as 16 / 1 by JS `Number()` and as NULL / 1 by `TRY_CAST`. Our own writer
// only ever stores `String(n)`, so this is unreachable for a file this app
// wrote; it is inherited verbatim from `residentQuery`/`sqlGen` and listed here
// rather than papered over.

import type { ParsedColumn } from '../data/parse';
import type { ColumnSummary, QualityIssue } from '../data/datasetStats';
import type { Cell } from '../data/transforms';
import { sqlEmpty } from './sqlGen';
import { relationSql } from './parquetStore';
import * as duck from './duckdb';

// ── Public shapes ────────────────────────────────────────────────────────────

export interface StatsSource {
  /** Absolute path to the dataset's `.parquet` file. */
  parquetPath: string;
  /**
   * The record's stored `ParsedColumn[]`, POSITIONALLY ALIGNED to the file —
   * the same contract `parquetStore.readTable(path, schema)`,
   * `residentQuery.ResidentSource` and `datasets.residentSource` take.
   */
  columns: ParsedColumn[];
}

// ── Constants mirrored from datasetStats.ts ──────────────────────────────────

/** `datasetStats.EMPTY_HEAVY_RATIO` — module-private there, so it is restated. */
const EMPTY_HEAVY_RATIO = 0.5;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * True when stats can be served straight off Parquet. Starts the DuckDB worker
 * on first call (this is the "is the fast path up?" probe, so it has to actually
 * try). Never throws — a false answer means: use the JS path.
 */
export function isStatsResident(): boolean {
  try {
    return duck.isAvailable();
  } catch {
    return false;
  }
}

/**
 * One `ColumnSummary` per column, in declaration order — the exact array
 * `ipc/datasets.ts` builds today with N calls to
 * `datasetStats.computeColumnSummary`, computed in ONE query.
 *
 * Returns `null` — never throws — when the bridge is unavailable, the file is
 * missing/corrupt/narrower than the record, the column list is empty or
 * malformed, or the query fails. `null` always means "fall back", never "no
 * data": an all-empty column is a perfectly good summary and is returned as one.
 */
export async function computeColumnSummariesResident(src: StatsSource): Promise<ColumnSummary[] | null> {
  try {
    const cols = schemaOf(src);
    if (!cols) return null;
    const row = await runOnce((mode) => summarySql(cols, src.parquetPath, mode));
    if (!row) return null;

    const out: ColumnSummary[] = [];
    for (let i = 0; i < cols.length; i += 1) {
      const col = cols[i];
      const s = decodeSummary(col, row, i);
      if (!s) return null; // an internally inconsistent row is a fallback, not a guess
      out.push(s);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * `empty_heavy` / `constant_column` / `duplicate_rows` for the whole table, in
 * `datasetStats.findQualityIssues`'s emission order: per column (empty_heavy
 * then constant_column) in declaration order, then a single duplicate_rows last.
 * Detail strings are assembled HERE, in TS, so they are byte-identical to the JS
 * path — they are user-visible.
 *
 * Returns `null` on any failure or unavailability. An empty ARRAY is a real
 * answer (a clean table, or a table with no rows).
 */
export async function findQualityIssuesResident(src: StatsSource): Promise<QualityIssue[] | null> {
  try {
    const cols = schemaOf(src);
    if (!cols) return null;
    const row = await runOnce(() => qualitySql(cols, src.parquetPath));
    if (!row) return null;

    const rowCount = intOrNull(row.n);
    const distinctRows = intOrNull(row.dr);
    if (rowCount === null || distinctRows === null) return null;
    // Both `rowCount > 0` guards in findQualityIssues, reproduced: an empty
    // table has no issues at all, not even a duplicate-row count.
    if (rowCount === 0) return [];

    const issues: QualityIssue[] = [];
    for (let i = 0; i < cols.length; i += 1) {
      const name = String(cols[i].name);
      const nonEmpty = intOrNull(row[`ne${i}`]);
      const distinct = intOrNull(row[`d${i}`]);
      if (nonEmpty === null || distinct === null) return null;
      const empties = rowCount - nonEmpty;

      if (empties / rowCount >= EMPTY_HEAVY_RATIO) {
        // Math.round stays in TS: DuckDB's round() is half-away-from-zero and
        // JS's is half-up. (Ratios are non-negative here, so they agree — but
        // the rule is "raw counts from SQL, all arithmetic in TS".)
        const pct = Math.round((empties / rowCount) * 100);
        issues.push({
          kind: 'empty_heavy',
          column: name,
          detail: `Column "${name}" is ${pct}% empty`,
          severity: 'warn',
        });
      }

      // `distinct.size <= 1 && empties < rowCount`: one value plus some empties
      // IS constant (and may also be empty_heavy); an ALL-empty column is NOT.
      if (distinct <= 1 && empties < rowCount) {
        issues.push({
          kind: 'constant_column',
          column: name,
          detail: `Column "${name}" has the same value in every row`,
          severity: 'info',
        });
      }
    }

    const dups = rowCount - distinctRows;
    if (dups > 0) {
      issues.push({
        kind: 'duplicate_rows',
        detail: dups === 1 ? '1 fully-duplicate row' : `${dups} fully-duplicate rows`,
        severity: 'info',
      });
    }
    return issues;
  } catch {
    return null;
  }
}

/**
 * The first `limit` rows of the stored table, in file order — enough for
 * `dataset:explain`'s sample block without hydrating the other 999,995 rows.
 * Cells are decoded exactly as `parquetStore.readTable` decodes them, including
 * the leading-BOM repair.
 *
 * Returns `null` on any failure; `[]` is a real answer for an empty table.
 */
export async function sampleRowsResident(src: StatsSource, limit: number): Promise<Cell[][] | null> {
  try {
    const cols = schemaOf(src);
    if (!cols) return null;
    const n = Math.floor(limit);
    if (!Number.isFinite(n) || n < 0) return null;
    if (n === 0) return [];

    const rows = await runQuery((mode) => {
      const { from, ord } = orderedFrom(src.parquetPath, mode);
      const projection = cols.map((_, i) => `${bomSafe(phys(i))} AS v${i}`).join(', ');
      // ORDER BY the ordinal rather than trusting an unordered LIMIT: a parallel
      // scan may hand back any rows, and "the first five" is the contract.
      return `SELECT ${projection} FROM ${from} ORDER BY ${ord} LIMIT ${n};`;
    });
    if (!rows) return null;

    return rows.map((r) =>
      cols.map((col, i) => toCell(r[`v${i}`] ?? null, col.type === 'number')),
    );
  } catch {
    return null;
  }
}

// ── SQL builders ─────────────────────────────────────────────────────────────
//
// Physical names are positional `c0..cN`, the same contract `sqlGen.ts`,
// `parquetStore.ts` and `residentQuery.ts` use. USER-FACING COLUMN NAMES NEVER
// REACH SQL, so identifier quoting, duplicate names and name injection are all
// structurally out of reach. The only user-influenced text is the file path, and
// `parquetStore.relationSql` validates and escapes that.

/**
 * ONE statement for every column — the structural win over the N-pass loop.
 *
 * Number columns are four scalar aggregates over the whole relation (`sc`).
 * Text/date columns need `nonEmpty`, `distinct`, the modal value AND its count,
 * which is a GROUP BY per column. Rather than issue one subquery per column,
 * every text column is folded into ONE grouped scan: `unnest` turns each row
 * into one `{column index, value}` tuple per text column, so a single
 * `GROUP BY (k, v)` counts every column's values at once, `min(ord)` carries the
 * first-occurrence tie-break, and one more `GROUP BY k` picks each column's
 * winner. `p` then pivots that one-row-per-column result into one row of
 * scalars, and the cross join with `sc` (both are exactly one row) makes the
 * whole thing a single statement.
 *
 * MEASURED against the obvious alternative — two uncorrelated scalar subqueries
 * per text column, which is also one statement but one Parquet scan per column:
 *
 *     rows        per-column subqueries      this (one grouped pass)
 *     1,000              30.2 ms                     3.8 ms
 *     10,000             31.3 ms                     5.9 ms
 *     100,000            36.5 ms                    18.7 ms
 *     1,000,000          52.8 ms                    41.2 ms
 *     40 cols × 50k     114.3 ms                    81.5 ms
 *
 * The ~3.5 ms per-scan fixed cost is what makes the per-column form lose badly
 * on the small tables most real datasets are (imports are capped at 50k rows).
 *
 * `bomSafe` is applied INSIDE the struct, so the grouping key is the
 * BOM-doubled value. Doubling a leading U+FEFF is injective, so it cannot merge
 * or split groups, and U+FEFF is in the emptiness class on both sides, so it
 * cannot change what counts as empty either.
 */
function summarySql(cols: ParsedColumn[], parquetPath: string, mode: OrdinalMode): string {
  const rel = relationSql(parquetPath);

  // ── The scalar half: one aggregate row for the number columns ──────────────
  const scalars: string[] = [];
  cols.forEach((col, i) => {
    if (col.type !== 'number') return;
    // `count` is the mean's denominator AND `nonEmpty` (see the header).
    const n = sqlNum(phys(i));
    scalars.push(`CAST(count(${n}) AS DOUBLE) AS f${i}`);
    // NO COALESCE anywhere: sum/min/max over zero finite cells MUST stay NULL,
    // which is how the adapter knows to omit min/max/mean entirely.
    scalars.push(`CAST(sum(${n}) AS DOUBLE) AS s${i}`);
    scalars.push(`CAST(min(${n}) AS DOUBLE) AS mn${i}`);
    scalars.push(`CAST(max(${n}) AS DOUBLE) AS mx${i}`);
  });

  const textIdx: number[] = [];
  cols.forEach((col, i) => {
    if (col.type !== 'number') textIdx.push(i);
  });
  if (textIdx.length === 0) return `SELECT ${scalars.join(', ')} FROM ${rel};`;

  // ── The grouped half: every text/date column in one pass ──────────────────
  const { from: ordFrom, ord } = orderedFrom(parquetPath, mode);
  const structs = textIdx.map((i) => `{'k': ${i}, 'v': ${bomSafe(phys(i))}}`).join(', ');
  const pivot: string[] = [];
  textIdx.forEach((i) => {
    // coalesce(…, 0) ONLY for the two counts, and only because a column with no
    // non-empty cells contributes no group at all: `nonEmpty` and `distinct` are
    // 0 there, never null. The modal VALUE is deliberately left NULL — that is
    // what makes `mostCommon` null rather than absent.
    pivot.push(`CAST(coalesce(max(CASE WHEN k = ${i} THEN ne END), 0) AS DOUBLE) AS ne${i}`);
    pivot.push(`CAST(coalesce(max(CASE WHEN k = ${i} THEN dn END), 0) AS DOUBLE) AS d${i}`);
    pivot.push(`max(CASE WHEN k = ${i} THEN tv END) AS mv${i}`);
    pivot.push(`CAST(max(CASE WHEN k = ${i} THEN tn END) AS DOUBLE) AS mc${i}`);
  });

  const ctes = [
    `e AS (SELECT ${ord} AS ord, unnest([${structs}]) AS u FROM ${ordFrom})`,
    `g AS (SELECT u.k AS k, u.v AS v, count(*) AS cnt, min(ord) AS o FROM e WHERE NOT ${sqlEmpty('u.v')} GROUP BY 1, 2)`,
    // ORDER BY cnt DESC, o ASC — strictly-greater-count wins, and among equals
    // the value whose FIRST occurrence came earliest. That is exactly the JS
    // `Map` insertion-order + strict `>` tie-break.
    `m AS (SELECT k, sum(cnt) AS ne, count(*) AS dn,` +
      ` first(v ORDER BY cnt DESC, o ASC) AS tv, first(cnt ORDER BY cnt DESC, o ASC) AS tn` +
      ` FROM g GROUP BY k)`,
    // No GROUP BY, so an EMPTY m still yields exactly one row (of NULLs).
    `p AS (SELECT ${pivot.join(', ')} FROM m)`,
  ];
  if (scalars.length === 0) return `WITH ${ctes.join(', ')} SELECT * FROM p;`;
  ctes.push(`sc AS (SELECT ${scalars.join(', ')} FROM ${rel})`);
  return `WITH ${ctes.join(', ')} SELECT * FROM sc, p;`;
}

/**
 * ONE statement for all three quality flags.
 *
 * `duplicate_rows` is `count(*) - count(DISTINCT every column)`, spelled as a
 * `SELECT DISTINCT` subquery over the EXPLICIT column list rather than `*`: it
 * bounds the comparison to the columns the record declares (which is what the
 * JS key does) and turns a file that is narrower than the record into a binder
 * error — i.e. a fallback — instead of a quietly different number.
 *
 * SQL `DISTINCT` treats NULLs as equal to each other and `''` as a value, which
 * is exactly what `JSON.stringify` does with `null` and `""`.
 */
function qualitySql(cols: ParsedColumn[], parquetPath: string): string {
  const rel = relationSql(parquetPath);
  const sel: string[] = [`CAST(count(*) AS DOUBLE) AS n`];

  cols.forEach((col, i) => {
    const p = phys(i);
    if (col.type === 'number') {
      // Both derived from the numeric reading, for the same reason `nonEmpty` is
      // (header): the JS side keys on `String(<the hydrated number>)`, so `1` and
      // `1.0` are one value and a non-finite cell is empty.
      const n = sqlNum(p);
      sel.push(`CAST(count(${n}) AS DOUBLE) AS ne${i}`);
      sel.push(`CAST(count(DISTINCT ${n}) AS DOUBLE) AS d${i}`);
      return;
    }
    // NOT `count(*) FILTER (WHERE NOT sc_empty(p))`. A FILTER clause per column
    // is quadratic-ish in practice: at 334 columns this statement took 41 s of a
    // 44 s call, and at 1,000 columns 51 s. Nulling the value inside a CASE and
    // leaning on count()'s own NULL-skipping is the identical computation and
    // measured 51,407 ms -> 4,838 ms at 1,000 columns, with 0 figures differing.
    // Same rewrite, same reason, as hitsSql in src/anomaliesResident.ts.
    const kept = `CASE WHEN ${sqlEmpty(p)} THEN NULL ELSE ${p} END`;
    sel.push(`CAST(count(${kept}) AS DOUBLE) AS ne${i}`);
    sel.push(`CAST(count(DISTINCT ${kept}) AS DOUBLE) AS d${i}`);
  });

  const key = cols.map((col, i) => (col.type === 'number' ? sqlNum(phys(i)) : phys(i))).join(', ');
  sel.push(`(SELECT CAST(count(*) AS DOUBLE) FROM (SELECT DISTINCT ${key} FROM ${rel})) AS dr`);

  return `SELECT ${sel.join(', ')} FROM ${rel};`;
}

// ── Result decoding ──────────────────────────────────────────────────────────

/**
 * One column's summary out of the single result row.
 *
 * THIS IS WHERE THE TWO NULL CONVENTIONS LIVE (header, divergence 2):
 * `min`/`max`/`mean` are assigned ONLY inside `if (count > 0)`, so they are
 * absent otherwise; `mostCommon` is assigned unconditionally, so it is present
 * and null. Returns null when the row is internally inconsistent (a positive
 * finite count with a NULL sum, say) — a fallback beats a fabricated figure.
 */
function decodeSummary(col: ParsedColumn, row: duck.DuckRow, i: number): ColumnSummary | null {
  if (col.type === 'number') {
    const count = intOrNull(row[`f${i}`]);
    if (count === null) return null;
    // nonEmpty === count for a number column, by construction (header).
    const summary: ColumnSummary = { name: col.name, type: col.type, nonEmpty: count, count };
    if (count > 0) {
      const sum = numOrNull(row[`s${i}`]);
      const min = numOrNull(row[`mn${i}`]);
      const max = numOrNull(row[`mx${i}`]);
      if (sum === null || min === null || max === null) return null;
      summary.min = min;
      summary.max = max;
      // sum/count, literally the JS formula, rather than avg().
      summary.mean = sum / count;
    }
    return summary;
  }

  const nonEmpty = intOrNull(row[`ne${i}`]);
  const distinct = intOrNull(row[`d${i}`]);
  if (nonEmpty === null || distinct === null) return null;
  const summary: ColumnSummary = { name: col.name, type: col.type, nonEmpty, distinct };

  const raw = row[`mv${i}`];
  if (raw == null) {
    // No non-empty cells → `mostCommon: null`, PRESENT. Not deleted.
    summary.mostCommon = null;
    return summary;
  }
  const mcCount = intOrNull(row[`mc${i}`]);
  if (mcCount === null || mcCount <= 0) return null;
  summary.mostCommon = { value: typeof raw === 'string' ? raw : String(raw), count: mcCount };
  return summary;
}

/** A finite number, or null. `'Infinity'` (an overflowed sum) survives as ±Infinity. */
function numOrNull(raw: duck.DuckValue): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isNaN(n) ? null : n;
}

/** A count: a finite, non-negative integer, or null (which means "fall back"). */
function intOrNull(raw: duck.DuckValue): number | null {
  const n = numOrNull(raw);
  if (n === null || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

/** `parquetStore.toCell` — NOT a re-parse: `''` stays `''` for a text column. */
function toCell(raw: duck.DuckValue, isNumber: boolean): Cell {
  if (raw == null) return null;
  if (!isNumber) return typeof raw === 'string' ? raw : String(raw);
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

// ── Physical column expressions (shared dialect with sqlGen/residentQuery) ───

function phys(i: number): string {
  return `c${i}`;
}

/** A finite JS number, or NULL. Mirrors `sqlGen`'s private `sqlNum`. */
function sqlNum(p: string): string {
  return `CASE WHEN isfinite(TRY_CAST(${p} AS DOUBLE)) THEN TRY_CAST(${p} AS DOUBLE) END`;
}

// `src/duckdb.ts` loses exactly ONE leading U+FEFF from every returned string
// (documented there; the loss is below the JS layer). Doubling a leading BOM at
// projection time is an exact inverse, and a value that does not start with one
// is untouched — the same repair `parquetStore.readTable` applies. `mostCommon.value`
// and sample cells are user data, so they get it; counts are DOUBLEs.
const BOM = 'chr(65279)';
function bomSafe(p: string): string {
  const v = `CAST(${p} AS VARCHAR)`;
  return `CASE WHEN starts_with(${v}, ${BOM}) THEN ${BOM} || ${v} ELSE ${v} END`;
}

// ── Ordinal mode ─────────────────────────────────────────────────────────────
//
// `file_row_number=true` surfaces the row's index WITHIN THE FILE — a physical
// property of the stored data, so unlike `row_number() OVER ()` it does not
// depend on the order rows happen to reach an operator under a parallel scan.
// `min(file_row_number)` is therefore first-seen order by construction, which is
// what the `mostCommon` tie-break needs. If a DuckDB build rejects the option we
// downgrade ONCE, permanently, exactly as `residentQuery.ts` does; the happy
// path costs no probe query.

type OrdinalMode = 'file_row_number' | 'row_number';
let ordinalMode: OrdinalMode = 'file_row_number';

function orderedFrom(parquetPath: string, mode: OrdinalMode): { from: string; ord: string } {
  const base = relationSql(parquetPath); // read_parquet('…') — validated + escaped
  if (mode === 'file_row_number') {
    return { from: `${base.slice(0, -1)}, file_row_number=true)`, ord: 'file_row_number' };
  }
  // A window function cannot be nested inside min(), so it is materialised by a
  // subquery first.
  return { from: `(SELECT row_number() OVER () AS __ord, * FROM ${base})`, ord: '__ord' };
}

// ── Execution ────────────────────────────────────────────────────────────────

/** Run a built statement, downgrading the ordinal once if the build rejects it. */
async function runQuery(build: (mode: OrdinalMode) => string): Promise<duck.DuckRow[] | null> {
  if (!duck.isAvailable()) return null;
  try {
    return await duck.queryAsync(build(ordinalMode));
  } catch (err) {
    if (ordinalMode === 'file_row_number' && /file_row_number/i.test(String((err as Error)?.message ?? ''))) {
      ordinalMode = 'row_number';
      return duck.queryAsync(build('row_number'));
    }
    throw err;
  }
}

/** The single-row variant: a global aggregate always returns exactly one row. */
async function runOnce(build: (mode: OrdinalMode) => string): Promise<duck.DuckRow | null> {
  const rows = await runQuery(build);
  if (!rows || rows.length !== 1) return null;
  return rows[0];
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * The source is usable only when every column is a real `ParsedColumn`. A
 * 0-column dataset falls back: the file holds only a sentinel column, and
 * `findQualityIssues` still reports every row after the first as a duplicate of
 * an empty key — reproducible, but not worth the SQL for a table with no
 * columns to summarise.
 */
function schemaOf(src: StatsSource): ParsedColumn[] | null {
  if (!src || typeof src.parquetPath !== 'string' || !Array.isArray(src.columns)) return null;
  if (src.columns.length === 0) return null;
  for (const col of src.columns) {
    if (!col || typeof col !== 'object' || typeof col.name !== 'string') return null;
  }
  return src.columns;
}
