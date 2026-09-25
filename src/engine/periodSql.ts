// The `period` filter as SQL — PURE, builds strings, queries nothing.
//
// A leaf shared by the two compilers that evaluate a period filter over stored
// VARCHAR cells: `residentQuery.filterPredicate` (query time) and
// `sqlGen.generateSql` (the prepare pipeline). Both must read a date EXACTLY as
// `dateIntel.periodDay` does, so the shapes are the SAME regex text, and the
// civil-date check is TRY_CAST — NULL for 2023-02-31, where periodDay's
// round-trip rejects the same non-date.
//
// Its own file because sqlGen cannot import residentCategory (which imports
// sqlGen), and this is the one piece both need.

import { PERIOD_ISO_RE, PERIOD_US_RE } from '../analysis/dateIntel';
import type { DateRange } from '../analysis/dateIntel';
import type { DuckValue } from './duckdb';

/**
 * One regex shape → an ISO string → DATE. A non-match makes regexp_extract
 * return '', nullif turns that into NULL and `||` propagates it — so any other
 * shape yields NULL without a match test of its own.
 */
export function shapeDate(v: string, re: string, y: number, m: number, d: number): string {
  return (
    `TRY_CAST(nullif(regexp_extract(${v}, '${re}', ${y}), '') || '-' || ` +
    `lpad(regexp_extract(${v}, '${re}', ${m}), 2, '0') || '-' || ` +
    `lpad(regexp_extract(${v}, '${re}', ${d}), 2, '0') AS DATE)`
  );
}

/** `dateIntel.periodDay` in SQL: a DATE for the two period shapes (a time may follow), else NULL. */
export function sqlPeriodDate(p: string): string {
  const v = `CAST(${p} AS VARCHAR)`;
  return `coalesce(${shapeDate(v, PERIOD_ISO_RE, 1, 2, 3)}, ${shapeDate(v, PERIOD_US_RE, 3, 1, 2)})`;
}

/**
 * A resolved range as a never-NULL predicate on physical column `p`. The bounds
 * are bound parameters, pushed in the order they appear.
 */
export function sqlPeriodPredicate(p: string, r: DateRange, params: DuckValue[]): string {
  const d = sqlPeriodDate(p);
  const parts = [`${d} IS NOT NULL`];
  if (r.from) {
    parts.push(`${d} >= CAST(? AS DATE)`);
    params.push(r.from);
  }
  if (r.to) {
    parts.push(`${d} <= CAST(? AS DATE)`);
    params.push(r.to);
  }
  return `coalesce(${parts.join(' AND ')}, FALSE)`;
}
