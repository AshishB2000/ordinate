// `explore:suggest` (docs/explore/00-design.md) — MAIN PROCESS. A dataset's
// declared columns, ranked as starterPlan ranks them, and the questions they
// suggest: structure only (../analysis/exploreSuggest).
//
// ONE metadata read (`getDatasetMeta`), never a row — for an extract exactly as
// for a Live dataset — so the reply cannot carry a value, and a row policy has
// nothing here to restrict. The dataset is read from the project's own
// directory, so another project's dataset id finds nothing.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import { exploreSuggest } from '../analysis/exploreSuggest';
// The catalog's "This dataset no longer exists." — the same sentence for any dataset.
import { liveDatasetMissing } from '../engine/liveQueryMessages';

export function register(): void {
  ipcMain.handle('explore:suggest', async (_e, { projectId, datasetId }: { projectId?: string; datasetId?: string } = {}) => {
    const meta = await datasets.getDatasetMeta(String(projectId ?? ''), String(datasetId ?? ''));
    if (!meta) return { ok: false, error: liveDatasetMissing() };
    return { ok: true, ...exploreSuggest(meta.columns) };
  });
}
