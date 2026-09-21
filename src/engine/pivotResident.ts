'use strict';

// A pivot's grouping sets, computed IN PLACE off the stored Parquet — the
// resident twin of `analysis/pivotData.buildPivotGrid`'s JS grouping pass.
//
// It produces GROUPS, not a grid. The fold that turns groups into rows,
// subtotals, totals and `showAs` lives once, in `pivotData.foldPivotGrid`, and
// both paths call it — so the only thing this file can get wrong is the
// grouping itself, which is exactly what `scripts/test-pivotData.ts` compares
// `Object.is` against the JS path.
//
// The layer's standing rules apply unchanged:
//   • Cast on the DECLARED type, never inference — `aggExpr` (residentQuery)
//     owns that gate and is imported rather than restated.
//   • Order is never assumed — every set ends `ORDER BY min(<ordinal>)`, via
//     the same `runOrdered` that owns the `file_row_number` downgrade.
//   • Empty is null OR '' OR whitespace, spelled out by `sqlEmpty`.
//   • Every aggregate is `CAST(… AS DOUBLE)` — again, `aggExpr`'s job.
//
// Returns `null` on ANY doubt — bridge down, a query that throws, a date column
// whose cells are not one of the two canonical shapes. The caller falls back to
// the JS reference, which is slower and right.

import type { ParsedColumn } from '../data/parse';
import type { FilterStep } from '../data/transforms';
import type { PivotDim, PivotEncoding, PivotGrid, PivotGroups, PivotSet, PivotValue } from '../analysis/pivotData';
import { foldPivotGrid, pivotSets, pivotTopNFilter } from '../analysis/pivotData';
import { sqlEmpty } from './sqlGen';
import { aggExpr, filterPredicates, plainFrom, runOrdered } from './residentQuery';
import type { ResidentSource } from './residentQuery';
import { bomSafe, dateBucketSql, phys, sqlCanonicalDate } from './residentCategory';
import { dateBucketLabel } from '../analysis/categoryKey';
import type { DateGrain } from '../analysis/categoryKey';
import * as duck from './duckdb';

/** One dimension resolved to SQL: how to group it, and how to read a key back. */
interface DimPlan {
  /** The GROUP BY / projection expression. Carries no bound parameters. */
  expr: string;
  /** A returned key → the label the fold sees. */
  decode: (raw: duck.DuckValue) => string;
  grain: DateGrain | null;
}

function colIndex(cols: ParsedColumn[], name: string): number {
  return cols.findIndex((c) => c && c.name === name);
}

/**
 * `String(cell)` over a round-tripped key, matching `pivotData.labelVal`: NULL
 * becomes '' and everything else is its own text. A `number` column is NOT
 * re-parsed here the way `residentCategory.labelOf` re-parses it, because the
 * JS pivot path keys on `String(cell)` of the stored cell — and the stored cell
 * for a number column is the JS number, whose `String()` is what DuckDB returns
 * for the same VARCHAR only when the two agree. Hence `numberLabel` below.
 */
function textLabel(raw: duck.DuckValue): string {
  return raw == null ? '' : String(raw);
}

/**
 * A `number` dimension's key. `transforms.stepGroupAggregate` keys on the
 * round-tripped CELL, so '1' and '1.0' are one group and a non-numeric cell is
 * null — the same rule `residentCategory.groupKeyExpr` encodes. The label is
 * then `String(number)`, so the DOUBLE comes back and is re-stringified by JS
 * rather than by DuckDB, whose float formatting is its own.
 */
function numberLabel(raw: duck.DuckValue): string {
  if (raw == null) return '';
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? String(n) : '';
}

function planDim(cols: ParsedColumn[], dim: PivotDim): DimPlan | null {
  const ci = colIndex(cols, dim.column);
  if (ci < 0) return null;
  const p = phys(ci);
  const type = cols[ci].type;

  if (dim.grain) {
    // Grained: group on the integer bucket id and let `categoryKey` write the
    // label, never SQL — one side writing `2024-Q1` and the other `2024-Q01` is
    // the divergence this whole layer is shaped to prevent.
    const grain = dim.grain as DateGrain;
    const expr = `CASE WHEN ${sqlEmpty(p)} THEN NULL ELSE ${dateBucketSql(sqlCanonicalDate(p), grain)} END`;
    return {
      expr,
      grain,
      decode: (raw) => (raw == null ? '' : dateBucketLabel(Number(raw), grain)),
    };
  }
  if (type === 'number') {
    const n = `CASE WHEN isfinite(TRY_CAST(${p} AS DOUBLE)) THEN TRY_CAST(${p} AS DOUBLE) END`;
    return { expr: n, grain: null, decode: numberLabel };
  }
  return { expr: bomSafe(p), grain: null, decode: textLabel };
}

