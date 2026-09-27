// Restore a snapshot: make it the current data THROUGH THE REFRESH PATH — MAIN.
//
// Not a file copy over `<id>.parquet`. The snapshot's rows go through
// `datasets.updateDatasetData`, the same write a refresh ends in, as a job of
// kind 'refresh' with the dataset's lock, so everything a refresh does happens
// here too: the data being replaced is itself kept as a snapshot (always, even
// on a dataset that is no longer eligible — a restore must never lose what it
// replaces), updatedAt moves, the answer cache drops the dataset, the prepare
// pipeline re-derives, the refresh markers are stamped and the Jobs popover
// shows it. The IPC handler then runs the refresh's after-steps (alerts,
// quality, dependents) — src/ipc/datasets.ts afterRefresh.
//
// WHICH ROWS. A dataset with a pipeline is restored from the snapshot's kept
// SOURCE, so the current steps re-derive the output exactly as a refresh would.
// A snapshot kept before the pipeline existed has no source — its table WAS the
// raw data, so it is fed in as the source. A dataset with no pipeline takes the
// kept table as it is.

import * as jobs from '../app/jobs';
import * as datasets from './datasets';
import type { Dataset } from './datasets';
import * as snapshots from './snapshots';
import * as parquetStore from '../engine/parquetStore';
import { scanDataset } from '../app/privacyStore';

export type RestoreResult = { ok: true; dataset: Dataset } | { ok: false; error: string };

export async function restoreSnapshot(projectId: string, id: string, stamp: unknown): Promise<RestoreResult> {
  const meta = await datasets.getDatasetMeta(projectId, id);
  if (!meta) return { ok: false, error: 'Dataset not found' };
  const snap = await snapshots.get(projectId, id, stamp);
  if (!snap) return { ok: false, error: 'That snapshot is no longer kept.' };

  const job = jobs.submit<Dataset>({
    kind: 'refresh',
    label: 'Restore snapshot · ' + meta.name,
    projectId,
    datasetId: id,
    run: async (ctx) => {
      ctx.progress(0.05, 'Reading the snapshot');
      const fromSource = Boolean(meta.sourceColumns && snap.sourcePath && snap.sourceColumns);
      const table = fromSource
        ? await parquetStore.readTableAsync(snap.sourcePath as string, snap.sourceColumns)
        : await parquetStore.readTableAsync(snap.parquetPath, snap.columns);
      if (!table) throw new Error('The snapshot could not be read.');
      ctx.checkCancelled();
      const updated = await snapshots.withForcedKeep(projectId, id,
        () => datasets.updateDatasetData(projectId, id, { columns: table.columns, rows: table.rows }));
      if (!updated) throw new Error('Could not write the restored data.');
      // As a refresh does: the restored data is current from NOW, which is also
      // what makes the as-of timeline read right (the replaced data keeps its
      // own fetch time as its snapshot stamp).
      await datasets.markRefresh(projectId, id, 'ok', null);
      await scanDataset(projectId, updated);
      return updated;
    },
    resultOf: (d) => ({ message: `${Number(d.rowCount || 0).toLocaleString('en-US')} rows restored` }),
  });
  try {
    return { ok: true, dataset: await job.done };
  } catch (err: any) {
    return { ok: false, error: err instanceof jobs.JobCancelled ? 'Cancelled.' : (err?.message || 'Restore failed') };
  }
}
