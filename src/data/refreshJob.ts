// A dataset refresh, run as a background job — MAIN PROCESS.
//
// The ONE wrapper both refresh doors use: the Data row / dashboard ↻ (IPC
// `dataset:refresh`) and the unattended scheduler (src/app/refreshScheduler).
// A job gives the refresh a row in the Jobs popover, Cancel, a notification
// when it lands behind an unfocused window, and the per-dataset lock — a
// scheduled refresh and a click on ↻ for the same dataset queue instead of
// racing each other's Parquet write. The write itself reports its progress to
// the job (datasets.persist reads jobs.current()).
//
// A success is ANNOUNCED here (./refreshEvents, L0.1), once, whichever door it
// came through, so every open tab of a reader redraws what reads the dataset.

import * as jobs from '../app/jobs';
import * as datasets from './datasets';
import { refreshDataset } from './datasetRefresh';
import type { RefreshResult } from './datasetRefresh';
import { announceRefreshed } from './refreshEvents';

/** Refresh through the jobs system. Never throws: a cancel is `{ok:false}`. */
export async function refreshAsJob(projectId: string, id: string, opts: { scheduled?: boolean } = {}): Promise<RefreshResult> {
  const meta = await datasets.getDatasetMeta(projectId, id);
  const name = meta ? meta.name : 'dataset';
  const job = jobs.submit<RefreshResult>({
    kind: 'refresh',
    label: (opts.scheduled ? 'Scheduled refresh · ' : 'Refresh ') + name,
    projectId,
    datasetId: id,
    run: async (ctx) => {
      ctx.progress(0.05, 'Fetching the source');
      const r = await refreshDataset(projectId, id);
      if (!r.ok) throw new Error(r.error);
      return r;
    },
    resultOf: (r) => r.ok
      ? {
        message: `${Number(r.dataset && r.dataset.rowCount || 0).toLocaleString('en-US')} rows` +
          (r.warnings.length ? ` · ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}` : ''),
      }
      : undefined,
  });
  let res: RefreshResult;
  try {
    res = await job.done;
  } catch (err: any) {
    return { ok: false, error: err instanceof jobs.JobCancelled ? 'Cancelled.' : (err?.message || 'Refresh failed') };
  }
  // After the job, not inside it: the table and its markers are both written by now.
  if (res.ok) announceRefreshed({ projectId, datasetId: id, name, rowsBefore: meta ? meta.rowCount : 0, rowsAfter: res.dataset.rowCount });
  return res;
}