/**
 * Is every non-empty cell of a grained date column one of the two canonical
 * shapes? If not, SQL and `categoryKey.parseDateCell` (which falls back to
 * `Date.parse`) would bucket differently — so the whole pivot goes to the JS
 * path. Identical in intent, and in its `bad` count, to `residentQuery.dateKey`.
 */
function datesAreCanonical(
  src: ResidentSource,
  cols: ParsedColumn[],
  dims: PivotDim[],
  filters: FilterStep[] | undefined,
): boolean {
  const grained = dims.filter((d) => d.grain);
  if (grained.length === 0) return true;
  const params: duck.DuckValue[] = [];
  const select: string[] = [];
  for (const d of grained) {
    const ci = colIndex(cols, d.column);
    if (ci < 0) return false;
    const p = phys(ci);
    select.push(
      `CAST(sum(CASE WHEN NOT ${sqlEmpty(p)} AND ${sqlCanonicalDate(p)} IS NULL THEN 1 ELSE 0 END) AS DOUBLE)`,
    );
  }
  const preds = filterPredicates(cols, filters, params);
  const where = preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
  const aliased = select.map((e, i) => `${e} AS bad${i}`);
  const out = duck.query(`SELECT ${aliased.join(', ')} FROM ${plainFrom(src.parquetPath)}${where};`, params);
  if (out.length === 0) return true; // no rows, nothing to misparse
  for (let i = 0; i < grained.length; i += 1) {
    const raw = out[0][`bad${i}`];
    // sum() over zero qualifying rows is NULL, and zero rows means zero
    // unparsable cells — `?? 0` is the reading, not a defensive coalesce.
    const bad = raw == null ? 0 : Number(raw);
    if (!Number.isFinite(bad) || bad !== 0) return false;
  }
  return true;
}

/** One grouping set as one ordered aggregate query. */
function runSet(
  src: ResidentSource,
  cols: ParsedColumn[],
  rowPlans: DimPlan[],
  colPlans: DimPlan[],
  set: PivotSet,
  values: PivotValue[],
  filters: FilterStep[] | undefined,
): PivotGroups {
  const dims = rowPlans.slice(0, set.rowDims).concat(colPlans.slice(0, set.colDims));
  const params: duck.DuckValue[] = [];
  const preds = filterPredicates(cols, filters, params);
  const where = preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
  const aggs = values.map((v, i) => {
    const fn = v.aggregation === 'none' ? 'sum' : v.aggregation;
    return `${aggExpr(cols, colIndex(cols, v.column), fn)} AS m${i}`;
  });

  const out = runOrdered(
    src.parquetPath,
    (from, ord) => {
      const keys = dims.map((d, i) => `${d.expr} AS g${i}`);
      // A CONSTANT grouping key for the no-dimension sets (the grand total and
      // the Total column's top level). Not a bare aggregate: over zero
      // qualifying rows `SELECT sum(x) FROM t` returns ONE row of NULLs while
      // `transforms.stepGroupAggregate` returns NO group, and the fold must see
      // the same absence on both paths.
      const keyList = keys.length ? keys.join(', ') : '1 AS g_const';
      const groupBy = keys.length
        ? dims.map((_, i) => `g${i}`).join(', ')
        : 'g_const';
      return (
        `SELECT ${keyList}, ${aggs.join(', ')}, min(__ord_p) AS __o FROM ` +
        `(SELECT ${ord} AS __ord_p, * FROM ${from}${where}) ` +
        `GROUP BY ${groupBy} ORDER BY __o;`
      );
    },
    params,
  );

  return {
    set,
    rows: out.map((r) => ({
      keys: dims.map((d, i) => d.decode(r[`g${i}`] ?? null)),
      values: values.map((_, i) => {
        const raw = r[`m${i}`];
        if (raw == null) return null;
        const n = typeof raw === 'number' ? raw : Number(raw);
        return Number.isFinite(n) ? n : null;
      }),
    })),
  };
}

