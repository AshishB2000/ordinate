// The key check over the stored Parquet — the SQL twin of analysis/keyCheck.ts, held to `Object.is`
// agreement by scripts/test-keyCheck.ts. MAIN PROCESS. Returns null on any failure; the caller falls
// back to the JS reference. The path reaches SQL only through `parquetStore.relationSql`, the key
// only as positional `c<i>` through `joinResident.keySql`.

import type { ParsedColumn } from '../data/parse';
import { keyCheckFromRow } from '../analysis/keyCheck';
import type { KeyCheckCounts } from '../analysis/keyCheck';
import { keySql } from './joinResident';
import { relationSql } from './parquetStore';
import * as duck from './duckdb';

export async function keyCheckResident(
  src: { parquetPath: string; index: number; type: ParsedColumn['type'] },
): Promise<KeyCheckCounts | null> {
  try {
    const k = keySql(`c${src.index}`, src.type);
    const out = await duck.queryAsync(
      `SELECT CAST(SUM(n) AS DOUBLE), ` +
        `CAST(SUM(CASE WHEN k IS NULL THEN n ELSE 0 END) AS DOUBLE), ` +
        `CAST(SUM(CASE WHEN k IS NOT NULL AND n > 1 THEN 1 ELSE 0 END) AS DOUBLE) ` +
        `FROM (SELECT ${k} AS k, count(*) AS n FROM ${relationSql(src.parquetPath)} GROUP BY 1);`,
    );
    return keyCheckFromRow(out[0] && Object.values(out[0]));
  } catch (_) {
    return null;
  }
}
