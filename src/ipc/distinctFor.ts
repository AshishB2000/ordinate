// One column's distinct values, resident first — under the caller's row access
// lock (docs/row-policy/00-design.md D7) — MAIN PROCESS.
//
// The filter picker (`dataset:distinct`), a metric's sparkline periods and a
// scorecard's top dimension all list values; for a restricted caller each lists
// only the values that exist in their rows (on the rule column: their entitled
// values that exist), through the same lock the chart door prepends.

import * as datasets from '../data/datasets';
import * as trace from '../engine/residentTrace';
import { distinctValuesPageJs, readDistinctPage } from '../engine/datasetPage';
import type { DistinctRequest, DistinctResult } from '../engine/datasetPage';
import { withLockOf } from './rowDoors';

/** Null when the dataset is gone. `op` names the call site for residentTrace. */
export function distinctFor(projectId: string, datasetId: string, column: string, req: DistinctRequest, op?: string): Promise<DistinctResult | null> {
  return withLockOf(projectId, datasetId, async (lock) => {
    const r: DistinctRequest = lock ? { ...req, filters: [...lock.steps] } : req;
    const src = await datasets.residentSource(projectId, datasetId);
    if (src) {
      const fast = await readDistinctPage(src, column, r);
      if (fast) {
        if (op) trace.record(op, 'resident');
        return fast;
      }
      if (op) trace.record(op, 'failed', `limit=${r.limit ?? ''}`);
    } else if (op) {
      trace.record(op, 'skipped');
    }
    const ds = await datasets.getDataset(projectId, datasetId);
    return ds ? distinctValuesPageJs(ds.columns, ds.rows, column, r) : null;
  });
}
