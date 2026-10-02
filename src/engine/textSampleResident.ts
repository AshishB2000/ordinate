// A text column's first N filled values, straight off the stored `.parquet` —
// MAIN PROCESS. The resident twin of analysis/text/textProfile.textSampleOf:
// the column profile's "Text" section reads its sample here on a header click,
// and a header click must not hydrate a million rows into main's heap.
//
// The rules of this layer, each load-bearing:
//   · ORDER IS NEVER ASSUMED. "The first N" is by `file_row_number`, the stored
//     row order the JS reference walks — a bare scan does not promise one.
//   · EMPTY is null OR '' OR whitespace — JS's trim() class, the reference's:
//     sqlGen.sqlEmpty filters in SQL, and the few rarer spaces its class lacks
//     are dropped after (see below), so both sides skip the same cells.
//   · DECLARED type only: a column not declared `text` is a fall-back (null),
//     and the JS reference answers null for it too.
//   · A leading U+FEFF is lost by the bridge on every returned string, so the
//     projection doubles it (residentCategory.bomSafe) — an exact inverse.
//   · Async: this answers an IPC call, and a blocking query freezes every window.
// Returns null — never throws — on any failure; the caller then hydrates.

import type { ParsedColumn } from '../data/parse';
import { relationSql } from './parquetStore';
import { sqlEmpty } from './sqlGen';
import { bomSafe, phys } from './residentCategory';
import * as duck from './duckdb';

export interface TextSampleSource {
  parquetPath: string;
  /** The record's stored columns, positionally aligned to the file's c0..cN. */
  columns: ParsedColumn[];
}

export async function textSampleResident(src: TextSampleSource, column: string, limit: number): Promise<string[] | null> {
  try {
    if (!src || typeof src.parquetPath !== 'string' || !Array.isArray(src.columns)) return null;
    const ci = src.columns.findIndex((c) => c && c.name === column);
    if (ci < 0 || src.columns[ci].type !== 'text') return null;
    const n = Math.floor(limit);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) return null;
    if (!duck.isAvailable()) return null;
    const p = phys(ci);
    // sqlEmpty's class is sqlGen's, which (documented there and in
    // qualityRules) omits the rarer Unicode spaces JS trim() strips — U+2000…,
    // U+3000. The reference is JS, so those cells are dropped here too, and the
    // query asks again for as many more rows as were dropped: exact, and a
    // second round trip only when such a cell exists at all.
    let want = n;
    for (let round = 0; round < 8; round += 1) {
      const sql =
        `SELECT ${bomSafe(p)} AS v FROM ${relationSql(src.parquetPath, { fileRowNumber: true })} ` +
        `WHERE NOT ${sqlEmpty(p)} ORDER BY file_row_number LIMIT ${want};`;
      const rows = await duck.queryAsync(sql);
      const out: string[] = [];
      for (const r of rows) {
        if (typeof r.v !== 'string') return null; // a non-string here is an inconsistent answer
        if (r.v.trim() !== '') out.push(r.v);
      }
      if (out.length >= n || rows.length < want) return out.slice(0, n);
      want += n - out.length;
    }
    return null;
  } catch {
    return null;
  }
}
