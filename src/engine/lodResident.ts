// LOD expressions over the stored Parquet, answered in place — the SQL twin of
// formula/lod.ts, held to `Object.is` agreement by scripts/test-lod-resident.ts.
// MAIN PROCESS.
//
// The LOD's aggregate is ONE grouped subquery over the group dimensions, joined
// back onto every row on those dimensions:
//
//   SELECT l.__v FROM (SELECT <keys>, <ordinal> FROM t WHERE <ctx>) b
//   LEFT JOIN (SELECT <keys>, <agg> FROM t WHERE <ctx> GROUP BY <keys>) l
//          ON b.__k0 IS NOT DISTINCT FROM l.__k0 AND …
//
// The rules, each the JS reference's:
//   · keys: a `number` column on its number (`sqlNum`), anything else on the
//     stored string verbatim — `transforms.stepGroupAggregate`'s JSON key, the
//     same split `residentCategory.groupKeyExpr` makes. `IS NOT DISTINCT FROM`
//     because a NULL key is a group like any other; `=` would drop it.
//   · the aggregate: `residentQuery.aggExpr` (CAST AS DOUBLE, numbers gated on
//     the DECLARED type, count = non-empty), plus COUNTD spelled the same way.
//   · order: `ORDER BY` the file ordinal, always.
//
// Only an LOD whose argument is ONE bare column is compiled; a computed
// argument (`SUM([a] * [b])`), a nested LOD, or MIN/MAX of a non-number column
// (the JS reference's date rule) returns null and the caller runs the
// reference. Every entry point returns null on any failure.

import type { ParsedColumn } from '../data/parse';
import type { FilterStep } from '../data/transforms';
import type { LodAgg } from '../formula/formulaParse';
import type { MetricAggregation } from '../analysis/metricValue';
import { sqlEmpty } from './sqlGen';
import { phys, sqlNum } from './residentCategory';
import { aggExpr, filterPredicates, runOrderedAsync } from './residentQuery';
import type { ResidentSource } from './residentQuery';
import * as duck from './duckdb';

/** One LOD, already resolved against the visual: the dimensions it GROUPS by. */
export interface ResidentLod {
  groupDims: string[];
  agg: LodAgg;
  argCol: string;
}

interface Plan {
  keys: string[];
  agg: string;
}

function plan(cols: ParsedColumn[], lod: ResidentLod): Plan | null {
  const at = (name: string): number => cols.findIndex((c) => c && c.name === name);
  const ci = at(lod.argCol);
  if (ci < 0) return null;
  const dims = lod.groupDims.map(at);
  if (dims.some((i) => i < 0)) return null;
  const key = (i: number): string => (cols[i].type === 'number' ? sqlNum(phys(i)) : phys(i));
  let agg: string;
  if (lod.agg === 'countd') {
    agg = `CAST(count(DISTINCT CASE WHEN NOT ${sqlEmpty(phys(ci))} THEN ${key(ci)} END) AS DOUBLE)`;
  } else {
    // MIN/MAX of text is the reference's DATE rule, which SQL does not implement.
    if ((lod.agg === 'min' || lod.agg === 'max') && cols[ci].type !== 'number') return null;
    agg = aggExpr(cols, ci, lod.agg);
  }
  return { keys: dims.map(key), agg };
}

/**
 * The joined relation `(b LEFT JOIN l)`, exposing `__o` (file ordinal) and
 * `__v` (the LOD value). Params are pushed in statement-text order: b's WHERE
 * (context, then `outer`), then l's (context).
 */
function joined(cols: ParsedColumn[], p: Plan, context: FilterStep[], outer: FilterStep[], params: duck.DuckValue[]) {
  const preds = (list: FilterStep[]): string => {
    const ps = filterPredicates(cols, list, params);
    return ps.length ? ` WHERE ${ps.join(' AND ')}` : '';
  };
  const whereB = preds(context.concat(outer));
  const whereL = preds(context);
  const sel = p.keys.map((k, i) => `${k} AS __k${i}`);
  const group = p.keys.length ? ` GROUP BY ${p.keys.map((_, i) => `__k${i}`).join(', ')}` : '';
  const on = p.keys.length ? p.keys.map((_, i) => `b.__k${i} IS NOT DISTINCT FROM l.__k${i}`).join(' AND ') : 'TRUE';
  return (from: string, ord: string): string =>
    `(SELECT b.__o AS __o, l.__v AS __v FROM ` +
    `(SELECT ${sel.concat([`${ord} AS __o`]).join(', ')} FROM ${from}${whereB}) b LEFT JOIN ` +
    `(SELECT ${sel.concat([`${p.agg} AS __v`]).join(', ')} FROM ${from}${whereL}${group}) l ON ${on})`;
}

function finiteOrNull(raw: duck.DuckValue): number | null {
  const n = typeof raw === 'number' ? raw : raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * The LOD's value on every row that survives the context filters, in file
 * order — `formula/lod.lodValues` for one LOD over the context-filtered
 * table. `limit` reads only the first rows (the formula editor's preview).
 */
export async function lodValuesResident(
  src: ResidentSource,
  lod: ResidentLod,
  context: FilterStep[] = [],
  limit?: number,
): Promise<(number | null)[] | null> {
  try {
    const p = plan(src.columns, lod);
    if (!p) return null;
    const params: duck.DuckValue[] = [];
    const rel = joined(src.columns, p, context, [], params);
    const tail = typeof limit === 'number' ? ` LIMIT ${Math.max(0, Math.floor(limit))}` : '';
    const out = await runOrderedAsync(src.parquetPath, (from, ord) => `SELECT __v FROM ${rel(from, ord)} ORDER BY __o${tail};`, params);
    return out.map((r) => finiteOrNull(r.__v ?? null));
  } catch (_) {
    return null;
  }
}

/**
 * A metric over an LOD — `sum({FIXED [Region] : SUM([Sales])})` — with the
 * context filters inside the LOD and the ordinary ones after it:
 * `analysis/lodQuery.lodMetricValue` for a dataset with no LOD fields of its
 * own to recompute.
 */
export async function lodMetricResident(
  src: ResidentSource,
  lod: ResidentLod,
  aggregation: MetricAggregation,
  context: FilterStep[],
  normal: FilterStep[],
): Promise<number | null> {
  try {
    const p = plan(src.columns, lod);
    if (!p) return null;
    const params: duck.DuckValue[] = [];
    const rel = joined(src.columns, p, context, normal, params);
    // `computeMetric` over the appended column: finite numbers only, count = non-null.
    const n = 'CASE WHEN isfinite(__v) THEN __v END';
    const m: Record<MetricAggregation, string> = {
      sum: `sum(${n})`,
      avg: `CASE WHEN count(${n}) > 0 THEN sum(${n}) / count(${n}) END`,
      min: `min(${n})`,
      max: `max(${n})`,
      count: `count(${n})`,
    };
    if (!m[aggregation]) return null;
    const out = await runOrderedAsync(src.parquetPath, (from, ord) => `SELECT CAST(${m[aggregation]} AS DOUBLE) AS m0 FROM ${rel(from, ord)};`, params);
    const raw = out.length ? out[0].m0 : null;
    if (raw == null) return null;
    const v = typeof raw === 'number' ? raw : Number(raw);
    return Number.isNaN(v) ? null : v;
  } catch (_) {
    return null;
  }
}
