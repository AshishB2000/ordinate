// A snapshot per entity's figures (semantic layer part 5, D11) — MAIN PROCESS.
//
// "MRR is each account's last MRR, summed": after every filter, the row lock and terms (the door's filter list, the
// lock first), each entity keeps its rows on its own latest (or earliest) day — per date bucket when charted by the
// snapshot's date — and the ordinary aggregate runs over those rows. Part 1's snapshot (./snapshotDoors) asks here
// first when its snapshot has a `per`. The resident twin (engine/snapshotResident) answers first and the JS reference
// (analysis/snapshot.snapshotRows over the hydrated rows) when it cannot; scripts/test-snapshotPer.ts holds them equal.
//
// Live: part 1's typed refusal comes first (./dashboards, analysis/metricMeasures). The caption: with no period in
// scope, an entity that stopped reporting still counts its last value, and the KPI's notes say so.

import type { MetricAggregation } from '../analysis/metricValue';
import { computeMetric } from '../analysis/metricValue';
import type { MetricSnapshot } from '../analysis/snapshot';
import { snapshotRows } from '../analysis/snapshot';
import type { VizEncoding } from '../analysis/visuals';
import { buildVizData, recommendChartType } from '../analysis/vizData';
import { dateBucket, parseDateCell } from '../analysis/categoryKey';
import { scopeRange } from '../analysis/periodScope';
import { needsLodPass, vizDimsOf } from '../analysis/lodQuery';
import { stepsUseParams } from '../analysis/params';
import type { ParamValues } from '../analysis/params';
import * as msg from '../analysis/metricCheckMessages';
import { isCountLike } from '../data/aggregations';
import * as answerKey from '../data/answerKey';
import * as datasets from '../data/datasets';
import { ensureFresh } from '../data/freshOnAsk';
import { applyPipeline } from '../data/transforms';
import type { Cell, FilterStep } from '../data/transforms';
import * as queryCache from '../engine/queryCache';
import { computeMetricResident } from '../engine/residentQuery';
import * as trace from '../engine/residentTrace';
import { withSnapshotRows } from '../engine/snapshotResident';
import { gateColumnsReply } from './columnDoors';
import { fxContext, fxVizContext } from './fxQuery';
import { chartReads, metricReads } from './relationships';
import type { VizDataReply } from './visuals';
import { filterCannotWarn, residentVizData } from './visualsResident';

export type PerSnapshot = MetricSnapshot & { per: string };
/** Where a chart's per-entity snapshot leaf is asked (ipc/visuals.vizDataForUnlocked's own arguments). */
export interface PerAt { projectId: string; datasetId: string; opts: { maxHydrateRows?: number; params?: ParamValues } }

type Meta = NonNullable<Awaited<ReturnType<typeof datasets.getDatasetMeta>>>;

/** The snapshot's date is still a date column and its entity still a column: else there is no figure (part 1's rule for a gone date). */
const readable = (meta: Meta, snap: PerSnapshot): boolean =>
  meta.columns.some((c) => c.name === snap.column && c.type === 'date') && meta.columns.some((c) => c.name === snap.per);

/**
 * The sentence refusing a question the kept rows cannot answer yet, or null: one the LOD pass would recompute (`lod`:
 * analysis/lodQuery.needsLodPass, as the plain path decides it; a stored FIXED field under ordinary filters IS its
 * stored value, so that is computed), a pipeline replayed with the query's parameters, a field or filter on a related
 * table, or a converted measure. Never computed without it.
 * shortcut: per-entity snapshots read the dataset's own stored rows only; compose with fxRelationSql / the join relation / the LOD pass when asked for
 */
async function refusal(meta: Meta, snap: PerSnapshot, lod: boolean, filters: FilterStep[], params: ParamValues | undefined, related: () => Promise<boolean>, fx: () => Promise<unknown>): Promise<string | null> {
  if (lod) return msg.snapshotPerLod(snap.per);
  if ((params && params.size > 0 && stepsUseParams(meta.steps)) || filters.some((f) => f && (f.via || f.datasetId)) || (await related()) || (await fx())) return msg.snapshotPerUnsupported(snap.per);
  return null;
}

/** The JS partition by the axis's date bucket, when charted by the snapshot's own date. */
function bucketOf(columns: { name: string }[], snap: PerSnapshot, enc: VizEncoding): ((row: Cell[]) => string | null) | undefined {
  const at = columns.findIndex((c) => c.name === snap.column);
  const grain = enc.category === snap.column ? enc.grain : undefined;
  if (!grain || at < 0) return undefined;
  return (row) => {
    const c = parseDateCell(row[at]);
    return c ? String(dateBucket(c, grain)) : null;
  };
}

