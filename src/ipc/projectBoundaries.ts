// Boundaries IPC: import a GeoJSON file into the project (through the native
// picker this handler opens itself), list the project's sets, read one.

import { BrowserWindow, dialog } from 'electron';
import { ipcMain } from './bus';
import { getBoundary, importBoundaryFile, listBoundaries } from '../app/projectBoundaries';

export function register(): void {
  ipcMain.handle('boundary:import', async (e, { projectId }: any = {}) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender);
      const opts = {
        title: 'Import boundaries',
        properties: ['openFile' as const],
        filters: [{ name: 'GeoJSON', extensions: ['geojson', 'json'] }],
      };
      const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (pick.canceled || !pick.filePaths.length) return { ok: false, canceled: true };
      const res = await importBoundaryFile(projectId, pick.filePaths[0]);
      return 'error' in res ? { ok: false, error: res.error } : { ok: true, boundary: res };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not import those boundaries.' };
    }
  });
  ipcMain.handle('boundary:list', async (_e, { projectId }: any = {}) => ({ ok: true, boundaries: await listBoundaries(projectId) }));
  ipcMain.handle('boundary:get', async (_e, { projectId, id, property }: any = {}) => {
    const collection = await getBoundary(projectId, id, typeof property === 'string' ? property : undefined);
    return collection ? { ok: true, collection } : { ok: false, error: 'Those boundaries are missing from the project.' };
  });
}
