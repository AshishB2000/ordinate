// One column's median, straight off the stored `.parquet` — MAIN PROCESS.
//
// The resident twin of `data/columnProfile.medianOf`. The column-profile panel
// asks for this on a header click, and a header click must not hydrate a
// million rows into main's heap to sort them.
//
// TWO NULLS, AND THEY MEAN DIFFERENT THINGS. Everywhere else in this layer a
// bare `null` means "fall back", and "no data" is expressible some other way.
// Here the distinction is load-bearing: an all-empty numeric column HAS no
// median, and answering that with a fallback would hydrate the whole table only
// for the JS reference to reach the same `null`. So the success shape is
// `{ value: number | null }` — `value: null` is the real answer "no finite
// cells" — and only the function itself returning `null` means "fall back".
//
// QUANTILE INTERPOLATION. `quantile_cont`, NOT `quantile` / `quantile_disc` /
// `median`. `quantile()` is an ALIAS for the DISCRETE form and returns a value
// from the data rather than interpolating between two — a different number.
// `quantile_cont` is the type-7 linear interpolation `analysis/anomalies.quantile`
// implements, and this repo has already verified the two agree on 800 random
// samples (see the header of `engine/anomaliesResident.ts`). They can still
// differ in the last ULP, for the reason recorded there: the two evaluate an
// algebraically equal expression in a different order. That is the same pinned
// divergence the anomaly detector lives with, and it is well below anything a
// rendered figure shows.

import type { ParsedColumn } from '../data/parse';
import { relationSql } from './parquetStore';
import * as duck from './duckdb';

export interface MedianSource {
  /** Absolute path to the dataset's `.parquet` file. */
  parquetPath: string;
  /**
   * The record's stored `ParsedColumn[]`, POSITIONALLY ALIGNED to the file —
   * the same contract `parquetStore.readTable(path, schema)`,
   * `statsResident.StatsSource` and `datasets.residentSource` take.
   */
  columns: ParsedColumn[];
}

/**
 * The median of `column`'s finite numeric cells.
 *
 * Returns `null` — never throws — when the bridge is unavailable, the column is
 * unknown, it is not DECLARED `number`, or the query fails. Returns
 * `{ value: null }` when the column is real but has no finite numeric cell.
 *
 * Cast on the DECLARED type only, like every other aggregate here:
 * `TRY_CAST('007' AS DOUBLE)` is 7, so reading a text column numerically would
 * turn a zero-padded id into arithmetic. A non-number column is a fallback, and
 * the JS reference returns `null` for it too.
 */
export async function medianResident(src: MedianSource, column: string): Promise<{ value: number | null } | null> {
  try {
    if (!src || typeof src.parquetPath !== 'string' || !Array.isArray(src.columns)) return null;
    const ci = src.columns.findIndex((c) => c && typeof c.name === 'string' && c.name === column);
    if (ci < 0) return null;
    if (src.columns[ci].type !== 'number') return null;
    if (!duck.isAvailable()) return null;

    // Physical names are positional `c0..cN`, the same contract `sqlGen.ts`,
    // `parquetStore.ts` and `residentQuery.ts` use. The user-facing column name
    // never reaches SQL, so identifier quoting, duplicate names and name
    // injection are all structurally out of reach; the only user-influenced
    // text is the path, which `relationSql` validates and escapes.
    const n = `CASE WHEN isfinite(TRY_CAST(c${ci} AS DOUBLE)) THEN TRY_CAST(c${ci} AS DOUBLE) END`;
    // CAST(... AS DOUBLE) like every aggregate in this layer: an un-cast
    // aggregate over an INTEGER is HUGEINT and reaches JS as a BigInt.
    const sql = `SELECT CAST(quantile_cont(${n}, 0.5) AS DOUBLE) AS m FROM ${relationSql(src.parquetPath)};`;

    const rows = await duck.queryAsync(sql);
    // No GROUP BY, so a global aggregate always returns exactly one row. Any
    // other shape is an internally inconsistent answer, which is a fallback.
    if (rows.length !== 1) return null;

    const raw = rows[0].m;
    if (raw == null) return { value: null }; // no finite cells — a real answer
    const v = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(v) ? { value: v } : null;
  } catch {
    // Bridge down, missing file, non-Parquet bytes, width mismatch — one
    // answer: the caller keeps its working JS path.
    return null;
  }
}
