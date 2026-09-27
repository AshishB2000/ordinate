'use strict';

// pipelineDuck — execute a prepare pipeline in DuckDB instead of the JS fold.
//
// This is the Phase 1 compute swap. It is deliberately a SIDECAR, not a
// replacement: `applyPipeline` calls `runOnDuckDb` first and falls back to the
// existing fold whenever this module returns null. Every guard, every warning
// string, and the data-dependent retype pass stay in TypeScript — DuckDB only
// does set-based work over an all-VARCHAR relation.
//
// Why all-VARCHAR: docs/phase-0/06-duckdb-verification.md §2 measured that a
// leading-zero value beyond the CSV sniffer's 20,480-row sample window silently
// becomes an integer (`007` → `7`). Storing text and casting at point of use is
// the one decision that preserves `isFiniteNumber`'s guarantee, reproduces the
// declared-vs-runtime type split in `stepFilter`/`aggregate`, and removes column
// -name injection. TRY_CAST is never used to *decide* a type — only to compare.

import { detectColumnType, coerceValue } from '../data/parse';
import type { ParsedColumn } from '../data/parse';
import type { ApplyResult, Cell, TableData, TransformStep } from '../data/transforms';
import { generateSql, ORD } from './sqlGen';
import type { SqlColumn } from './sqlGen';
import * as duck from './duckdb';
import * as parquetStore from './parquetStore';
import * as trace from './residentTrace';
import type { PipelineContext } from '../data/stepTypes';
import { isNeed, planPower, refOpts } from './pipelinePower';
import type { RunSql } from './pipelinePower';

// ── Why this path is OFF by default ─────────────────────────────────────────
//
// Measured on 100,000 rows × 5 columns (Apple M4, DuckDB 1.5.5):
//
//     loading the rows into DuckDB   1,914 ms   (batch size is irrelevant:
//                                                500 → 1914, 5k → 2073,
//                                                20k → 2558 — the cost is the
//                                                per-row bridge crossing)
//     running the GROUP BY               4 ms
//     the same work in the JS fold      18 ms
//
// The engine is ~4.5x faster than the fold. The *load* is 100x slower than the
// whole fold. So while the data lives in JS arrays and has to be materialised
// per call, routing through DuckDB is a 100-500x regression — the benchmark
// measured 4.7 ms → 2,562 ms for a 100k-row filter.
//
// This is not a tuning problem, it is the phase ordering: the compute swap
// cannot pay off until the data already lives in DuckDB and there is no load
// step at all. That is Phase 2 (Parquet storage). Until then this path stays
// built, tested and proven equivalent — but not enabled.
//
// Set ORDINATE_DUCKDB_PIPELINE=1 to turn it on; tests force it via opts.force.
// ponytail: an env flag, not a config schema entry. Config is user-facing and
// this is a developer switch that should disappear when Phase 2 lands.
const ENABLED = process.env.ORDINATE_DUCKDB_PIPELINE === '1';

// Only used when ENABLED: below this the fold wins even with data resident.
export const DUCKDB_MIN_ROWS = 50_000;


let seq = 0;

function physicalName(i: number): string {
  return `c${i}`;
}

// The relation stores String(cell) with NULL preserved, so a round-trip through
// DuckDB cannot alter a value. `null` and `''` stay distinct, which the fold's
// isEmptyCell relies on.
function toStorage(cell: Cell): string | null {
  return cell == null ? null : String(cell);
}

function buildSchema(columns: ParsedColumn[]): SqlColumn[] {
  return columns.map((c, i) => ({ physical: physicalName(i), name: c.name, type: c.type }));
}

// Map a DuckDB text result back onto Ordinate's Cell union.
//
// This is an INVERSE of toStorage, not a re-parse. Using parse.coerceValue here
// is wrong and was a real bug caught by the differential test: coerceValue maps
// '' → null (parse.ts:219, the ingest rule), so a legitimately-empty text cell
// came back as null and diverged from the fold. Storage already holds exactly
// String(cell) with null preserved, so the inverse is:
//   null            → null
//   text/date       → the string verbatim, '' and whitespace included
//   number          → back to a JS number
// A `number` column's cells were JS numbers before storage, and aggregates are
// CAST(... AS DOUBLE), so Number() round-trips both faithfully. '007' cannot be
// affected: it only ever lives in a text-declared column.
function toCell(raw: string | number | null, type: ParsedColumn['type']): Cell {
  if (raw == null) return null;
  if (type !== 'number') return typeof raw === 'string' ? raw : String(raw);
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(n)) return n;
  // A NON-NUMERIC cell in a number-declared column. Returning null here — which
  // is what this did — silently DELETED the value, while the fold keeps the
  // string and lets the data-dependent retype pass demote the whole column.
  // Caught by scripts/test-pipelineResident.js, not by inspection. Storage holds
  // exactly String(cell), so handing the string back is the faithful inverse;
  // null is only correct when the cell really was null, handled above.
  return typeof raw === 'string' ? raw : null;
}