/**
 * Every grouping set the grid needs, computed off Parquet — or `null`, meaning
 * "no resident answer; run the JS reference".
 *
 * `filters` must already include whatever narrowing the caller applies (Top N
 * is passed in as an ordinary `in` step, exactly as the JS path applies it), so
 * that every set here is computed over the same rows.
 */
export function pivotGroupsResident(
  src: ResidentSource,
  enc: PivotEncoding,
  filters?: FilterStep[],
): PivotGroups[] | null {
  try {
    const cols = Array.isArray(src.columns) ? src.columns : [];
    if (!cols.length) return null;
    if (!enc || enc.rows.length === 0 || enc.values.length === 0) return null;

    const rowPlans: DimPlan[] = [];
    for (const d of enc.rows) {
      const p = planDim(cols, d);
      if (!p) return null;
      rowPlans.push(p);
    }
    const colPlans: DimPlan[] = [];
    for (const d of enc.columns) {
      const p = planDim(cols, d);
      if (!p) return null;
      colPlans.push(p);
    }
    for (const v of enc.values) if (colIndex(cols, v.column) < 0) return null;

    if (!datesAreCanonical(src, cols, enc.rows.concat(enc.columns), filters)) return null;

    return pivotSets(enc).map((set) => runSet(src, cols, rowPlans, colPlans, set, enc.values, filters));
  } catch {
    return null;
  }
}

/**
 * The outermost row dimension's keys RANKED exactly as the JS path ranks them
 * (value descending, nulls last, ties by first-seen position) — or `null` to
 * fall back. The whole ranking comes back, not the top slice, so the caller
 * applies the identical "fewer groups than `n` means no narrowing at all" rule
 * on both paths rather than each deciding for itself.
 */
export function pivotRankedKeys(
  src: ResidentSource,
  enc: PivotEncoding,
  filters?: FilterStep[],
): string[] | null {
  try {
    const topN = enc.topN;
    if (!topN) return null;
    const cols = Array.isArray(src.columns) ? src.columns : [];
    const dim = enc.rows[0];
    // A grained dimension cannot be narrowed by an `in` on its source column,
    // so the JS path declines to narrow at all — match that, exactly.
    if (!dim || dim.grain) return null;
    const v = enc.values[Math.min(topN.byValueIdx, enc.values.length - 1)];
    if (!v) return null;
    const plan = planDim(cols, dim);
    if (!plan) return null;

    const params: duck.DuckValue[] = [];
    const preds = filterPredicates(cols, filters, params);
    const where = preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
    const fn = v.aggregation === 'none' ? 'sum' : v.aggregation;
    const agg = aggExpr(cols, colIndex(cols, v.column), fn);

    const out = runOrdered(
      src.parquetPath,
      (from, ord) =>
        `SELECT g0, m0 FROM (SELECT ${plan.expr} AS g0, ${agg} AS m0, min(__ord_p) AS __o FROM ` +
        `(SELECT ${ord} AS __ord_p, * FROM ${from}${where}) GROUP BY g0 ` +
        `ORDER BY m0 DESC NULLS LAST, __o);`,
      params,
    );
    return out.map((r) => plan.decode(r.g0 ?? null));
  } catch {
    return null;
  }
}

/**
 * The WHOLE resident answer: Top N, the grouping sets, and the shared fold —
 * or `null` to fall back to `pivotData.buildPivotGrid`.
 *
 * One function rather than three calls at the call site, because
 * `scripts/test-pivotData.ts` has to exercise the exact composition
 * `ipc/visuals` ships: a differential over the pieces would pass while the
 * assembly of them diverged.
 */
export function pivotGridResident(
  src: ResidentSource,
  enc: PivotEncoding,
  filters?: FilterStep[],
): PivotGrid | null {
  const base = Array.isArray(filters) ? filters : [];
  let merged = base;
  // A grained outermost dimension declines Top N on BOTH paths — see
  // `pivotData.pivotTopNFilter`.
  if (enc && enc.topN && enc.rows[0] && !enc.rows[0].grain) {
    const ranked = pivotRankedKeys(src, enc, base);
    if (!ranked) return null;
    const step = pivotTopNFilter(enc, ranked);
    if (step) merged = base.concat([step]);
  }
  const groups = pivotGroupsResident(src, enc, merged);
  return groups ? foldPivotGrid(enc, groups) : null;
}
