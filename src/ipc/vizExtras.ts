// The `visual:data` answers the single-dataset path cannot give. `ipc/visuals.
// vizDataFor` asks here FIRST; a null means "not mine", and its own path runs
// unchanged.
//
//   • a visual reaching across relationships (ipc/relationships.ts);
//   • every MAP: a point map is rows, not groups, and every map's reply is
//     finished with places, boundaries and the basemap (analysis/mapData.ts).
//     Maps never take the resident fast path anyway — buildVizData derives
//     their items from finished series — so answering them here costs nothing.

import * as datasets from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import type { VizEncoding } from '../analysis/visuals';
import { buildVizData } from '../analysis/vizData';
import { decorateGeoReply, pointItems } from '../analysis/mapData';
import { joinedVizDataFor } from './relationships';
import { geoVizReply } from './geoViz';

// ponytail: every reply below is the visual:data envelope (VizDataReply in ipc/visuals.ts), or null
async function pointMapReply(projectId: string, datasetId: string, encoding: VizEncoding, filters: FilterStep[]): Promise<any> {
  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return { ok: false, error: 'Dataset not found' };
  const r = pointItems(ds.columns, ds.rows, encoding, filters);
  if (!r.ok) return { ok: false, error: r.error };
  const geo = encoding.geo || { level: 'point' };
  const data: any = {
    labels: [],
    series: [],
    markColumn: encoding.category,
    geo: { level: 'point', points: true, items: r.items, lat: r.lat, lon: r.lon, colorColumn: geo.color, skipped: r.skipped },
  };
  if (geo.basemap) data.geo.basemap = geo.basemap;
  return { ok: true, data, recommendedShape: 'categorical', warnings: r.warnings };
}

export async function authoringVizData(
  projectId: string,
  datasetId: string,
  encoding: VizEncoding,
  filters: FilterStep[],
): Promise<any> {
  const geo = encoding && encoding.geo;
  if (geo && geo.level === 'point') return pointMapReply(projectId, datasetId, encoding, filters);
  const density = await geoVizReply(projectId, datasetId, encoding, filters); // r6:geo — hexbin / flow
  if (density) return density;
  const joined = await joinedVizDataFor(projectId, datasetId, encoding, filters);
  if (!geo) return joined;
  if (joined) return decorateGeoReply(joined, encoding);
  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return { ok: false, error: 'Dataset not found' };
  const r = buildVizData(ds.columns, ds.rows, encoding, filters);
  return decorateGeoReply({ ok: true, data: r.data, recommendedShape: r.recommendedShape, warnings: r.warnings, category: r.category }, encoding);
}
