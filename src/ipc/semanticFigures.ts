// What the figure doors do on a semantic dataset (semantic layer part 7, b2; docs/semantic-layer/07-portability.md
// D12, D13, D16) — MAIN PROCESS. The doors stay ./visuals `vizDataFor`, ./dashboards `computeCardMetric` and
// ./answers `computeCard`; this is their small semantic part:
//
//   mirrors     a chart's or answer's measures name mirror metrics by id; each is asked of the layer by its name
//               there, and its series is labelled with the mirror's Ordinate name
//   KPIs        a mirror resolves to `{ metric: external }` on its own semantic dataset; one on a dataset that is no
//               semantic one keeps b0's refusal (no layer here to ask); inside a formula or a period it is refused
//               (`formulaOverLayer`: a layer's figures are never combined here)

import * as metrics from '../analysis/metrics';
import type { Metric } from '../analysis/metrics';
import type { MetricExternalDefinition } from '../analysis/externalMetric';
import { ExternalMetricError, externalRefusal, isExternalDefinition } from '../analysis/externalMetric';
import type { ParamValues } from '../analysis/params';
import type { VizEncoding } from '../analysis/visuals';
import type { ChartData } from '../analysis/vizData';
import * as datasets from '../data/datasets';
import type { DatasetMeta } from '../data/datasets';
import type { FilterStep } from '../data/transforms';
import { LiveFigureError } from '../engine/live/liveFigureError';
import type { LiveFailure } from '../engine/live/liveQuery';
import type { LayerRefusalCode } from '../engine/live/liveSpec';
import type { RowNeedingCode } from '../engine/live/semantic/semanticRefusals';
import { layerLabel, refuseLayer } from '../engine/live/semantic/semanticRefusals';
import { computeCardMetric } from './dashboards';

export type Mirror = { external: string; name: string };

/** The sentence names for a semantic dataset's refusals. */
export function layerNames(meta: Pick<DatasetMeta, 'name' | 'live'>): { dataset: string; layer: string } {
  return { dataset: meta.name, layer: layerLabel(meta.live?.semantic?.backend ?? '') };
}

/** A refusal of a semantic dataset's figure, as a door answers it. */
export function layerFailure(meta: Pick<DatasetMeta, 'name' | 'live'>, code: LayerRefusalCode | RowNeedingCode, extra: { metric?: string; column?: string } = {}): LiveFailure {
  const r = refuseLayer(code, { ...layerNames(meta), ...extra });
  return { ok: false, code: 'live_refused', reason: r.code, error: r.message };
}

/** The mirrors among `ids` that belong to `datasetId`: id → its layer name and its Ordinate name. */
export async function mirrorsOf(projectId: string, datasetId: string, ids: readonly unknown[]): Promise<Map<string, Mirror>> {
  const out = new Map<string, Mirror>();
  for (const id of new Set(ids)) {
    if (typeof id !== 'string') continue;
    const m = await metrics.getMetric(projectId, id);
    if (m && m.datasetId === datasetId && isExternalDefinition(m.definition)) out.set(id, { external: m.definition.external, name: m.name });
  }
  return out;
}

/** The layer names the adapter reads (`AdaptOpts.mirrors`). */
export const externalsOf = (mirrors: ReadonlyMap<string, Mirror>): Map<string, string> => new Map([...mirrors].map(([id, m]) => [id, m.external]));

/** An unsplit chart's series, each named by its measure's mirror (a split's series are its values). */
export function relabelled(data: ChartData, encoding: VizEncoding, mirrors: ReadonlyMap<string, Mirror>): ChartData {
  if (encoding.series) return data;
  const values = Array.isArray(encoding.values) ? encoding.values : [];
  return { ...data, series: data.series.map((s, i) => {
    const m = typeof values[i]?.metricId === 'string' ? mirrors.get(values[i].metricId as string) : undefined;
    return m ? { ...s, name: m.name } : s;
  }) };
}

/** A mirror's KPI spec when `m` is one on its own semantic dataset, else null. */
export async function mirrorSpec(projectId: string, m: Pick<Metric, 'datasetId' | 'definition'>): Promise<{ metric: string } | null> {
  if (!isExternalDefinition(m.definition)) return null;
  return (await datasets.getDatasetMeta(projectId, m.datasetId))?.live?.semantic ? { metric: m.definition.external } : null;
}

/**
 * A mirror's figure (ipc/metrics `resolveDefinition`): the layer's answer through the KPI door. `depth` > 0 (a formula's
 * operand, a period's base) is refused `formulaOverLayer`; a dataset with no layer keeps b0's refusal. Throws either.
 */
export async function layerFigure(projectId: string, datasetId: string, definition: MetricExternalDefinition, filters: FilterStep[], params: ParamValues | undefined, depth: number, name?: string) {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta?.live?.semantic) throw new ExternalMetricError('pending', name ?? definition.external);
  if (depth > 0) throw new LiveFigureError(layerFailure(meta, 'formulaOverLayer', { metric: name ?? definition.external }));
  return computeCardMetric(projectId, datasetId, { metric: definition.external }, filters, params);
}

/**
 * A story's metric block over a layer's metrics (b3): each is asked through the KPI door, as a dashboard's KPI is; the
 * block's typed refusal when one is not answered (b0's where no layer is here to ask), else null and the block draws.
 */
export async function layerBlockRefusal(projectId: string, ids: string[], ask: (id: string) => Promise<Record<string, unknown> | null>): Promise<Record<string, unknown> | null> {
  for (const id of ids) {
    const m = await metrics.getMetric(projectId, id);
    if (!m || !isExternalDefinition(m.definition)) continue;
    if (!(await datasets.getDatasetMeta(projectId, m.datasetId))?.live?.semantic) return externalRefusal(new ExternalMetricError('pending', m.name));
    const r = await ask(id);
    if (r && r.ok === false) return { ok: false, code: r.code, ...(r.reason ? { reason: r.reason } : {}), error: r.error };
  }
  return null;
}
