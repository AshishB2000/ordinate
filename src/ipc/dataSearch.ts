// Search inside the data over IPC — MAIN PROCESS. Wired from src/ipc/round8.ts.
//
//   dataSearch:query   ⌘K's "Data" group: { projectId, term, dashboardId? } →
//                      { ok, hits, partial, searched } | { ok:false, cancelled }
//
// The work is src/data/dataSearchRun.ts; this file only checks the payload and
// knows which datasets the open dashboard reads (the typed filter's own list,
// ipc/filterParse.ts), so a hit can offer "Filter this dashboard". A newer
// query cancels an older one in flight — the renderer drops stale replies too.

import { ipcMain } from './bus';
import { isValidId } from '../app/ids';
import { runSearch } from '../data/dataSearchRun';
import { dashboardDatasetIds } from './filterParse';

// ponytail: IPC payloads are JSON envelopes; every field is re-checked below
type Payload = Record<string, any>;

export function register(): void {
  ipcMain.handle('dataSearch:query', async (_e, p: Payload = {}) => {
    try {
      const projectId = typeof p.projectId === 'string' && isValidId(p.projectId) ? p.projectId : '';
      const dashboardId = typeof p.dashboardId === 'string' && isValidId(p.dashboardId) ? p.dashboardId : '';
      const dash = projectId && dashboardId ? await dashboardDatasetIds(projectId, dashboardId) : null;
      return await runSearch({ projectId, term: String(p.term || ''), dashboardDatasets: dash ? new Set(dash) : undefined });
    } catch (err: unknown) {
      return { ok: false, hits: [], partial: [], searched: 0, error: (err as Error)?.message || 'Search failed' };
    }
  });
}
