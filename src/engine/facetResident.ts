// Small multiples straight off the stored Parquet — MAIN PROCESS ONLY.
//
// The resident twin of `analysis/facets.buildFacetData`: the same category key
// (`resolveCatKey`), the same filters, then ONE grouped query with the facet
// dimensions added to the GROUP BY. It returns grouped rows; the panels, the
// "Other" fold, the titles and the domains are built by `facets.foldFacets`,
// the function the JS path calls. Never throws — `null` means "use the JS path",
// and `scripts/test-facetsResident.ts` holds the two to `Object.is`.
//
// A facet value comes back from SQL only in the RANK probe (to pick the kept
// values); the grouped query returns each row's INDEX into that list, so no
// label is ever produced by SQL and a real value spelled "Other" cannot merge
// with the fold. Empty (null, '' or whitespace) is spelled by `sqlEmpty`, the
// codebase's one definition.

import type { ParsedColumn } from '../data/parse';
import type { FilterStep } from '../data/transforms';
import type { FacetDim, FacetGroup } from '../analysis/facets';
import { facetDims, foldFacets, planFacetDim } from '../analysis/facets';
import type { VizEncoding } from '../analysis/visuals';
import type { VizDataResult } from '../analysis/vizData';
import { recommendChartType } from '../analysis/vizData';
import type { ResidentCatKey, ResidentMeasure, ResidentSource } from './residentQuery';
import { aggExpr, filterPredicates, runOrdered } from './residentQuery';
import { resolveCatKeySync } from './residentSync';
import * as trace from './residentTrace';
import { bomSafe, catKeyExpr, catLabel, phys } from './residentCategory';
import { sqlEmpty } from './sqlGen';
import type { DuckValue } from './duckdb';

function colIndex(cols: ParsedColumn[], name: string): number {
  return cols.findIndex((c) => c && c.name === name);
}

function where(cols: ParsedColumn[], filters: FilterStep[], params: DuckValue[]): string {
  const preds = filterPredicates(cols, filters, params);
  return preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
}

