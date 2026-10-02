// Incremental refresh — the MERGE, in DuckDB. MAIN PROCESS.
//
// The stored table (`<id>.parquet`, or `<id>.source.parquet` when a prepare
// pipeline exists) and a fetched batch are merged by one SQL statement over the
// two Parquet files, in place — the stored table is never materialised in JS to
// decide what changes. The rules are src/data/incremental.ts's header, and its
// `mergeJs` is the reference this is differential-tested against with Object.is
// (scripts/test-incrementalMerge.ts).
//
// Order is never assumed (CLAUDE.md): both sides carry `file_row_number`, and
// the result is ordered by (group, ordinal) — stored rows first in their stored
// order, then appended rows in fetch order.
//
// Files: the batch and the merged result are TEMP siblings `<id>.incr-<uuid>.*`
// in the datasets folder (DuckDB is locked to userData, so not os.tmpdir()).
// Both are removed in a `finally`; one left behind by a crash is removed by the
// next run (cleanupTemps). The merged rows are read back and handed to
// datasets.updateDatasetData — the ordinary refresh write, which publishes
// the new `<id>.parquet` (and a NEW `<id>.source.parquet`) by temp-then-rename,
// keeps a snapshot and re-derives the pipeline. Nothing here renames over a
// stored file, so a throw at any point leaves the stored table as it was.

import * as fs from 'fs';
import * as path from 'path';
import * as duck from './duckdb';
import * as parquetStore from './parquetStore';
import { sqlEmpty } from './sqlGen';
import type { ParsedColumn } from '../data/parse';
import type { Cell } from '../data/incremental';

/** Same ceiling as every other dataset write. */
export const MAX_ROWS = 1_000_000;

export interface DuckMergeResult {
  rows: Cell[][];
  inserted: number;
  updated: number;
}

const lit = (p: string): string => `'${p.replace(/'/g, "''")}'`;
const cols = (width: number, q = ''): string[] => Array.from({ length: width }, (_, i) => `${q}"c${i}"`);

/**
 * The merge as one SELECT yielding c0..cN plus `_g` (0 stored, 1 appended),
 * `_ord` and `_chg` (a replaced row whose cells changed). Exported for the test.
 * The batch file carries the cursor key in physical column c<width>.
 */
export function mergeSql(basePath: string, batchPath: string, width: number, keyIndex: number | null): string {
  const c = cols(width);
  const list = c.join(', ');
  const o = `o AS (SELECT ${list}, file_row_number AS _o FROM read_parquet(${lit(basePath)}, file_row_number=true))`;
  const b = `b AS (SELECT ${list}, file_row_number AS _b, TRY_CAST("c${width}" AS DOUBLE) AS _cur `
    + `FROM read_parquet(${lit(batchPath)}, file_row_number=true))`;

  if (keyIndex === null) {
    // Multiset difference: the n-th copy of a row is appended only when the
    // stored table holds fewer than n copies of it.
    const same = c.map((x) => `ob.${x} IS NOT DISTINCT FROM bo.${x}`).join(' AND ');
    return `WITH ${o}, ${b},
      ob AS (SELECT ${list}, row_number() OVER (PARTITION BY ${list} ORDER BY _o) AS _n FROM o),
      bo AS (SELECT ${list}, _b, row_number() OVER (PARTITION BY ${list} ORDER BY _b) AS _n FROM b)
      SELECT ${list}, 0 AS _g, _o AS _ord, false AS _chg FROM o
      UNION ALL
      SELECT ${cols(width, 'bo.').join(', ')}, 1 AS _g, bo._b AS _ord, false AS _chg FROM bo
      WHERE NOT EXISTS (SELECT 1 FROM ob WHERE ${same} AND ob._n = bo._n)`;
  }

  const k = `"c${keyIndex}"`;
  const pick = c.map((x) => `CASE WHEN w._b IS NULL THEN o.${x} ELSE w.${x} END AS ${x}`).join(', ');
  const changed = c.map((x) => `o.${x} IS DISTINCT FROM w.${x}`).join(' OR ');
  // An EMPTY key (null, '' or whitespace, as isEmptyCell) is no identity: those
  // rows take the append rule against the stored empty-key rows (oe/be).
  const sameE = c.map((x) => `oe.${x} IS NOT DISTINCT FROM be.${x}`).join(' AND ');
  // The winner per key: greatest cursor, then the LATER fetched row.
  return `WITH ${o}, ${b},
    w AS (SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY ${k} ORDER BY _cur DESC NULLS LAST, _b DESC) AS _rn FROM b WHERE NOT ${sqlEmpty(k)}) WHERE _rn = 1),
    f AS (SELECT ${k} AS _k, min(_o) AS _f FROM o WHERE NOT ${sqlEmpty(k)} GROUP BY ${k}),
    oe AS (SELECT ${list}, row_number() OVER (PARTITION BY ${list} ORDER BY _o) AS _n FROM o WHERE ${sqlEmpty(k)}),
    be AS (SELECT ${list}, _b, row_number() OVER (PARTITION BY ${list} ORDER BY _b) AS _n FROM b WHERE ${sqlEmpty(k)})
    SELECT ${pick}, 0 AS _g, o._o AS _ord, (w._b IS NOT NULL AND (${changed})) AS _chg
    FROM o LEFT JOIN w ON o.${k} IS NOT DISTINCT FROM w.${k} LEFT JOIN f ON o.${k} IS NOT DISTINCT FROM f._k
    WHERE w._b IS NULL OR o._o = f._f
    UNION ALL
    SELECT ${cols(width, 'w.').join(', ')}, 1 AS _g, w._b AS _ord, false AS _chg FROM w
    WHERE NOT EXISTS (SELECT 1 FROM o WHERE o.${k} IS NOT DISTINCT FROM w.${k})
    UNION ALL
    SELECT ${cols(width, 'be.').join(', ')}, 1 AS _g, be._b AS _ord, false AS _chg FROM be
    WHERE NOT EXISTS (SELECT 1 FROM oe WHERE ${sameE} AND oe._n = be._n)`;
}

