// A Live dataset's columns, DECLARED from the warehouse's own types
// (docs/live-data/00-plan.md L2.1) — MAIN PROCESS, pure.
//
// An extract types a column from its VALUES (parse.ts: `007` stays text, a
// 16-digit id stays text). A Live dataset has no values to look at, and the
// resident layer's first rule — "cast on the DECLARED type, never inference" —
// is the one Live leans on hardest: the compiler casts a `number` column and
// refuses `sum` over a `text` one. So the type comes from the catalog, through
// one table per dialect, and anything a table does not name is TEXT: the safe
// direction, because summing a mistyped text column is a loud compile-time
// refusal while summing a mistyped number column is a wrong figure.
//
// A connector that already declares the column (`columnType`, set only from
// the source's own schema — types.ts) wins over the table.
//
// Booleans map to text, as an extract stores `true`/`false`; time-of-day,
// intervals, binary and structured types are text too.

import type { ColumnType, ParsedColumn } from './parse';
import type { LiveDialectId } from '../connectors/types';

interface TypeTable {
  number: ReadonlySet<string>;
  date: ReadonlySet<string>;
}

const set = (...names: string[]): ReadonlySet<string> => new Set(names);

/** Base type names (lower case, parameters and wrappers removed) per dialect. */
const TABLES: Readonly<Record<LiveDialectId, TypeTable>> = {
  // information_schema.data_type spellings and pg's OID names (a query's result columns).
  redshift: {
    number: set('smallint', 'integer', 'bigint', 'int', 'int2', 'int4', 'int8', 'numeric', 'decimal', 'real', 'float4',
      'double precision', 'float8', 'float'),
    date: set('date', 'timestamp', 'timestamp without time zone', 'timestamp with time zone', 'timestamptz'),
  },
  // Databricks `type_text` / `type_name`.
  databricks: {
    number: set('tinyint', 'byte', 'smallint', 'short', 'int', 'integer', 'bigint', 'long', 'float', 'real', 'double',
      'decimal', 'dec', 'numeric'),
    date: set('date', 'timestamp', 'timestamp_ntz', 'timestamp_ltz'),
  },
  // ClickHouse, after Nullable(…) / LowCardinality(…) are unwrapped.
  clickhouse: {
    number: set('int8', 'int16', 'int32', 'int64', 'int128', 'int256', 'uint8', 'uint16', 'uint32', 'uint64', 'uint128',
      'uint256', 'float32', 'float64', 'bfloat16', 'decimal', 'decimal32', 'decimal64', 'decimal128', 'decimal256'),
    date: set('date', 'date32', 'datetime', 'datetime64'),
  },
  // Snowflake DDL names and the SQL API's rowType names (`fixed`, `real`, `timestamp_*`).
  snowflake: {
    number: set('number', 'decimal', 'numeric', 'int', 'integer', 'bigint', 'smallint', 'tinyint', 'byteint', 'fixed',
      'float', 'float4', 'float8', 'double', 'double precision', 'real'),
    date: set('date', 'datetime', 'timestamp', 'timestamp_ltz', 'timestamp_ntz', 'timestamp_tz'),
  },
  // BigQuery standard SQL (and the legacy aliases its schema API still reports).
  bigquery: {
    number: set('int64', 'integer', 'int', 'smallint', 'bigint', 'tinyint', 'byteint', 'numeric', 'bignumeric', 'decimal',
      'bigdecimal', 'float64', 'float'),
    date: set('date', 'datetime', 'timestamp'),
  },
  // DuckDB — the test bench's fake warehouse only (scripts/liveFakeConnector.ts). HUGEINT and
  // the unsigned 64-bit types can exceed a double's exact range, so they stay text, as a 16+ digit id does.
  duckdb: {
    number: set('tinyint', 'smallint', 'integer', 'int', 'bigint', 'utinyint', 'usmallint', 'uinteger', 'float', 'real',
      'double', 'decimal', 'numeric'),
    date: set('date', 'timestamp', 'timestamp with time zone', 'timestamptz'),
  },
};

/** `Nullable(LowCardinality(String))` → `string`; `numeric(18,2)` → `numeric`; `timestamp(3) with time zone` → `timestamp with time zone`. */
export function baseTypeName(sourceType: string): string {
  let t = String(sourceType || '').trim().toLowerCase();
  for (let i = 0; i < 4; i++) {
    const m = /^(nullable|lowcardinality)\((.*)\)$/.exec(t);
    if (!m) break;
    t = m[2].trim();
  }
  return t.replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

/** The declared ColumnType of one warehouse type in one dialect. Unknown → text. */
export function liveColumnType(dialect: LiveDialectId, sourceType: string): ColumnType {
  const table = TABLES[dialect];
  if (!table) return 'text';
  const base = baseTypeName(sourceType);
  if (table.number.has(base)) return 'number';
  if (table.date.has(base)) return 'date';
  return 'text';
}

/** One column as a catalog or a result header reports it. */
export interface SourceColumn {
  name: string;
  type: string;
  columnType?: ColumnType;
}

/**
 * The columns a Live record stores, or the name of the problem: none at all,
 * an empty name, or two columns of one name (a Live query names what it reads
 * by column name, so two alike could not be told apart).
 */
export function liveColumns(
  dialect: LiveDialectId,
  cols: readonly SourceColumn[],
): { ok: true; columns: ParsedColumn[] } | { ok: false; reason: 'none' } | { ok: false; reason: 'duplicate'; name: string } {
  if (!cols.length) return { ok: false, reason: 'none' };
  const seen = new Set<string>();
  const columns: ParsedColumn[] = [];
  for (const c of cols) {
    const name = String(c.name ?? '');
    if (!name.trim()) return { ok: false, reason: 'none' };
    if (seen.has(name)) return { ok: false, reason: 'duplicate', name };
    seen.add(name);
    const declared = c.columnType === 'text' || c.columnType === 'number' || c.columnType === 'date' ? c.columnType : undefined;
    columns.push({ name, type: declared ?? liveColumnType(dialect, c.type) });
  }
  return { ok: true, columns };
}
