// The DuckDB dialect — the live compiler's TEST BENCH (docs/live-data/00-plan.md
// L2.2). scripts/test-liveParity.ts runs every compiled statement on DuckDB
// through the existing async bridge and compares the answer with the extract
// path, so CI proves the compiler without a warehouse. It is registered on no
// connector in production; the L2.6 e2e uses it behind a test-only fake.
//
// Spelled to match the resident layer wherever the two meet (`isfinite` over
// TRY_CAST, `date_trunc` being Monday-based, `regexp_full_match` with `\x{…}`
// escapes), with one deliberate difference: the empty class is JS `trim()`'s in
// full (../dialect.ts JS_WHITESPACE), not `sqlGen.WS_CLASS`.

import type { LiveParam } from '../../../connectors/types';
import type { SqlDialect } from '../dialect';
import { WS_REGEX_CLASS, doubleQuoted, sqlInt } from '../dialect';

const TYPE: Record<LiveParam['type'], string> = {
  text: 'VARCHAR', number: 'DOUBLE', boolean: 'BOOLEAN', date: 'DATE', timestamp: 'TIMESTAMP',
};

const BOM = 'chr(65279)';

export const duckdbDialect: SqlDialect = {
  id: 'duckdb',
  ident: doubleQuoted,
  placeholder: (i, p) => `CAST($${i + 1} AS ${TYPE[p.type]})`,
  toDouble: (x) => `CAST(${x} AS DOUBLE)`,
  toInt: (x) => `CAST(${x} AS INTEGER)`,
  text: (c) => `CAST(${c} AS VARCHAR)`,
  // TRY_CAST accepts any input type here, so the storage is irrelevant.
  number: (c) => {
    const v = `TRY_CAST(${c} AS DOUBLE)`;
    return `CASE WHEN isfinite(${v}) THEN ${v} END`;
  },
  date: (c) => `TRY_CAST(${c} AS DATE)`,
  isoDay: (d) => `strftime(${d}, '%Y-%m-%d')`,
  // The INTEGER cast keeps the id a JS number (a BIGINT crosses the bridge as a string).
  epochDay: (d) => `CAST(date_diff('day', DATE '1970-01-01', ${d}) AS INTEGER)`,
  // DuckDB's week is ISO: date_trunc('week', …) is a Monday.
  trunc: (d, unit) => `CAST(date_trunc('${unit}', ${d}) AS DATE)`,
  blank: (x) => `(${x} IS NULL OR regexp_full_match(${x}, '[${WS_REGEX_CLASS}]*'))`,
  like: (x, p) => `${x} LIKE ${p} ESCAPE '!'`,
  likeEscape: '!',
  // @duckdb/node-api drops ONE leading U+FEFF from every string it returns
  // (src/engine/duckdb.ts). Doubling a leading BOM at projection is its exact
  // inverse — the same fix as residentCategory.bomSafe. A warehouse's HTTP
  // transport has no such loss, so the other dialects project labels as they are.
  label: (x) => `CASE WHEN starts_with(${x}, ${BOM}) THEN ${BOM} || ${x} ELSE ${x} END`,
  // Reservoir sampling: exactly `rows` rows, or every row of a smaller table.
  tableSample: (plan) => `USING SAMPLE ${sqlInt(plan.rows)} ROWS`,
};
