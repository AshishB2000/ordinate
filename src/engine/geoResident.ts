// Hexbin density and route flows straight off the stored Parquet — MAIN PROCESS.
// The resident twins of src/analysis/geo/geoAgg.ts `hexGroupsJs` /
// `flowGroupsJs`: they return the same GROUPS, which the same shaping turns
// into the map, and scripts/test-geoAgg.ts holds the two equal with Object.is.
// Never throws: null means "the JS reference answers".
//
// Both run through the bridge's ASYNC calls (a hexbin groups every point at
// every resolution; a blocking call would freeze every window meanwhile).
//
// What the SQL must reproduce, and how:
//   · DECLARED types only — coordinates and a summed measure are read with
//     `sqlNum` because geoAgg.specProblem already refused anything but number
//     columns; a text column is never cast.
//   · the hex arithmetic is hexgrid.ts's, operation for operation, with every
//     constant (degrees → radians, 4π, 2/3, −1/3, √3/3, each level's size, the
//     latitude limit) BOUND as the same double, and halves rounded with
//     floor(v + 0.5) exactly as cubeRound does. The one thing not bound is the
//     trig: DuckDB's sin/ln are libm's, so a point within ~1e-16 of a hexagon
//     edge could in principle round the other way. It is the float-summation
//     caveat's cousin, and as unreachable by real coordinates.
//   · every aggregate CAST(… AS DOUBLE); empty measure cells are NULL, so
//     count(v) is the non-empty count and sum(v) skips them.
//   · order is never taken from SQL: shaping sorts; the flow cap orders by the
//     value and then the first stored row (file_row_number), exactly the JS tie-break.

import type { FilterStep } from '../data/transforms';
import type { ResidentSource } from './residentQuery';
import { filterPredicates } from './residentQuery';
import { relationSql } from './parquetStore';
import { bomSafe, phys, sqlNum } from './residentCategory';
import * as duck from './duckdb';
import { DEG, FOUR_PI, MAX_LAT } from '../analysis/geo/mercator';
import { HEX_LEVELS, HEX_SIZES, MAX_HEXES, NEG_THIRD, SQRT3_3, TWO_THIRDS } from '../analysis/geo/hexgrid';
import { FLOW_CAP } from '../analysis/geo/geoAgg';
import type { FlowGroup, FlowGroups, FlowSpec, HexGroup, HexGroups, HexSpec } from '../analysis/geo/geoAgg';

const D = 'CAST(? AS DOUBLE)';

function idx(src: ResidentSource, name: string): number {
  return name ? src.columns.findIndex((c) => c && c.name === name) : -1;
}

function num(v: duck.DuckValue | undefined): number {
  return typeof v === 'number' ? v : Number(v);
}

/** The filtered base relation's SELECT and its params, or null when a named column is missing. */
function base(src: ResidentSource, cols: string[], filters: FilterStep[], params: duck.DuckValue[], ord: boolean): string {
  const preds = filterPredicates(src.columns, filters, params);
  const where = preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
  return `SELECT ${ord ? 'file_row_number AS ord, ' : ''}${cols.join(', ')} FROM ${relationSql(src.parquetPath, { fileRowNumber: ord })}${where}`;
}

export async function hexGroupsResident(src: ResidentSource, spec: HexSpec, filters: FilterStep[]): Promise<HexGroups | null> {
  try {
    const li = idx(src, spec.lat);
    const gi = idx(src, spec.lng);
    const mi = idx(src, spec.measure.column);
    if (li < 0 || gi < 0 || (spec.measure.column && mi < 0)) return null;
    const params: duck.DuckValue[] = [];
    const b = base(src, [
      `${sqlNum(phys(li))} AS la`, `${sqlNum(phys(gi))} AS lo`, `${mi >= 0 ? sqlNum(phys(mi)) : 'CAST(NULL AS DOUBLE)'} AS v`,
    ], filters, params, false);
    params.push(MAX_LAT, FOUR_PI, DEG);
    const levels = HEX_SIZES.map((size, res) => { params.push(size); return `(${res}, ${D})`; }).join(', ');
    params.push(TWO_THIRDS, NEG_THIRD, SQRT3_3, MAX_HEXES);
    const sql =
      `WITH b AS (${b}), ` +
      `p AS (SELECT la, lo, v FROM b WHERE la IS NOT NULL AND lo IS NOT NULL AND abs(la) <= ${D} AND abs(lo) <= 180), ` +
      `w AS (SELECT (lo + 180) / 360 AS x, CAST(0.5 AS DOUBLE) - ln((1 + s) / (1 - s)) / ${D} AS y, v ` +
      `FROM (SELECT lo, sin(la * ${D}) AS s, v FROM p)), ` +
      `l AS (SELECT * FROM (VALUES ${levels}) AS t(res, size)), ` +
      `f AS (SELECT res, (${D} * x) / size AS qf, (${D} * x + ${D} * y) / size AS rf, v FROM w CROSS JOIN l), ` +
      `c AS (SELECT res, qf, rf, -qf - rf AS sf, floor(qf + CAST(0.5 AS DOUBLE)) AS q0, floor(rf + CAST(0.5 AS DOUBLE)) AS r0, ` +
      `floor(-qf - rf + CAST(0.5 AS DOUBLE)) AS s0, v FROM f), ` +
      `d AS (SELECT res, q0, r0, s0, abs(q0 - qf) AS dq, abs(r0 - rf) AS dr, abs(s0 - sf) AS ds, v FROM c), ` +
      `h AS (SELECT res, CAST(CASE WHEN dq > dr AND dq > ds THEN -r0 - s0 ELSE q0 END AS BIGINT) AS q, ` +
      `CAST(CASE WHEN dq > dr AND dq > ds THEN r0 WHEN dr > ds THEN -q0 - s0 ELSE r0 END AS BIGINT) AS r, v FROM d), ` +
      `g AS (SELECT res, q, r, CAST(count(*) AS DOUBLE) AS n, CAST(count(v) AS DOUBLE) AS c, CAST(sum(v) AS DOUBLE) AS s ` +
      `FROM h GROUP BY res, q, r), ` +
      `k AS (SELECT res, CAST(count(*) AS DOUBLE) AS nh FROM g GROUP BY res) ` +
      `SELECT 'h' AS kind, g.res, CAST(g.q AS DOUBLE) AS q, CAST(g.r AS DOUBLE) AS r, g.n, g.c, g.s FROM g JOIN k USING (res) WHERE k.nh <= ${D} ` +
      `UNION ALL SELECT 'k', res, NULL, NULL, nh, NULL, NULL FROM k ` +
      `UNION ALL SELECT 't', NULL, NULL, NULL, CAST((SELECT count(*) FROM b) AS DOUBLE), CAST((SELECT count(*) FROM p) AS DOUBLE), NULL;`;
    const rows = await duck.queryAsync(sql, params);
    const groups: HexGroup[] = [];
    const levelCounts = new Array<number>(HEX_LEVELS).fill(0);
    let total = 0;
    let points = 0;
    for (const row of rows) {
      if (row.kind === 'h') {
        groups.push({ res: num(row.res), q: num(row.q) + 0, r: num(row.r) + 0, n: num(row.n), c: num(row.c), s: row.s == null ? null : num(row.s) });
      } else if (row.kind === 'k') levelCounts[num(row.res)] = num(row.n);
      else { total = num(row.n); points = num(row.c); }
    }
    return { groups, levelCounts, points, skipped: total - points, warnings: [] };
  } catch (_) {
    return null;
  }
}

