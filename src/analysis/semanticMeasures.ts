// A chart's metric measures on a semantic dataset (semantic layer part 7, b2; docs/semantic-layer/07-portability.md
// D12, D16) — MAIN PROCESS. Read records only, never a row.
//
// On a semantic dataset the planner (./metricMeasures) plans nothing: a mirror measure is asked of the layer by the
// chart door itself (ipc/liveRoute), which refuses anything that is not a mirror (`columnOnLayer`). Only a FORMULA
// metric is refused here, before the door: over mirrors (`formulaOverLayer`: a layer's figures are never combined
// here) or over the dataset's fields (`columnOnLayer`: aggregating a dimension ourselves goes around the layer).

import * as metrics from './metrics';
import type { PlanResult } from './metricMeasures';
import type { VizEncoding } from './visuals';
import { compileMetricFormula } from './metricFormula';
import * as datasets from '../data/datasets';
import { layerLabel, refuseLayer } from '../engine/live/semantic/semanticRefusals';

/** undefined: not a semantic dataset (the planner goes on); null: the door draws it; else the refusal. */
export async function semanticMeasures(projectId: string, datasetId: string, encoding: VizEncoding): Promise<PlanResult | null | undefined> {
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  const sem = meta?.live?.semantic;
  if (!meta || !sem) return undefined;
  const names = { dataset: meta.name, layer: layerLabel(sem.backend) };
  const values = [...(encoding?.pivot?.values ?? []), ...(Array.isArray(encoding?.values) ? encoding.values : [])];
  for (const v of values) {
    const m = typeof v?.metricId === 'string' ? await metrics.getMetric(projectId, v.metricId) : null;
    if (!m || !metrics.isFormulaDefinition(m.definition)) continue;
    const c = compileMetricFormula(m.definition.formula, meta.columns.map((x) => x.name));
    const ref = c.ok ? c.program.metricRefs[0] : undefined;
    const column = c.ok ? c.program.aggregates[0]?.column : undefined;
    const r = ref === undefined && column !== undefined ? refuseLayer('columnOnLayer', { ...names, column }) : refuseLayer('formulaOverLayer', { ...names, metric: ref ?? m.name });
    return { ok: false, error: r.message, code: 'live_refused', reason: r.code };
  }
  return null;
}
