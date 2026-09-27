// The resident fast path behind `visual:data` for the cohort and event-funnel
// visuals — MAIN PROCESS. No IPC handler here; `ipc/visuals.computeVizData`
// asks this first and runs the JS reference (vizData → analysis/engineViz)
// whenever it answers null.
//
// The warning-freedom proof is the pivot's (ipc/visualsResident): the only
// thing that can warn is a filter step, and whether one can is decidable from
// the stored columns alone. An encoding that is not complete yet answers from
// COLUMNS alone — its empty state needs no rows, so none are read.

import * as datasets from '../data/datasets';
import * as trace from '../engine/residentTrace';
import type { VizEncoding } from '../analysis/visuals';
import type { VizDataResult } from '../analysis/vizData';
import type { FilterStep } from '../data/transforms';
import { cohortVizResult, engineVizData, funnelVizResult } from '../analysis/engineViz';
import { cohortNeeds } from '../analysis/cohortData';
import { funnelNeeds } from '../analysis/funnelEvents';
import { cohortGridResident } from '../engine/cohortResident';
import { eventFunnelResident } from '../engine/funnelResident';
import { filterCannotWarn } from './visualsResident';

export async function residentEngineData(
  projectId: string,
  datasetId: string,
  encoding: VizEncoding,
  filters: FilterStep[],
): Promise<VizDataResult | null> {
  try {
    if (!encoding || (!encoding.cohort && !encoding.eventFunnel)) return null;
    const op = encoding.cohort ? 'vizCohort' : 'vizEventFunnel';
    const src = await datasets.residentSource(projectId, datasetId);
    if (!src) {
      trace.record(op, 'skipped');
      return null;
    }
    const names = new Set<string>();
    for (const c of src.columns) if (c && typeof c.name === 'string') names.add(c.name);
    for (const f of filters) if (!filterCannotWarn(f, names)) return null;

    const needs = encoding.cohort ? cohortNeeds(src.columns, encoding.cohort) : funnelNeeds(src.columns, encoding.eventFunnel);
    if (needs) return engineVizData(src.columns, [], encoding, filters);

    if (encoding.cohort) {
      const grid = cohortGridResident(src, encoding.cohort, filters);
      if (!grid) {
        trace.record(op, 'failed', `grain=${encoding.cohort.grain} show=${encoding.cohort.show}`);
        return null;
      }
      trace.record(op, 'resident');
      return cohortVizResult(grid, []);
    }
    const f = encoding.eventFunnel;
    if (!f) return null;
    // A number-typed event column is a DECISION to decline (funnelResident's
    // header), not a fault — counted, silent.
    const eventCol = src.columns.find((c) => c && c.name === f.event);
    if (eventCol && eventCol.type === 'number') {
      trace.record(op, 'skipped');
      return null;
    }
    const funnel = eventFunnelResident(src, f, filters);
    if (!funnel) {
      trace.record(op, 'failed', `${f.steps.length} steps, breakdown=${f.breakdown ? 'yes' : 'no'}`);
      return null;
    }
    trace.record(op, 'resident');
    return funnelVizResult(funnel, []);
  } catch (_) {
    return null;
  }
}
