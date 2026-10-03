// Where an LOD expression meets a stored dataset — MAIN PROCESS. No IPC
// handler is registered here; ipc/visuals, ipc/dashboards and ipc/formula
// call in at the one point each already decides resident-vs-JS.
//
//   lodVizFor     a chart that needs the LOD pass (analysis/lodQuery.needsLodPass)
//   lodMetricFor  a KPI / metric operand that needs it — resident when the
//                 operand is one LOD over a bare column (engine/lodResident)
//   lodPreview    the formula editor's eight preview rows, whose LOD values
//                 must be aggregates over the WHOLE table, not over eight rows
//
// Each returns null when it has nothing to say, so the caller's existing path
// runs unchanged — which is every query on a dataset without an LOD field.

import * as datasets from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import type { MetricAggregation } from '../analysis/metricValue';
import type { VizEncoding } from '../analysis/visuals';
import { lodFields, lodMetricValue, lodVizData, needsLodPass, splitContext, vizDimsOf } from '../analysis/lodQuery';
import { compile } from '../formula/formula';
import type { Compiled, FValue } from '../formula/formula';
import type { LodSpec } from '../formula/formulaParse';
import { isLodExpression, lodGroupDims, lodValues } from '../formula/lod';
import { lodMetricResident, lodValuesResident } from '../engine/lodResident';
import type { ResidentLod } from '../engine/lodResident';
import type { ResidentSource } from '../engine/residentQuery';
import * as trace from '../engine/residentTrace';
import type { VizDataReply } from './visuals';

/**
 * The preview's cost model. Below 1,000 rows both paths finish inside a couple
 * of milliseconds and the tie goes to the reference — the same threshold, for
 * the same measured reason, as the KPI card's (ipc/dashboards RESIDENT_MIN_ROWS).
 * Above it the JS side is a full hydrate (~1.2 µs a row) on every debounced
 * keystroke, and the SQL side is one grouped scan returning eight values.
 */
const LOD_RESIDENT_MIN_ROWS = 1_000;
/** Past this, a preview SQL cannot answer is not attempted: a keystroke must not hydrate a million rows. */
const PREVIEW_HYDRATE_MAX = 250_000;

function residentLod(spec: LodSpec, vizDims: string[] = []): ResidentLod | null {
  return spec.argCol !== null && !spec.nested
    ? { groupDims: lodGroupDims(spec, vizDims), agg: spec.agg, argCol: spec.argCol }
    : null;
}

/** A chart through the LOD pass, or null when the query does not need one. */
export async function lodVizFor(
  projectId: string,
  datasetId: string,
  encoding: VizEncoding,
  filters: FilterStep[],
  maxHydrateRows?: number,
): Promise<VizDataReply | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta || !needsLodPass(meta.steps, filters, vizDimsOf(encoding))) return null;
  // ponytail: the chart itself is answered on the JS path (a full hydrate). The
  // resident twin is the LOD relation fed to residentVizData through
  // residentQuery.withRelation; build it when a large LOD chart is measured slow.
  trace.record('vizLod', 'skipped');
  if (typeof maxHydrateRows === 'number' && meta.rowCount > maxHydrateRows) {
    return { ok: false, error: 'Too large to preview a level-of-detail chart', tooLarge: true };
  }
  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return { ok: false, error: 'Dataset not found' };
  const r = lodVizData(ds.columns, ds.rows, ds.steps, encoding, filters);
  return { ok: true, data: r.data, recommendedShape: r.recommendedShape, warnings: r.warnings, category: r.category };
}

/** The KPI path's per-call target — see ipc/dashboards `MetricTarget`. */
interface Target {
  src: ResidentSource | null;
  ds?: datasets.Dataset | null;
}

/** A metric through the LOD pass, or null when it does not need one. */
export async function lodMetricFor(
  projectId: string,
  datasetId: string,
  spec: { column: string; aggregation: MetricAggregation },
  filters: FilterStep[],
  target: Target,
): Promise<{ ok: boolean; value: number | null } | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta || !needsLodPass(meta.steps, filters, [], spec.column)) return null;
  const { context, normal } = splitContext(filters);
  // SQL answers one LOD over a bare column when no stored LOD field has to be
  // recomputed first; `target.src` already carries the KPI path's row threshold.
  const only = isLodExpression(spec.column) && (context.length === 0 || lodFields(meta.steps).length === 0)
    ? compile(spec.column) : null;
  const lod = only && only.ok && only.fn.lods.length === 1 ? residentLod(only.fn.lods[0]) : null;
  if (target.src && lod) {
    const v = await lodMetricResident(target.src, lod, spec.aggregation, context, normal);
    if (v !== null) {
      trace.record('lodMetric', 'resident');
      return { ok: true, value: v };
    }
    trace.record('lodMetric', 'failed', `agg=${lod.agg}, dims=${lod.groupDims.length}, filters=${filters.length}`);
  } else {
    trace.record('lodMetric', 'skipped');
  }
  if (target.ds === undefined) target.ds = await datasets.getDataset(projectId, datasetId);
  const ds = target.ds;
  if (!ds) return { ok: false, value: null };
  return { ok: true, value: lodMetricValue(ds.columns, ds.rows, ds.steps, spec, filters) };
}

/**
 * Every LOD's value on the first `n` rows, over the WHOLE table — or null when
 * the table is too large to hydrate and SQL cannot answer.
 */
export async function lodPreview(projectId: string, datasetId: string, fn: Compiled, n: number): Promise<FValue[][] | null> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return null;
  const specs = fn.lods.map((l) => residentLod(l));
  const src = meta.rowCount >= LOD_RESIDENT_MIN_ROWS ? await datasets.residentSource(projectId, datasetId) : null;
  if (src && specs.every((s) => s !== null)) {
    const vals: Array<(number | null)[] | null> = [];
    for (const s of specs) vals.push(await lodValuesResident(src, s as ResidentLod, [], n));
    if (vals.every((v) => v !== null)) {
      trace.record('lodPreview', 'resident');
      return vals as FValue[][];
    }
    trace.record('lodPreview', 'failed', `${specs.length} LOD(s)`);
  } else {
    trace.record('lodPreview', 'skipped');
  }
  if (meta.rowCount > PREVIEW_HYDRATE_MAX) return null;
  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return null;
  return lodValues(fn.lods, ds.columns, ds.rows).map((v) => v.slice(0, n));
}
