// A dataset REPLAYED under a dashboard's parameters. MAIN PROCESS.
//
// The prepare pipeline is baked into the stored table when it is saved, and at
// that moment there is no dashboard — so a calculated field written as
// `[revenue] * (1 - [[discount]])` is stored with `[[discount]]` unbound (null).
// When a QUERY arrives carrying parameters, and only then, a dataset whose
// pipeline references one is rebuilt from its immutable source with the values
// bound (params.bindStepParams), and the query runs over that table on the JS
// path. Everything else keeps the resident fast path untouched.
//
// ponytail: a replay is a full applyPipeline over the source, memoized per
// dataset for the last parameter set only. Fine for a slider over a sample;
// a 1M-row dataset replays in about a second per new value. Upgrade path: bind
// the parameter into sqlGen's calculated-field compile once that exists.

import * as datasets from './datasets';
import { applyPipeline } from './transforms';
import { saltForSteps } from '../app/privacyStore';
import { loadStepRefs } from './stepRefs';
import type { Cell } from './transforms';
import type { ParsedColumn } from './parse';
import { bindStepParams, stepsUseParams } from '../analysis/params';
import type { ParamValues } from '../analysis/params';
import { orgKey } from '../server/context';

export interface ReplayedTable {
  columns: ParsedColumn[];
  rows: Cell[][];
  /** Validation messages from binding — an unknown name, a list in a formula. */
  errors: string[];
}

const MEMO_MAX = 4;
const memo = new Map<string, { key: string; table: ReplayedTable }>();

/**
 * The dataset rebuilt with `values` bound, or null when no replay is needed —
 * no parameters on the query, or a pipeline that references none.
 */
export async function paramTable(projectId: string, datasetId: string, values: ParamValues | undefined): Promise<ReplayedTable | null> {
  if (!values || values.size === 0) return null;
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta || !stepsUseParams(meta.steps)) return null;
  const key = JSON.stringify([meta.updatedAt, [...values.entries()]]);
  const hit = memo.get(orgKey(projectId + '/' + datasetId));
  if (hit && hit.key === key) return hit.table;

  const ds = await datasets.getDataset(projectId, datasetId);
  if (!ds || !ds.source) return null;
  const bound = bindStepParams(ds.steps || [], values);
  const out = applyPipeline(ds.source, bound.steps, { salt: await saltForSteps(projectId, bound.steps), ...(await loadStepRefs(projectId, datasetId, bound.steps)) });
  const table: ReplayedTable = { columns: out.columns, rows: out.rows, errors: bound.errors };
  memo.set(orgKey(projectId + '/' + datasetId), { key, table });
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value as string);
  return table;
}
