import { ipcMain } from './bus';
import * as catalog from '../app/catalog';
import * as catalogIndex from '../app/catalogIndex';

// Catalog IPC — descriptions, tags, owners and column docs (src/app/catalog.ts)
// plus the cross-record reads (src/app/catalogIndex.ts). Every id is
// UUID-checked in the store before it reaches a path, a ref is validated
// against the kind set, and `updatedBy` is stamped in main — a renderer payload
// only ever carries the fields a person typed.

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export function register(): void {
  ipcMain.handle('catalog:get', async (_e, { projectId, ref }: any = {}) => {
    const doc = await catalogIndex.getDoc(str(projectId), str(ref));
    return doc ? { ok: true, doc } : { ok: false, error: 'Unknown record.' };
  });

  ipcMain.handle('catalog:set', async (_e, { projectId, ref, patch }: any = {}) => {
    try {
      const doc = await catalogIndex.setDoc(str(projectId), str(ref), patch || {});
      return doc ? { ok: true, doc } : { ok: false, error: 'Could not save the details.' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not save the details.' };
    }
  });

  ipcMain.handle('catalog:columns', async (_e, { projectId, datasetId }: any = {}) =>
    ({ ok: true, columns: await catalog.getColumns(str(projectId), str(datasetId)) }));

  ipcMain.handle('catalog:setColumn', async (_e, { projectId, datasetId, column, patch }: any = {}) => {
    try {
      const doc = await catalog.setColumn(str(projectId), str(datasetId), str(column), patch || {});
      return doc ? { ok: true, column: doc } : { ok: false, error: 'Could not save the column notes.' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not save the column notes.' };
    }
  });

  ipcMain.handle('catalog:tags', async (_e, { projectId }: any = {}) =>
    ({ ok: true, ...(await catalogIndex.tagIndex(str(projectId))) }));

  ipcMain.handle('catalog:list', async (_e, { projectId }: any = {}) => {
    try {
      return { ok: true, rows: await catalogIndex.listRows(str(projectId)) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not read the catalog.', rows: [] };
    }
  });

  /** The report cover's "Contains financial data" lines. Values are never redacted. */
  ipcMain.handle('catalog:sensitivity', async (_e, { projectId, analysisId }: any = {}) =>
    ({ ok: true, ...(await catalogIndex.reportSensitivity(str(projectId), str(analysisId))) }));
}
