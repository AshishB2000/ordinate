// The dashboard viewer's server-only channel (T2.9): the "As of" picker's
// snapshot times. The desktop asks `snapshots:stamps` (src/ipc/snapshots.ts),
// whose module also restores and diffs snapshots — the Snapshots screen's
// (T2.11) to put on the server. This answers the picker with the SAME function,
// so the two lists cannot differ.

import { ipcMain } from './bus';
import { snapshotStamps } from './snapshots';

export function register(): void {
  ipcMain.handle('dashboard:asOfStamps', async (_e, { projectId, datasetIds, metricIds }: { projectId: string; datasetIds: string[]; metricIds: string[] }) =>
    snapshotStamps(projectId, datasetIds, metricIds));
}