/** A per-entity snapshot KPI: `spec`'s aggregate over the rows each entity keeps under `filters` (the KPI door's, the lock first). */
export async function perEntityCardMetric(
  projectId: string,
  datasetId: string,
  spec: { column: string; aggregation: MetricAggregation; snapshot: PerSnapshot },
  filters: FilterStep[],
  params?: ParamValues,
): Promise<{ ok: boolean; value: number | null; notes?: string[] }> {
  await ensureFresh(projectId, [datasetId]); // L3.1 fresh on ask: before the cache key reads the record
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, value: null };
  const snap = spec.snapshot;
  if (!readable(meta, snap)) return { ok: true, value: null };
  const fx = () => (isCountLike(spec.aggregation) ? Promise.resolve(null) : fxContext(projectId, datasetId, [spec.column], [spec.column, ...filters.map((f) => f.column)]));
  const why = await refusal(meta, snap, needsLodPass(meta.steps, filters, [], spec.column), filters, params, async () => (await metricReads(projectId, datasetId, spec.column, filters)).length > 0, fx);
  if (why) return { ok: true, value: null, notes: [why] };
  const notes = scopeRange(filters, [{ name: snap.column, type: 'date' }]) ? {} : { notes: [msg.snapshotPerStale(snap.per)] };
  const figure = { column: spec.column, aggregation: spec.aggregation };
  const run = async (): Promise<{ ok: boolean; value: number | null; notes?: string[] }> => {
    const src = await datasets.residentSource(projectId, datasetId);
    if (src) {
      const v = await withSnapshotRows(src, filters, snap, null, (kept) => computeMetricResident(kept, figure, []));
      if (v !== null) {
        trace.record('snapshotPer', 'resident');
        return { ok: true, value: v, ...notes };
      }
      trace.record('snapshotPer', 'failed', `aggregation=${spec.aggregation}, filters=${filters.length}`); // or a real null: the reference decides
    } else {
      trace.record('snapshotPer', 'skipped');
    }
    const ds = await datasets.getDataset(projectId, datasetId);
    if (!ds) return { ok: false, value: null };
    const t = applyPipeline({ columns: ds.columns, rows: ds.rows }, filters);
    return { ok: true, value: computeMetric(t.columns, snapshotRows(t.columns, t.rows, snap), figure), ...notes };
  };
  // The answer cache, keyed with the snapshot: a per figure is not the plain one under the same filters.
  const parts = await answerKey.keyParts(projectId, datasetId);
  if (!parts) return run();
  const key = queryCache.cacheKey('metric', parts, { ...figure, filters, params: params ?? null, ...answerKey.ambient(), snapshot: snap });
  return queryCache.through('metric', key, [datasetId, queryCache.projectDep(projectId)], run, (r) => r.ok);
}

/**
 * A chart's per-entity snapshot leaf: the chart over the rows each entity keeps (each entity per date bucket when
 * `enc` is by the snapshot's date, its grain already pinned by ./snapshotDoors), under the chart door's filters.
 */
export async function perEntityChart(projectId: string, datasetId: string, snap: PerSnapshot, enc: VizEncoding, filters: FilterStep[], opts: PerAt['opts']): Promise<VizDataReply> {
  // Not asked through the chart door, so its column gate (part 4) is here: a hidden column in any role refuses first.
  const hidden = await gateColumnsReply(projectId, datasetId, async () => [], [enc, filters, snap], async () => null);
  if (hidden) return hidden;
  await ensureFresh(projectId, [datasetId]);
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, error: 'Dataset not found' };
  if (!readable(meta, snap)) return { ok: true, data: { labels: [], series: [] }, recommendedShape: recommendChartType(meta.columns, enc).shape, warnings: [] };
  const otherTable = async () => !!(enc.categoryDatasetId || enc.seriesDatasetId || enc.values.some((v) => v && v.datasetId)) || (await chartReads(projectId, datasetId, enc, filters)).length > 0;
  const why = await refusal(meta, snap, needsLodPass(meta.steps, filters, vizDimsOf(enc)), filters, opts.params, otherTable, () => fxVizContext(projectId, datasetId, enc, filters)); // a leaf's LOD expression is refused by the planner
  if (why) return { ok: false, error: why };
  const bucket = enc.category === snap.column ? enc.grain ?? null : null;
  const run = async (): Promise<VizDataReply> => {
    const src = await datasets.residentSource(projectId, datasetId);
    const names = new Set(meta.columns.map((c) => c.name));
    // The kept rows carry no filter of their own, so a filter that would warn leaves the answer to the reference.
    if (src && filters.every((f) => filterCannotWarn(f, names))) {
      const fast = await withSnapshotRows(src, filters, snap, bucket, (kept) => residentVizData(projectId, datasetId, enc, [], kept)); // traced inside
      if (fast) return { ok: true, data: fast.data, recommendedShape: fast.recommendedShape, warnings: fast.warnings, category: fast.category };
    }
    if (typeof opts.maxHydrateRows === 'number' && meta.rowCount > opts.maxHydrateRows) return { ok: false, error: 'Too large to preview without the DuckDB bridge', tooLarge: true };
    const ds = await datasets.getDataset(projectId, datasetId);
    if (!ds) return { ok: false, error: 'Dataset not found' };
    const t = applyPipeline({ columns: ds.columns, rows: ds.rows }, filters);
    const r = buildVizData(t.columns, snapshotRows(t.columns, t.rows, snap, bucketOf(t.columns, snap, enc)), enc, []);
    return { ok: true, data: r.data, recommendedShape: r.recommendedShape, warnings: t.warnings.concat(r.warnings), category: r.category };
  };
  const parts = await answerKey.keyParts(projectId, datasetId);
  if (!parts) return run();
  const key = queryCache.cacheKey('aggregate', parts, { encoding: enc, filters, snapshot: snap, params: opts.params ?? null, max: opts.maxHydrateRows ?? null, ...answerKey.ambient() });
  return queryCache.through('aggregate', key, [datasetId, queryCache.projectDep(projectId)], run, (r) => r.ok);
}
