// The dashboard viewer's server-only channel (T2.9): the "As of" picker's
// snapshot times. The desktop asks `snapshots:stamps` (src/ipc/snapshots.ts),
// whose module also restores and diffs snapshots — the Snapshots screen's
// (T2.11) to put on the server. This answers the picker with the SAME function,
// so the two lists cannot differ.
//
// `latest` (L0.2): how fresh the sheet is when it reads the latest data — its
// stalest dataset's time (data/figureAsOf), so the picker's "Latest" says
// what it means. Each tile carries its own; this is the sheet's.

import { ipcMain } from './bus';
import { snapshotStamps } from './snapshots';
import * as metrics from '../analysis/metrics';
import { figureAsOf } from '../data/figureAsOf';

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function register(): void {
  ipcMain.handle('dashboard:asOfStamps', async (_e, { projectId, datasetIds, metricIds }: { projectId: string; datasetIds: string[]; metricIds: string[] }) => {
    const stamps = await snapshotStamps(projectId, datasetIds, metricIds);
    if (!stamps || stamps.ok === false) return stamps;
    // The datasets the metrics read, as snapshotStamps resolves them.
    const read = ids(datasetIds);
    for (const mid of ids(metricIds)) read.push((await metrics.getMetric(projectId, mid))?.datasetId ?? '');
    const latest = await figureAsOf(projectId, read);
    return latest ? { ...stamps, latest } : stamps;
  });
}
