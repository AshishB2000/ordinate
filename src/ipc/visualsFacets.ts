// Small multiples behind `visual:data` — MAIN PROCESS.
//
// The same shape as ./visualsResident: answer straight off the stored Parquet
// when that is provably the JS answer, else hydrate and run the reference
// (`analysis/facets.buildFacetData`). Both produce grouped rows for the ONE fold
// in analysis/facets. No IPC handler is registered here.
//
// A PIVOT is the exception: each panel is its own pivot grid, because a pivot's
// subtotals must be recomputed from the source rows, never folded. Its panels
// are the ordinary pivot computation under one more filter each — the panel's
// own steps — so every panel goes through the pivot's resident path and cache.

import * as datasets from '../data/datasets';
import type { Dataset } from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import { applyPipeline } from '../data/transforms';
import type { VizEncoding, VizMeasure } from '../analysis/visuals';
import type { VizDataResult } from '../analysis/vizData';
import { buildFacetData, facetDims, foldFacets, planFacetDim, rankFacetJs } from '../analysis/facets';
import type { FacetDim } from '../analysis/facets';
import type { ResidentMeasure } from '../engine/residentQuery';
import { facetDataResident, rankFacetResident } from '../engine/facetResident';
import * as trace from '../engine/residentTrace';
import { filterCannotWarn } from './visualsResident';
import type { VizDataReply } from './visuals';

type Compute = (encoding: VizEncoding, filters: FilterStep[]) => Promise<VizDataReply>;

/** Whether this encoding is drawn as small multiples at all (maps, cohorts and related-dataset fields are not). */
export function isFaceted(e: VizEncoding | null | undefined): boolean {
  if (!e || !e.facet || e.geo || e.cohort || e.eventFunnel || e.drivers) return false;
  if (e.categoryDatasetId || e.seriesDatasetId) return false;
  return !(Array.isArray(e.values) && e.values.some((v) => v && v.datasetId));
}

const asResident = (v: VizMeasure): ResidentMeasure => ({ column: v.column, aggregation: v.aggregation === 'none' ? 'sum' : v.aggregation });

/** The resident answer, or null meaning "not provably the JS answer — hydrate". */
async function residentFacets(projectId: string, datasetId: string, enc: VizEncoding, filters: FilterStep[]): Promise<VizDataResult | null> {
  try {
    const src = await datasets.residentSource(projectId, datasetId);
    if (!src) { trace.record('vizFacets', 'skipped'); return null; }
    // The warning-freedom proof, exactly as residentVizData: every warning the
    // JS path could raise is decidable from column metadata.
    const names = new Set(src.columns.map((c) => c.name));
    const used = [enc.category, enc.series, enc.facet!.rows, enc.facet!.cols].concat((enc.values || []).map((v) => v.column));
    if (used.some((c) => c && !names.has(c))) return null;
    if (!filters.every((f) => filterCannotWarn(f, names))) return null;
    return facetDataResident(src, enc, filters);
  } catch (_) {
    return null;
  }
}

/** One pivot grid per panel, each the ordinary pivot under the panel's own filter. */
async function pivotFacets(projectId: string, datasetId: string, enc: VizEncoding, filters: FilterStep[], compute: Compute): Promise<VizDataReply> {
  const facet = enc.facet!;
  const plain: VizEncoding = { ...enc, facet: undefined };
  const v0 = enc.pivot!.values[0];
  if (!v0) return compute(plain, filters);
  const m0 = { column: v0.column, aggregation: v0.aggregation };
  const order = facet.order === 'measure' ? 'measure' : 'label';
  const src = await datasets.residentSource(projectId, datasetId);
  let table: Dataset | null = null as Dataset | null; // hydrated only when a rank cannot run resident
  const dims: FacetDim[] = [];
  for (const d of facetDims(facet)) {
    let ranked: { key: string | null }[] | null = src ? rankFacetResident(src, d.column, asResident(m0), filters, d.cap + 1) : null;
    if (!ranked) {
      const ds: Dataset | null = table || (await datasets.getDataset(projectId, datasetId));
      if (!ds) return { ok: false, error: 'Dataset not found' };
      table = ds;
      if (!ds.columns.some((c) => c.name === d.column)) return compute(plain, filters);
      ranked = rankFacetJs(filters.length ? applyPipeline(ds, filters) : ds, d.column, m0);
    }
    dims.push(planFacetDim(d.column, ranked, d.cap, order));
  }
  const { grid } = foldFacets([], dims, [], facet);
  const first = await compute(plain, filters);
  if (!first.ok) return first;
  for (const p of grid.panels) {
    const r = await compute(plain, filters.concat(p.steps));
    if (r.ok && r.data.pivot && r.data.pivot.rowHeaders.length) {
      p.pivot = r.data.pivot;
      p.empty = false;
    }
  }
  return { ...first, data: { ...first.data, facets: grid } };
}

/**
 * The faceted `visual:data` answer, or null when the encoding is not faceted
 * (the caller then runs the ordinary path). `compute` is that ordinary path,
 * passed in rather than imported so this file does not import its caller.
 */
export async function facetVizData(
  projectId: string, datasetId: string, enc: VizEncoding, filters: FilterStep[],
  compute: Compute, maxHydrateRows?: number,
): Promise<VizDataReply | null> {
  if (!isFaceted(enc)) return null;
  if (enc.pivot) return pivotFacets(projectId, datasetId, enc, filters, compute);
  let r = await residentFacets(projectId, datasetId, enc, filters);
  if (!r) {
    // The same cost ceiling the ordinary path holds its JS fallback to.
    const meta = typeof maxHydrateRows === 'number' ? await datasets.getDatasetMeta(projectId, datasetId) : null;
    if (meta && meta.rowCount > maxHydrateRows!) return { ok: false, error: 'Too large to preview without the DuckDB bridge', tooLarge: true };
    const ds = await datasets.getDataset(projectId, datasetId);
    if (!ds) return { ok: false, error: 'Dataset not found' };
    r = buildFacetData(ds.columns, ds.rows, enc, filters);
  }
  return { ok: true, data: r.data, recommendedShape: r.recommendedShape, warnings: r.warnings, category: r.category };
}
