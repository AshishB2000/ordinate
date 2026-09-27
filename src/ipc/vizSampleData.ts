// The builder's sampled chart answer — MAIN PROCESS. Its own module so that
// ./visuals.ts (which calls it from vizDataFor) and ./vizSample.ts (the
// `visual:preview` handler, which calls vizDataFor) do not import each other.

import * as datasets from '../data/datasets';
import { buildVizData } from '../analysis/vizData';
import type { VizEncoding } from '../analysis/visuals';
import type { FilterStep } from '../data/transforms';
import { SAMPLE_MIN_ROWS, SAMPLE_TARGET, stratifiedIndexes, sampleNote } from '../analysis/sampling';
import type { SampleInfo } from '../analysis/sampling';
import { sampleRowsResident } from '../engine/sampleResident';
import type { VizDataReply } from './visuals';

/**
 * The sampled answer, or null when sampling does not apply (small table, or
 * the sample could not be taken) — the caller then computes in full.
 */
export async function sampledVizData(
  projectId: string,
  datasetId: string,
  encoding: VizEncoding,
  filters: FilterStep[],
): Promise<VizDataReply | null> {
  // A cohort or funnel over a sample of EVENTS is not a smaller answer, it is a
  // wrong one (members lose the events that retain them) — compute it in full.
  if (encoding && (encoding.cohort || encoding.eventFunnel)) return null;
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta || meta.rowCount <= SAMPLE_MIN_ROWS) return null;
  const catName = encoding && typeof encoding.category === 'string' ? encoding.category : '';
  const catIndex = catName ? meta.columns.findIndex((c) => c.name === catName) : -1;

  let rows: (string | number | null)[][] | null = null;
  let total = meta.rowCount;
  const src = await datasets.residentSource(projectId, datasetId);
  if (src) {
    const s = await sampleRowsResident(src, catIndex, SAMPLE_TARGET);
    if (s) { rows = s.rows; total = s.total; }
  }
  if (!rows) {
    const ds = await datasets.getDataset(projectId, datasetId);
    if (!ds) return null;
    total = ds.rows.length;
    rows = stratifiedIndexes(ds.rows, catIndex, SAMPLE_TARGET).map((i) => ds.rows[i]);
  }
  const info: SampleInfo = { rows: rows.length, of: total, by: catIndex >= 0 ? catName : null };
  const r = buildVizData(meta.columns, rows, encoding, filters);
  return {
    ok: true,
    data: r.data,
    recommendedShape: r.recommendedShape,
    warnings: r.warnings,
    category: r.category,
    sample: { ...info, note: sampleNote(info) },
  } as VizDataReply;
}

