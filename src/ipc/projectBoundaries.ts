// Boundaries IPC: import an uploaded GeoJSON file into the project, list the
// project's sets, read one (a custom choropleth's shapes).

import { ipcMain } from './bus';
import { resolveUpload } from '../server/files';
import { getBoundary, importBoundaryFile, listBoundaries } from '../app/projectBoundaries';

export function register(): void {
  ipcMain.handle('boundary:import', async (_e, { projectId, fileToken }: any = {}) => {
    try {
      // The file was uploaded first (POST /api/files) and arrives as a
      // single-use token; the client's filename is display text only.
      const upload = resolveUpload(fileToken);
      try {
        const res = await importBoundaryFile(projectId, upload.path);
        return 'error' in res ? { ok: false, error: res.error } : { ok: true, boundary: res };
      } finally {
        upload.done();
      }
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