function finiteOrNull(raw: DuckValue): number | null {
  const n = typeof raw === 'number' ? raw : raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * The top `limit` values of a TEXT facet column by the first measure — the
 * twin of `facets.rankGroups` over `rankFacetJs`: descending, nulls last, ties
 * by first-seen. Empty cells are one null key.
 */
export function rankFacetResident(
  src: ResidentSource, column: string, m0: ResidentMeasure, filters: FilterStep[], limit: number,
): { key: string | null }[] | null {
  try {
    const cols = src.columns;
    const fi = colIndex(cols, column);
    if (fi < 0 || cols[fi].type !== 'text') return null;
    const p = phys(fi);
    const params: DuckValue[] = [];
    const w = where(cols, filters, params);
    const agg = aggExpr(cols, colIndex(cols, m0.column), m0.aggregation);
    const out = runOrdered(src.parquetPath, (from, ord) =>
      `SELECT __f AS v, ${agg} AS m0 FROM ` +
      `(SELECT CASE WHEN ${sqlEmpty(p)} THEN NULL ELSE ${bomSafe(p)} END AS __f, ${ord} AS __o, * FROM ${from}${w}) ` +
      `GROUP BY __f ORDER BY m0 DESC NULLS LAST, min(__o) LIMIT ${Math.max(1, Math.floor(limit))};`, params);
    return out.map((r) => ({ key: r.v == null ? null : String(r.v) }));
  } catch {
    return null;
  }
}

/** A row's index into `dim.keep` (−1 = Other), as SQL. Parameters pushed in text order. */
function panelIndexExpr(cols: ParsedColumn[], dim: FacetDim, params: DuckValue[]): string {
  const p = phys(colIndex(cols, dim.column));
  const parts = [`WHEN ${sqlEmpty(p)} THEN ${dim.keep.indexOf(null)}`];
  dim.keep.forEach((k, i) => {
    if (k === null) return;
    parts.push(`WHEN CAST(${p} AS VARCHAR) = CAST(? AS VARCHAR) THEN ${i}`);
    params.push(k);
  });
  return `CASE ${parts.join(' ')} ELSE -1 END`;
}

/**
 * The grouped rows: (panel index per dimension, category key[, split]) → the
 * measures, in first-seen order. `split` names a TEXT column; with one, only
 * the first measure is aggregated (the split IS the series), as in buildVizData.
 */
export function facetGroupsResident(
  src: ResidentSource,
  category: string,
  catKey: ResidentCatKey,
  measures: ResidentMeasure[],
  filters: FilterStep[],
  dims: FacetDim[],
  split?: string,
): FacetGroup[] | null {
  try {
    const cols = src.columns;
    const gi = colIndex(cols, category);
    if (gi < 0 || measures.length === 0) return null;
    const si = split ? colIndex(cols, split) : -1;
    if (split && (si < 0 || cols[si].type !== 'text')) return null;
    const params: DuckValue[] = [];
    const key = catKeyExpr(cols, gi, catKey, params);
    const idx = dims.map((d) => panelIndexExpr(cols, d, params));
    const w = where(cols, filters, params);
    const list = split ? measures.slice(0, 1) : measures;
    const aggs = list.map((m, i) => `${aggExpr(cols, colIndex(cols, m.column), m.aggregation)} AS m${i}`);
    const fs = idx.map((_, i) => `__f${i}`);
    const keys = ['__k'].concat(fs, split ? ['__s'] : []);
    const inner = [`${key.label} AS __k`]
      .concat(idx.map((e, i) => `${e} AS __f${i}`), split ? [`${bomSafe(phys(si))} AS __s`] : []);
    const out = runOrdered(src.parquetPath, (from, ord) =>
      `SELECT ${keys.join(', ')}, ${aggs.join(', ')} FROM ` +
      `(SELECT ${inner.join(', ')}, ${ord} AS __o, * FROM ${from}${w}) ` +
      `GROUP BY ${keys.join(', ')} ORDER BY min(__o);`, params);
    const type = cols[gi].type;
    return out.map((r) => ({
      r: Number(r.__f0),
      c: dims.length === 2 ? Number(r.__f1) : 0,
      key: JSON.stringify(r.__k ?? null),
      label: catLabel(r.__k ?? null, type, catKey),
      split: split ? (r.__s == null ? null : String(r.__s)) : undefined,
      values: list.map((_, i) => finiteOrNull(r[`m${i}`] ?? null)),
    }));
  } catch {
    return null;
  }
}

/**
 * The faceted chart off Parquet: rank each facet dimension, resolve the
 * category key, run the one grouped query, fold. The caller has already proved
 * no warning is possible (every column exists, every filter applies).
 */
export function facetDataResident(src: ResidentSource, enc: VizEncoding, filters: FilterStep[]): VizDataResult | null {
  const facet = enc.facet;
  const values = Array.isArray(enc.values) ? enc.values : [];
  const split = typeof enc.series === 'string' && enc.series ? enc.series : undefined;
  if (!facet || !enc.category || values.length === 0 || (!split && values.every((v) => v.aggregation === 'none'))) return null;
  const type = new Map(src.columns.map((c) => [c.name, c.type]));
  const dimsIn = facetDims(facet);
  // A facet or split value is the same text on both paths only for a TEXT column.
  if (dimsIn.some((d) => type.get(d.column) !== 'text') || (split && type.get(split) !== 'text')) return null;

  const measures: ResidentMeasure[] = values.map((v) => ({ column: v.column, aggregation: v.aggregation === 'none' ? 'sum' : v.aggregation }));
  const order = facet.order === 'measure' ? 'measure' : 'label';
  const dims: FacetDim[] = [];
  for (const d of dimsIn) {
    const ranked = rankFacetResident(src, d.column, measures[0], filters, d.cap + 1);
    if (!ranked) { trace.record('vizFacets', 'failed', 'rank'); return null; }
    dims.push(planFacetDim(d.column, ranked, d.cap, order));
  }
  const catType = type.get(enc.category);
  const plan = resolveCatKeySync(src, enc.category, measures, filters, enc.grain, enc.bins);
  if (!plan) { trace.record('vizFacets', catType === 'date' ? 'skipped' : 'failed', `category type ${catType}`); return null; }
  const groups = facetGroupsResident(src, enc.category, plan.key, measures, filters, dims, split);
  if (!groups) { trace.record('vizFacets', 'failed', `${dims.length} dims`); return null; }
  trace.record('vizFacets', 'resident');
  // vizData.measureLabel over the coerced aggregation, as residentQuery names its series.
  const names = split ? null : measures.map((m) => (m.aggregation === 'count' ? m.column : `${m.aggregation} of ${m.column}`));
  const { grid, data } = foldFacets(groups, dims, names, facet);
  return { data: { ...data, facets: grid }, recommendedShape: recommendChartType(src.columns, enc).shape, warnings: [], category: plan.info };
}
