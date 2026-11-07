// Count distinct non-empty values (semantic layer part 5, D1) in SQL: the resident twin of
// src/analysis/countDistinct.ts (the reference), held to it with Object.is by scripts/test-countDistinct.ts.

import type { ColumnType } from '../data/parse';
import { sqlNum } from './residentCategory';
import { sqlPeriodDate } from './periodSql';
import { sqlEmpty } from './sqlGen';

/** The aggregate over physical column `p` of a column declared `type`. */
export function countDistinctSql(p: string, type: ColumnType): string {
  // `+ 0.0`: -0.0 + 0.0 is +0.0 in IEEE 754, so signed zero is never left to DuckDB's DISTINCT.
  const key = type === 'number' ? `${sqlNum(p)} + 0.0` : type === 'date' ? sqlPeriodDate(p) : `CASE WHEN NOT ${sqlEmpty(p)} THEN ${p} END`;
  return `CAST(count(DISTINCT ${key}) AS DOUBLE)`;
}
