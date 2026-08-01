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

import { detectColumnType, coerceValue } from './parse';
import type { ParsedColumn } from './parse';
import type { ApplyResult, Cell, TableData, TransformStep } from './transforms';
import { generateSql, ORD } from './sqlGen';
import type { SqlColumn } from './sqlGen';
import * as duck from './duckdb';

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
  return Number.isFinite(n) ? n : null;
}

function retype(columns: ParsedColumn[], rows: Cell[][], c: number): void {
  const strCells = rows.map((r) => (r[c] == null ? '' : String(r[c])));
  const type = detectColumnType(strCells);
  columns[c] = { ...columns[c], type };
  for (const r of rows) r[c] = coerceValue(r[c] ?? null, type);
}

export interface DuckRunOptions {
  /** Force the DuckDB path regardless of row count (tests + benchmarks). */
  force?: boolean;
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
  const gen = generateSql('t', schema, Array.isArray(steps) ? steps : []);
  if (gen.sql === null) return null;
  if (!duck.isAvailable()) return null;

  const relation = `sc_pipe_${process.pid}_${seq++}`;
  try {
    const cols = schema.map((c) => `"${c.physical}" VARCHAR`).join(', ');
    duck.exec(`CREATE TABLE "${relation}" ("${ORD}" BIGINT, ${cols});`);

    // Insert via a single prepared statement per row batch. Values are bound,
    // never interpolated — a cell is data, and this is a trust boundary.
    const width = schema.length;
    const placeholders = `(${Array(width + 1).fill('?').join(', ')})`;
    const BATCH = 500;
    for (let start = 0; start < source.rows.length; start += BATCH) {
      const end = Math.min(start + BATCH, source.rows.length);
      const params: (string | number | null)[] = [];
      const tuples: string[] = [];
      for (let r = start; r < end; r++) {
        const row = source.rows[r] || [];
        params.push(r);
        for (let c = 0; c < width; c++) params.push(toStorage(row[c] ?? null));
        tuples.push(placeholders);
      }
      duck.query(`INSERT INTO "${relation}" VALUES ${tuples.join(', ')};`, params);
    }

    const sql = gen.sql.replace(/\bFROM\s+"t"/g, `FROM "${relation}"`);
    const out = duck.query(sql, gen.params);

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

    return { columns, rows, rowCount: rows.length, warnings: gen.warnings.slice() };
  } catch {
    // Any failure — bridge death, overflow, malformed SQL — falls back silently.
    // The fold is always correct; this path is only ever an optimisation.
    return null;
  } finally {
    try {
      duck.exec(`DROP TABLE IF EXISTS "${relation}";`);
    } catch {
      /* the relation is per-call and the connection is in-memory; leaking one
         on a dying bridge is not worth masking the original failure. */
    }
  }
}
