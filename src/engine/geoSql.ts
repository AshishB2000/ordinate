// Distance in SQL — the haversine and the `within_km` radius predicate, the
// twins of src/analysis/geo/haversine.ts and radius.ts. MAIN PROCESS, a LEAF:
// residentQuery.filterPredicate calls in here, and nothing here calls back.
//
// Operation for operation the JS expression, with the constants (degrees →
// radians, the Earth radius, the centre) bound as the SAME doubles rather than
// re-derived, so the only difference left is the trig itself: DuckDB's
// sin/cos/asin are the platform libm's, V8's are its own, and they can differ
// in the last bit (measured on a few percent of inputs). Two engines'
// distances therefore agree to ~1e-12 km, not bit for bit;
// scripts/test-geoRadius.ts pins that bound and holds the radius filter's ROWS
// equal.

import type { ParsedColumn } from '../data/parse';
import type { FilterStep } from '../data/transforms';
import type * as duck from './duckdb';
import { DEG } from '../analysis/geo/mercator';
import { EARTH_RADIUS_KM } from '../analysis/geo/haversine';
import { phys, sqlNum } from './residentCategory';

/**
 * A SQL expression that binds its own parameters as it is SPELLED. The
 * haversine names each sine twice, and a `?` spelled twice needs its value
 * pushed twice — so an expression is generated at each place it appears, in
 * text order, and `params` lines up with the placeholders by construction.
 */
export type SqlExpr = () => string;

export function sqlBind(params: duck.DuckValue[], v: number): SqlExpr {
  return () => { params.push(v); return 'CAST(? AS DOUBLE)'; };
}

/** Haversine km between (la1, lo1) and (la2, lo2), all DOUBLE degrees. */
export function sqlHaversine(la1: SqlExpr, lo1: SqlExpr, la2: SqlExpr, lo2: SqlExpr, params: duck.DuckValue[]): string {
  const deg = sqlBind(params, DEG);
  const s1 = (): string => `sin(((${la2()}) - (${la1()})) * ${deg()} / 2)`;
  const s2 = (): string => `sin(((${lo2()}) - (${lo1()})) * ${deg()} / 2)`;
  const c1 = (): string => `cos((${la1()}) * ${deg()})`;
  const c2 = (): string => `cos((${la2()}) * ${deg()})`;
  // `2 * R * asin(min(1, sqrt(s1 * s1 + c1 * c2 * s2 * s2)))`, left to right,
  // exactly as haversine.ts evaluates it.
  return `2 * ${sqlBind(params, EARTH_RADIUS_KM)()} * asin(least(1, sqrt(${s1()} * ${s1()} + ${c1()} * ${c2()} * ${s2()} * ${s2()})))`;
}

/**
 * One `within_km` step as a never-NULL boolean, or null when it applies nothing
 * (no radius, an unknown longitude column) — the cases transforms.stepFilter
 * skips with a warning. `ci` is the latitude column's index. A column that is
 * not DECLARED a number matches no row, exactly as its text cells fail the JS
 * `finiteNum` test.
 */
export function sqlRadiusPredicate(cols: ParsedColumn[], ci: number, s: FilterStep, params: duck.DuckValue[]): string | null {
  const r = s.radius;
  if (!r) return null;
  const gi = cols.findIndex((c) => c && c.name === r.lngColumn);
  if (gi < 0) return null;
  if (cols[ci].type !== 'number' || cols[gi].type !== 'number') return 'FALSE';
  const la = sqlNum(phys(ci));
  const lo = sqlNum(phys(gi));
  const dist = sqlHaversine(() => la, () => lo, sqlBind(params, r.lat), sqlBind(params, r.lng), params);
  const km = sqlBind(params, r.km)();
  return `coalesce(abs(${la}) <= 90 AND abs(${lo}) <= 180 AND ${dist} <= ${km}, FALSE)`;
}
