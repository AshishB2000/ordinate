'use strict';

// lookupResident — the distinct KEYS of one column, read straight off a
// dataset's Parquet. MAIN PROCESS ONLY. Never throws: null means "fall back".
//
// An input table's lookup column (and a `references` quality rule) asks "is this
// value one of that dataset's keys?". The key dataset can be any stored dataset
// — a million rows of sales — so its keys are read here in place, and the
// membership test runs in JS over the answer (src/data/inputTable/validate.ts,
// through the quality rules' own `references` evaluator).
//
// ── What it must reproduce, exactly ──────────────────────────────────────────
// `lookupKeysResident(src, col)` ≡ `lookupKeysJs(src.columns, rows, col)`
// (src/data/inputTable/lookup.ts) where `rows` is the hydrated table — the same
// keys, as the same JS values, in the same FIRST-SEEN order.
// `scripts/test-inputLookup.ts` asserts it with `Object.is` per key.
//
//   · CAST ON THE DECLARED TYPE. A number column keys on a finite DOUBLE
//     (`qualityRules.cellKey`: `1` and `1.0` are one key); a text or date column
//     on the stored text verbatim — `007` stays `007`.
//   · EMPTY (`sqlEmpty`, or "not a finite number" for a number column) is never
//     a key.
//   · ORDER IS NEVER ASSUMED: each key's first file ordinal is carried and the
//     result is ordered by it — a bare GROUP BY keeps no order at all.
//   · A leading U+FEFF survives the bridge through `bomSafe`.

import type { ParsedColumn } from '../data/parse';
import { phys, sqlNum, bomSafe, toCell } from './residentCategory';
import { sqlEmpty } from './sqlGen';
import { relationSql } from './parquetStore';
import * as duck from './duckdb';

export interface KeySource {
  parquetPath: string;
  columns: ParsedColumn[];
}

/** First-seen distinct non-empty keys of `column`, off the bridge's async side. */
export async function lookupKeysResident(src: KeySource, column: string): Promise<Array<string | number> | null> {
  try {
    const ci = src.columns.findIndex((c) => c && c.name === column);
    if (ci < 0) return null;
    const type = src.columns[ci].type;
    const p = phys(ci);
    const key = type === 'number' ? sqlNum(p) : `CASE WHEN ${sqlEmpty(p)} THEN NULL ELSE ${bomSafe(p)} END`;
    const from = relationSql(src.parquetPath, { fileRowNumber: true });
    const sql =
      `SELECT k FROM (SELECT ${key} AS k, MIN(file_row_number) AS o FROM ${from} GROUP BY 1) ` +
      'WHERE k IS NOT NULL ORDER BY o;';
    const rows = await duck.queryAsync(sql);
    const out: Array<string | number> = [];
    for (const r of rows) {
      const k = toCell(r.k ?? null, type);
      if (k !== null) out.push(k);
    }
    return out;
  } catch {
    return null;
  }
}
