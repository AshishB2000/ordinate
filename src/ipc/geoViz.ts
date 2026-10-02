// The `visual:data` answer for the two r6 maps — hexbin density and route
// flows. MAIN PROCESS. `ipc/vizExtras.authoringVizData` asks here first for a
// `hexbin` / `flow` geo level; every other encoding gets null and its own path.
//
// Resident first (src/engine/geoResident.ts, over the stored Parquet, async),
// the JS reference (src/analysis/geo/geoAgg.ts) whenever the resident answer is
// not provably the same — no Parquet, a filter that would warn, a failed query.
// Both produce GROUPS; `shapeHexbin` / `shapeFlows` turn either into the map.

import * as datasets from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import type { VizEncoding } from '../analysis/visuals';
import * as trace from '../engine/residentTrace';
import { filterCannotWarn } from './visualsResident';
import {
  flowGroupsJs, geoMeasure, hexGroupsJs, shapeFlows, shapeHexbin, specProblem,
} from '../analysis/geo/geoAgg';
import type { FlowGroups, FlowSpec, HexGroups, HexSpec } from '../analysis/geo/geoAgg';
import { flowGroupsResident, hexGroupsResident } from '../engine/geoResident';

// ponytail: the reply is the visual:data envelope (VizDataReply in ipc/visuals.ts)
type Reply = any;

function specOf(encoding: VizEncoding): { spec: HexSpec | FlowSpec; flow: boolean; warning?: string } {
  const g = encoding.geo || { level: 'hexbin' };
  const m = geoMeasure(encoding);
  const hex: HexSpec = { lat: g.lat || '', lng: g.lon || '', measure: m.measure };
  if (g.level !== 'flow') return { spec: hex, flow: false, warning: m.warning };
  const flow: FlowSpec = { ...hex, lat2: g.lat2 || '', lng2: g.lon2 || '', from: g.from || '', to: g.to || '' };
  return { spec: flow, flow: true, warning: m.warning };
}

async function groupsFor(
  projectId: string, datasetId: string, spec: HexSpec | FlowSpec, flow: boolean, filters: FilterStep[],
): Promise<HexGroups | FlowGroups | null> {
  const op = flow ? 'geoFlows' : 'geoHexbin';
  const src = await datasets.residentSource(projectId, datasetId);
  if (src) {
    const names = new Set(src.columns.map((c) => c && c.name));
    if (filters.every((f) => filterCannotWarn(f, names))) {
      const fast = flow
        ? await flowGroupsResident(src, spec as FlowSpec, filters)
        : await hexGroupsResident(src, spec, filters);
      if (fast) {
        trace.record(op, 'resident');
        return fast;
      }
      trace.record(op, 'failed', `${filters.length} filter(s)`);
    }
  } else {
    trace.record(op, 'skipped');
  }
  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds) return null;
  return flow ? flowGroupsJs(ds.columns, ds.rows, spec as FlowSpec, filters) : hexGroupsJs(ds.columns, ds.rows, spec, filters);
}

/** The reply for a hexbin / flow encoding, or null for any other. */
export async function geoVizReply(projectId: string, datasetId: string, encoding: VizEncoding, filters: FilterStep[]): Promise<Reply> { // null for any other level
  const geo = encoding && encoding.geo;
  if (!geo || (geo.level !== 'hexbin' && geo.level !== 'flow')) return null;
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return { ok: false, error: 'Dataset not found' };
  const { spec, flow, warning } = specOf(encoding);
  const problem = specProblem(meta.columns, spec);
  if (problem) return { ok: false, error: problem };
  const g = await groupsFor(projectId, datasetId, spec, flow, filters);
  if (!g) return { ok: false, error: 'Dataset not found' };
  const shaped: any = flow // any: HexbinGeo | FlowGeo plus the basemap the encoding chose
    ? shapeFlows(g as FlowGroups, spec.measure)
    : shapeHexbin(g as HexGroups, spec.measure);
  if (geo.basemap) shaped.basemap = geo.basemap;
  const warnings = (warning ? [warning] : []).concat(g.warnings);
  return { ok: true, data: { labels: [], series: [], geo: shaped }, recommendedShape: 'categorical', warnings };
}