function retype(columns: ParsedColumn[], rows: Cell[][], c: number): void {
  const strCells = rows.map((r) => (r[c] == null ? '' : String(r[c])));
  const type = detectColumnType(strCells);
  columns[c] = { ...columns[c], type };
  for (const r of rows) r[c] = coerceValue(r[c] ?? null, type);
}

// ── The resident path ────────────────────────────────────────────────────────
//
// Same generated SQL as runOnDuckDb, but the base relation is the stored
// <id>.source.parquet read IN PLACE rather than a table built row by row. That
// removes the load the block above measures — which is the only reason this
// whole module was off by default.
//
// Two facts make the swap almost mechanical, and both are load-bearing:
//
//   1. parquetStore writes columns as the physical c0..cN, which is exactly the
//      naming sqlGen already generates against. No aliasing, no mapping table.
//   2. sqlGen only ever needs the base relation to expose ORD plus those
//      columns, and read_parquet's `file_row_number` is that ordinal — 0-based
//      and in file order, identical to the row index the INSERT path bound.
//
// The ordinal is NOT cosmetic. A bare GROUP BY does not preserve first-seen
// order and whether it reorders is machine-dependent, so sqlGen ends every
// ORDER BY with ORD; feeding it a relation without one would produce a result
// that is correct on this machine and wrong on someone else's.
//
// Nothing is cast here. Casting happens inside sqlGen on the DECLARED
// ColumnType carried in `columns`, never on inference — TRY_CAST('007' AS
// DOUBLE) is 7, and a text column must never meet that.
// THERE IS NO ROW-COUNT FLOOR, and that is a measured result rather than an
// oversight. DUCKDB_MIN_ROWS exists above because the hydrate had to be
// amortised; with the table read in place there is nothing to amortise, so the
// only fixed cost is one bridge round-trip. scripts/bench-prepare.js was run
// down to 200 rows looking for the crossover and did not find one — resident
// beat read+fold at every size, because the caller has to read the Parquet
// either way and the resident path never does:
//
//        rows        read + fold        resident
//         200        4 ms                2 ms
//       1,000        4 ms                1 ms
//      10,000       32 ms                4 ms
//     100,000      326 ms                6 ms
//   1,000,000    2,665 ms               17 ms
//
// A threshold here would be a number with no measurement behind it, which is
// exactly what this repo asks people not to ship. There is deliberately no
// options bag either: with no floor there is nothing for a caller to override,
// and an unused `force` would just invite one to be invented later.

/**
 * Run `steps` over the Parquet at `parquetPath` without materialising it.
 *
 * `columns` must be the record's stored source ParsedColumn[] — the declared
 * types, positionally matching c0..cN in the file.
 *
 * Returns null — "caller must use the JS fold" — for an unexpressible pipeline
 * (every `calculated_field` lands here: sqlGen has no formula->SQL translation),
 * an unavailable bridge, a table small enough that the fold is cheaper, or ANY
 * error. Never throws. transforms.applyPipeline stays the reference.
 */
export function runResidentPipeline(
  parquetPath: string,
  columns: ParsedColumn[],
  steps: TransformStep[],
): ApplyResult | null {
  const op = 'preparePipeline';
  if (!parquetPath || !Array.isArray(columns) || columns.length === 0) {
    trace.record(op, 'skipped');
    return null;
  }
  if (!parquetStore.isSupported()) {
    trace.record(op, 'skipped');
    return null;
  }

  const schema = buildSchema(columns);
  const list = Array.isArray(steps) ? steps : [];
  const probe = generateSql('t', schema, list);
  if (probe.sql === null && !isNeed(probe.unsupported)) {
    // Not a failure: an unexpressible pipeline is the designed exit, and the
    // commonest one (a calculated field) would otherwise warn on every edit.
    trace.record(op, 'skipped');
    return null;
  }

  try {
    // file_row_number is the ordinal sqlGen's ORDER BY ends on. The derived
    // table is aliased because an unaliased one is a parser error in strict
    // mode and costs nothing here.
    const base =
      `(SELECT file_row_number AS ${ORD}, ${schema.map((c) => `"${c.physical}"`).join(', ')} ` +
      `FROM ${parquetStore.relationSql(parquetPath, { fileRowNumber: true })}) AS t`;
    const run: RunSql = (sql, params) => duck.query(sql.replace(/\bFROM\s+"t"/g, `FROM ${base}`), params);
    // Pivot keys and per-step counts are facts about the data (pipelinePower).
    // No union/lookup relations here: those steps bail to the fold, which has them.
    const planned = planPower(schema, list, {}, run);
    if (!planned) {
      trace.record(op, 'skipped');
      return null;
    }
    const gen = planned.gen;
    const out = run(gen.sql as string, gen.params);

    const outColumns: ParsedColumn[] = gen.columns.map((c) => ({ name: c.name, type: c.type }));
    const rows: Cell[][] = out.map((row) =>
      gen.columns.map((c) => toCell(row[c.physical] ?? null, c.type)),
    );

    // Data-dependent typing is not expressible in SQL (phase-0 T2/T18): one
    // non-numeric value demotes a whole column to text and stringifies the
    // rest. That pass stays in TS, over the returned rows.
    for (const physical of gen.retypeColumns) {
      const idx = gen.columns.findIndex((c) => c.physical === physical);
      if (idx >= 0) retype(outColumns, rows, idx);
    }

    trace.record(op, 'resident');
    return { columns: outColumns, rows, rowCount: rows.length, warnings: gen.warnings.slice(), stepCounts: planned.counts };
  } catch (e) {
    // Loud but not fatal: a fast path that silently stops firing is ~600x
    // slower and ships green, which is what residentTrace exists to prevent.
    // The detail names the SHAPE only — this runs over user data.
    trace.record(op, 'failed', `${columns.length} cols, ${steps.length} steps`);
    return null;
  }
}

