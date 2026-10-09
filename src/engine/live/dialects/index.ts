// The dialect registry — one entry per id, the same discipline as the
// connector registry (never a union spelled out at call sites).

import type { CompileDialectId, SqlDialect } from '../dialect';
import { bigqueryDialect } from './bigquery';
import { clickhouseDialect } from './clickhouse';
import { databricksDialect } from './databricks';
import { duckdbDialect } from './duckdb';
import { redshiftDialect } from './redshift';
import { snowflakeDialect } from './snowflake';

const DIALECTS: Record<CompileDialectId, SqlDialect> = {
  snowflake: snowflakeDialect,
  bigquery: bigqueryDialect,
  redshift: redshiftDialect,
  databricks: databricksDialect,
  clickhouse: clickhouseDialect,
  duckdb: duckdbDialect,
};

export const DIALECT_IDS = Object.keys(DIALECTS) as CompileDialectId[];

export function dialectFor(id: CompileDialectId | SqlDialect): SqlDialect {
  return typeof id === 'string' ? DIALECTS[id] : id;
}
