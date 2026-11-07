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

/** The message a period predicate raises on a cell only JS can read. */
export const PERIOD_DECLINE = 'period filter: a date cell SQL cannot read';

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
 * are bound parameters, pushed in the order they appear. `empty` is the
 * caller's `sqlGen.sqlEmpty(p)` (passed in: sqlGen imports this file).
 *
 * A non-empty cell of neither shape ("Mar 5, 2024") is read by `Date.parse` in
 * JS (`dateIntel.periodFilterDay`, as a date axis reads it), which SQL has not:
 * such a row RAISES, so the resident path declines and the JS fold answers.
 */
export function sqlPeriodPredicate(p: string, r: DateRange, params: DuckValue[], empty: string): string {
  const v = `CAST(${p} AS VARCHAR)`;
  const odd = `NOT ${empty} AND NOT regexp_matches(${v}, '${PERIOD_ISO_RE}') AND NOT regexp_matches(${v}, '${PERIOD_US_RE}')`;
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
  return `CASE WHEN ${odd} THEN error('${PERIOD_DECLINE}') ELSE coalesce(${parts.join(' AND ')}, FALSE) END`;
}
