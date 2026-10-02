// SaaS sources and folder watch — IPC and wiring. MAIN PROCESS.
//
// The six SaaS connectors need no IPC of their own: they are registry entries
// (src/connectors/saas.ts), so the existing connection:* channels create, test,
// browse, import and refresh them. What lives here is the folder watcher's
// wiring and its one channel, the workbench rail's "Watch this folder" toggle.
//
// A watched folder that changes refreshes every dataset imported from that
// connection through `refreshAsJob` — the SAME job a click on ↻ submits, so it
// gets a row in the Jobs popover, Cancel, and the per-dataset lock that queues
// it behind a refresh already running — followed by the same follow-ups the
// manual refresh runs (alert rules, data-quality rules, dependent SQL datasets)
// and the same `hub:dataset-refreshed` push the scheduler sends.

import { app, ipcMain } from 'electron';
import * as connections from '../connectors/connections';
import * as folderWatch from '../connectors/folderWatch';
import * as datasets from '../data/datasets';
import * as projects from '../app/projects';
import { refreshAsJob } from '../data/refreshJob';
import { refreshDependents } from '../data/datasetDependents';
import { runQualityChecks } from '../analysis/qualityRun';
import * as hubs from '../windows/hubRegistry';
import { onQuit } from '../app/quitCleanup';

/** Every dataset built from `connId`, refreshed one after another. Never throws. */
async function refreshFromWatch(projectId: string, connId: string): Promise<void> {
  try {
    const list = await datasets.listDatasets(projectId);
    for (const d of list.filter((x) => x.originConnId === connId)) {
      const res = await refreshAsJob(projectId, d.id);
      hubs.broadcast('hub:dataset-refreshed', {
        projectId,
        datasetId: d.id,
        name: d.name,
        ok: res.ok,
        error: res.ok ? undefined : res.error,
        rowsBefore: d.rowCount,
        rowsAfter: res.ok ? res.dataset.rowCount : d.rowCount,
      });
      if (!res.ok) continue;
      await require('./alerts').evaluateAndDeliver(projectId, d.id);
      await runQualityChecks(projectId, d.id);
      void refreshDependents(projectId, d.id);
    }
  } catch (err: unknown) {
    console.error('[folderWatch] refresh failed:', err instanceof Error ? err.message : err);
  }
}

async function allConnections(): Promise<connections.Connection[]> {
  const out: connections.Connection[] = [];
  for (const p of await projects.listProjects()) out.push(...(await connections.listConnections(p.id)));
  return out;
}

export function register(deps: { headless?: boolean }): void {
  // The rail toggle. Only a folder connection has the flag; the store's change
  // notification (below) is what actually opens or closes the watcher.
  ipcMain.handle('saas:setFolderWatch', async (_e, { projectId, connId, watch }: any = {}) => {
    try {
      const conn = await connections.getConnection(projectId, connId);
      if (!conn || !folderWatch.WATCHABLE[conn.connectorId]) return { ok: false, error: 'Not a folder connection.' };
      const saved = await connections.updateConnection(projectId, connId, { values: { watch: watch === true } });
      if (!saved) return { ok: false, error: 'Could not save the connection.' };
      return { ok: true, connection: connections.publicConnection(saved), watching: folderWatch.isWatching(connId) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not change the folder watch.' };
    }
  });

  // A CLI or MCP run must not watch folders the GUI owns.
  if (deps.headless) return;
  connections.onConnectionChange((_projectId, id, conn) => folderWatch.sync(id, conn));
  void app.whenReady().then(async () => {
    try {
      folderWatch.start({ connections: await allConnections(), refresh: (p, c) => { void refreshFromWatch(p, c); } });
    } catch (err: unknown) {
      console.error('[folderWatch] could not start:', err instanceof Error ? err.message : err);
    }
  });
  onQuit(() => folderWatch.stopAll());
}