export interface DuckRunOptions {
  /** Force the DuckDB path regardless of row count (tests + benchmarks). */
  force?: boolean;
  /** The other datasets union/lookup steps read (transforms.applyPipeline's ctx). */
  ctx?: PipelineContext;
}

/**
 * Run `steps` over `source` in DuckDB.
 *
 * Returns null — meaning "caller must use the JS fold" — when the pipeline is
 * not faithfully expressible in SQL, when the bridge is unavailable, when the
 * table is small enough that the fold is cheaper, or on ANY error. Never
 * throws: a failure here must degrade to the working implementation, never to a
 * broken app.
 */
export function runOnDuckDb(
  source: TableData,
  steps: TransformStep[],
  opts: DuckRunOptions = {},
): ApplyResult | null {
  if (!source || !Array.isArray(source.columns) || !Array.isArray(source.rows)) return null;
  if (!opts.force && !ENABLED) return null;
  if (!opts.force && source.rows.length < DUCKDB_MIN_ROWS) return null;
  if (source.columns.length === 0) return null;

  const schema = buildSchema(source.columns);
  const list = Array.isArray(steps) ? steps : [];
  const call = seq++;
  const refs = refOpts(list, opts.ctx, (_id, k) => `sc_ref_${process.pid}_${call}_${k}`);
  const probe = generateSql('t', schema, list, refs.opts);
  if (probe.sql === null && !isNeed(probe.unsupported)) return null;
  if (!duck.isAvailable()) return null;

  const relation = `sc_pipe_${process.pid}_${call}`;
  const created: string[] = [];
  try {
    created.push(relation);
    loadRelation(relation, source);
    for (const l of refs.loads) {
      created.push(l.relation);
      loadRelation(l.relation, (opts.ctx as PipelineContext).tables[l.id]);
    }
    const run: RunSql = (sql, params) => duck.query(sql.replace(/\bFROM\s+"t"/g, `FROM "${relation}"`), params);
    const planned = planPower(schema, list, refs.opts, run);
    if (!planned) return null;
    const gen = planned.gen;
    const out = run(gen.sql as string, gen.params);

    const columns: ParsedColumn[] = gen.columns.map((c) => ({ name: c.name, type: c.type }));
    const rows: Cell[][] = out.map((row) =>
      gen.columns.map((c) => toCell(row[c.physical] ?? null, c.type)),
    );

    // Data-dependent typing is not expressible in SQL (phase-0 T2/T18): a single
    // non-numeric value demotes a whole column to text and stringifies the rest.
    // That pass stays here, over the returned rows.
    for (const physical of gen.retypeColumns) {
      const idx = gen.columns.findIndex((c) => c.physical === physical);
      if (idx >= 0) retype(columns, rows, idx);
    }

    return { columns, rows, rowCount: rows.length, warnings: gen.warnings.slice(), stepCounts: planned.counts };
  } catch {
    // Any failure — bridge death, overflow, malformed SQL — falls back silently.
    // The fold is always correct; this path is only ever an optimisation.
    return null;
  } finally {
    for (const name of created) {
      try {
        duck.exec(`DROP TABLE IF EXISTS "${name}";`);
      } catch {
        /* the relation is per-call and the connection is in-memory; leaking one
           on a dying bridge is not worth masking the original failure. */
      }
    }
  }
}

// One all-VARCHAR relation (ORD + c0..cN) holding `table`. Values are bound,
// never interpolated — a cell is data, and this is a trust boundary.
function loadRelation(relation: string, table: TableData): void {
  const width = table.columns.length;
  const cols = table.columns.map((_, i) => `"${physicalName(i)}" VARCHAR`).join(', ');
  duck.exec(`CREATE TABLE "${relation}" ("${ORD}" BIGINT${cols ? ', ' + cols : ''});`);
  const placeholders = `(${Array(width + 1).fill('?').join(', ')})`;
  const BATCH = 500;
  for (let start = 0; start < table.rows.length; start += BATCH) {
    const end = Math.min(start + BATCH, table.rows.length);
    const params: (string | number | null)[] = [];
    const tuples: string[] = [];
    for (let r = start; r < end; r++) {
      const row = table.rows[r] || [];
      params.push(r);
      for (let c = 0; c < width; c++) params.push(toStorage(row[c] ?? null));
      tuples.push(placeholders);
    }
    duck.query(`INSERT INTO "${relation}" VALUES ${tuples.join(', ')};`, params);
  }
}