/** Remove any `<id>.incr-*` temp a crashed run left in `dir`. Never throws. */
export function cleanupTemps(dir: string, id: string): number {
  let removed = 0;
  try {
    for (const n of fs.readdirSync(dir)) {
      if (!n.startsWith(`${id}.incr-`)) continue;
      try {
        fs.rmSync(path.join(dir, n), { force: true });
        removed++;
      } catch { /* next run */ }
    }
  } catch { /* no folder yet */ }
  return removed;
}

/** A unique temp stem for one run, in the datasets folder. */
export function tempStem(dir: string, id: string, unique: string): string {
  return path.join(dir, `${id}.incr-${unique}`);
}

/**
 * Merge `batch` (typed to `columns`, with each row's cursor key) into the stored
 * Parquet at `basePath`. Throws on any failure, and when the result would pass
 * the row cap — an incremental run never silently drops the newest rows.
 */
export async function mergeInDuck(opts: {
  basePath: string;
  columns: ParsedColumn[];
  batch: Cell[][];
  keys: number[];
  keyIndex: number | null;
  stem: string;
}): Promise<DuckMergeResult> {
  const width = opts.columns.length;
  const batchPath = `${opts.stem}.batch.parquet`;
  const mergedPath = `${opts.stem}.merged.parquet`;
  try {
    const wide: ParsedColumn[] = opts.columns.concat({ name: '_cursor', type: 'text' });
    await parquetStore.writeTableAsync(batchPath, wide, opts.batch.map((r, i) => r.concat(String(opts.keys[i]))));
    const merged = mergeSql(opts.basePath, batchPath, width, opts.keyIndex);
    const stats = (await duck.queryAsync(
      `SELECT CAST(count(*) AS DOUBLE) AS n, CAST(sum(CASE WHEN _g = 1 THEN 1 ELSE 0 END) AS DOUBLE) AS ins, `
      + `CAST(sum(CASE WHEN _chg THEN 1 ELSE 0 END) AS DOUBLE) AS upd FROM (${merged}) m;`,
    ))[0] || {};
    const n = Number(stats.n) || 0;
    if (n > MAX_ROWS) {
      throw new Error(`This refresh would take the dataset to ${n.toLocaleString('en-US')} rows, past the `
        + `${MAX_ROWS.toLocaleString('en-US')}-row limit, so it was left unchanged.`);
    }
    await duck.execAsync(`COPY (SELECT ${cols(width).join(', ')} FROM (${merged}) m ORDER BY _g, _ord) `
      + `TO ${lit(mergedPath)} (FORMAT PARQUET, COMPRESSION ZSTD);`);
    const table = await parquetStore.readTableAsync(mergedPath, opts.columns);
    if (!table) throw new Error('Could not read the merged table back.');
    return { rows: table.rows, inserted: Number(stats.ins) || 0, updated: Number(stats.upd) || 0 };
  } finally {
    fs.rmSync(batchPath, { force: true });
    fs.rmSync(mergedPath, { force: true });
  }
}
