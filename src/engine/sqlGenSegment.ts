// The `segment` step in SQL — MAIN PROCESS, PURE string building.
//
// The same arithmetic as data/stepsSegment.ts, in the same order, so DuckDB
// and the fold agree bit for bit (scripts/test-segmentsDuck.ts):
//
//   z_j  = (x_j − mean_j) / std_j                       segmentMath.zScore
//   d_k  = (z_0 − c_k0)·(z_0 − c_k0) + (z_1 − c_k1)·…   segmentMath.dist2, a left fold
//   seg  = the first k with d_k ≤ every later d         segmentMath.nearest (lowest index wins a tie)
//
// x_j is read on the DECLARED type only (every feature is a `number` column)
// and a row with any feature NULL gets a NULL segment. Every mean, std,
// centroid value and name is a bound `?`, pushed in statement-text order.
// A double is bound as its shortest round-trip STRING under CAST(? AS DOUBLE):
// the binding infers an integral JS number as INTEGER/BIGINT, so 1e20 fails
// and -0 is lost, while the string parses back to the identical double.
//
// `segmentRelation` is also what engine/segmentResident.ts assigns rows with
// for the sizes and profile — one SQL spelling of the rule, not two.

import type { SegmentStep } from '../data/stepsSegment';
import { segmentProblem } from '../data/stepsSegment';
import type { SqlColumn } from './sqlGen';
import type { Param, PowerSqlCtx, PowerSqlOut } from './sqlGenPower';
import { colOf, projList, skipWith, sqlNum } from './sqlGenPower';

/** A double as a bind value that CAST(? AS DOUBLE) reads back bit for bit. */
export const dbl = (v: number): string => String(v);

/**
 * `rel` plus `__sg` — the segment index 0…k−1, or NULL — as three nested
 * SELECTs. `feats` are the physical columns in the step's feature order.
 */
export function segmentRelation(rel: string, feats: string[], s: SegmentStep, params: Param[]): string {
  const k = s.centroids.length;
  const zParams: Param[] = [];
  const zs = feats.map((p, j) => {
    zParams.push(dbl(s.means[j]), dbl(s.stds[j]));
    return `(${sqlNum(p)} - CAST(? AS DOUBLE)) / CAST(? AS DOUBLE) AS __sg_z${j}`;
  });
  const ok = feats.map((p) => `${sqlNum(p)} IS NOT NULL`).join(' AND ');
  const dParams: Param[] = [];
  const ds = s.centroids.map((c, ki) => {
    const terms = c.map((v, j) => {
      dParams.push(dbl(v), dbl(v));
      return `(__sg_z${j} - CAST(? AS DOUBLE)) * (__sg_z${j} - CAST(? AS DOUBLE))`;
    });
    return `${terms.join(' + ')} AS __sg_d${ki}`;
  });
  const whens: string[] = [];
  for (let i = 0; i < k - 1; i++) {
    const conds: string[] = [];
    for (let j = i + 1; j < k; j++) conds.push(`__sg_d${i} <= __sg_d${j}`);
    whens.push(`WHEN ${conds.join(' AND ')} THEN ${i}`);
  }
  const pick = `CASE WHEN __sg_ok THEN CASE ${whens.join(' ')} ELSE ${k - 1} END END AS __sg`;
  params.push(...dParams, ...zParams); // the distances' text precedes the z's
  return (
    `SELECT *, ${pick} FROM (` +
    `SELECT *, ${ds.join(', ')} FROM (` +
    `SELECT *, ${zs.join(', ')}, (${ok}) AS __sg_ok FROM ${rel}))`
  );
}

/** The step's CTE body for sqlGen; bails when a feature was typed from data. */
export function genSegment(s: SegmentStep, ctx: PowerSqlCtx): PowerSqlOut {
  const problem = segmentProblem(ctx.cols, s);
  if (problem) return skipWith(ctx, problem);
  const feats = s.features.map((f) => colOf(ctx.cols, f) as SqlColumn);
  if (feats.some((c) => ctx.retyped.has(c.physical))) return { bail: 'segment over a column typed from data by an earlier step' };
  const names = s.names.map((n, i) => {
    ctx.params.push(n);
    return `WHEN ${i} THEN CAST(? AS VARCHAR)`;
  });
  const inner = segmentRelation(ctx.cur, feats.map((c) => c.physical), s, ctx.params);
  const phys = ctx.newPhys();
  const cols = [...ctx.cols, { physical: phys, name: s.column.trim(), type: 'text' as const }];
  return { body: `SELECT ${projList(ctx.cols)}, CASE __sg ${names.join(' ')} END AS ${phys} FROM (${inner})`, cols };
}
