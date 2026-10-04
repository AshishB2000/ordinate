import { ipcMain } from './bus';
import * as recent from '../app/recent';
import * as config from '../app/config';
import * as execConfig from '../app/execConfig';
import * as history from '../app/history';
import * as datasets from '../data/datasets';
import * as analysis from '../analysis/analysis';
import * as visuals from '../analysis/visuals';
import { ctx, serverDataDir } from '../server/context';

// Home's IPC: the cross-project "Recent" list (see src/app/recent.ts:
// metadata-only, never hydrates a table or computes a figure), the Starred
// pins, and one project's overview for the greeting and the side column.

/** How many saved visuals Home's strip shows. */
const HOME_VISUALS = 4;

export function register() {
  ipcMain.handle('recent:list', async (_e, { limit }: any = {}) =>
    recent.listRecent(typeof limit === 'number' ? limit : 50),
  );

  // Home "Starred" pins — read the current list, or replace it wholesale. A flat
  // array of "type:id" keys; no secrets, so both directions are renderer-safe.
  // On the server they are the CALLER's pins: one member starring a dashboard
  // must not pin it for the whole org.
  ipcMain.handle('starred:get', () =>
    serverDataDir() === null ? execConfig.publicConfig().starred : config.starredFor(ctx().user.email),
  );
  ipcMain.handle('starred:set', (_e, { ids }: any = {}) =>
    serverDataDir() === null ? config.setStarred(ids) : config.setStarredFor(ctx().user.email, ids),
  );

  // One project at a glance (server; the desktop's Home makes these four reads
  // itself): the record counts the greeting names, the datasets the "Your data"
  // card lists and the first saved visuals. Counted HERE so the browser never
  // counts a figure; every field is picked, so no origin, path or crop path
  // the summaries carry reaches a browser.
  ipcMain.handle('home:overview', async (_e, { projectId }: { projectId: string }) => {
    const [ds, an, caps, vis, stands] = await Promise.all([
      datasets.listDatasets(projectId),
      analysis.listAnalyses(projectId),
      history.loadAllSummaries(projectId),
      visuals.listVisuals(projectId),
      // T2.11: "What stands out", with each card's sparkline — inside this reply, so Home makes no extra call.
      (require('./insights') as typeof import('./insights')).standsOut(projectId).catch(() => []),
    ]);
    return {
      counts: { datasets: ds.length, dashboards: an.length, captures: caps.length, visuals: vis.length },
      datasets: ds.map((d) => ({
        id: d.id,
        name: d.name,
        rowCount: d.rowCount,
        columnCount: d.columnCount,
        ...(d.qualityFailing !== undefined ? { qualityFailing: d.qualityFailing } : {}),
      })),
      visuals: vis.slice(0, HOME_VISUALS).map((v) => ({ id: v.id, name: v.name, chartType: v.chartType })),
      standsOut: stands,
    };
  });
}