export async function flowGroupsResident(src: ResidentSource, spec: FlowSpec, filters: FilterStep[]): Promise<FlowGroups | null> {
  try {
    const at = [spec.lat, spec.lng, spec.lat2, spec.lng2].map((n) => idx(src, n));
    const mi = idx(src, spec.measure.column);
    const fi = idx(src, spec.from);
    const ti = idx(src, spec.to);
    if (at.some((i) => i < 0) || (spec.measure.column && mi < 0) || (spec.from && fi < 0) || (spec.to && ti < 0)) return null;
    // A NAME from a number column would print through DuckDB's number
    // formatting, not JS's String(); leave that rare case to the reference.
    if ([fi, ti].some((i) => i >= 0 && src.columns[i].type === 'number')) return null;
    const params: duck.DuckValue[] = [];
    const name = (i: number): string => (i >= 0 ? bomSafe(phys(i)) : "CAST('' AS VARCHAR)");
    const b = base(src, [
      ...at.map((i, k) => `${sqlNum(phys(i))} AS c${k}`),
      `${mi >= 0 ? sqlNum(phys(mi)) : 'CAST(NULL AS DOUBLE)'} AS v`, `${name(fi)} AS fn`, `${name(ti)} AS tn`,
    ], filters, params, true);
    const value = spec.measure.agg === 'count' ? 'n'
      : spec.measure.agg === 'sum' ? 'CASE WHEN c = 0 THEN NULL ELSE s END' : 'CASE WHEN c = 0 THEN NULL ELSE s / c END';
    params.push(FLOW_CAP);
    const sql =
      `WITH b AS (${b}), ` +
      `p AS (SELECT ord, c0 + 0 AS oa, c1 + 0 AS oo, c2 + 0 AS da, c3 + 0 AS dd, v, fn, tn FROM b ` +
      `WHERE c0 IS NOT NULL AND c1 IS NOT NULL AND c2 IS NOT NULL AND c3 IS NOT NULL ` +
      `AND abs(c0) <= 90 AND abs(c1) <= 180 AND abs(c2) <= 90 AND abs(c3) <= 180), ` +
      `g AS (SELECT oa, oo, da, dd, CAST(count(*) AS DOUBLE) AS n, CAST(count(v) AS DOUBLE) AS c, CAST(sum(v) AS DOUBLE) AS s, ` +
      `CAST(min(ord) AS DOUBLE) AS f0, first(fn ORDER BY ord) AS fn, first(tn ORDER BY ord) AS tn FROM p GROUP BY oa, oo, da, dd), ` +
      `r AS (SELECT *, ${value} AS val, count(*) OVER () AS routes FROM g) ` +
      `SELECT * FROM (SELECT 'g' AS kind, oa, oo, da, dd, n, c, s, f0, fn, tn, CAST(routes AS DOUBLE) AS routes FROM r ` +
      `ORDER BY val DESC NULLS LAST, f0 LIMIT ${D}) ` +
      `UNION ALL SELECT 't', NULL, NULL, NULL, NULL, CAST((SELECT count(*) FROM b) AS DOUBLE), CAST((SELECT count(*) FROM p) AS DOUBLE), ` +
      `NULL, NULL, NULL, NULL, NULL;`;
    const rows = await duck.queryAsync(sql, params);
    const groups: FlowGroup[] = [];
    let routes = 0;
    let total = 0;
    let points = 0;
    for (const row of rows) {
      if (row.kind === 't') { total = num(row.n); points = num(row.c); continue; }
      routes = num(row.routes);
      groups.push({
        oa: num(row.oa), oo: num(row.oo), da: num(row.da), dd: num(row.dd), n: num(row.n), c: num(row.c),
        s: row.s == null ? null : num(row.s), first: num(row.f0),
        from: row.fn == null ? '' : String(row.fn), to: row.tn == null ? '' : String(row.tn),
      });
    }
    return { groups, routes, points, skipped: total - points, warnings: [] };
  } catch (_) {
    return null;
  }
}
