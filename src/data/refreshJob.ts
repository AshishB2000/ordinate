// A dataset refresh, run as a background job — MAIN PROCESS.
//
// The ONE wrapper both refresh doors use: the Data row / dashboard ↻ (IPC
// `dataset:refresh`) and the unattended scheduler (src/app/refreshScheduler).
// A job gives the refresh a row in the Jobs popover, Cancel, a notification
// when it lands behind an unfocused window, and the per-dataset lock — a
// scheduled refresh and a click on ↻ for the same dataset queue instead of
// racing each other's Parquet write. The write itself reports its progress to
// the job (datasets.persist reads jobs.current()).

import * as jobs from '../app/jobs';
import * as datasets from './datasets';
import { refreshDataset } from './datasetRefresh';
import type { RefreshResult } from './datasetRefresh';

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
  try {
    return await job.done;
  } catch (err: any) {
    return { ok: false, error: err instanceof jobs.JobCancelled ? 'Cancelled.' : (err?.message || 'Refresh failed') };
  }
}
