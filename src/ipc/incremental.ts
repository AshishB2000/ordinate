// Incremental refresh settings over RPC (src/data/incrementalSettings.ts) — the
// web port of the desktop's panel (T8.1 removed it). Thin: the contract checks
// the shape (src/api/incremental.ts); everything else is checked against the
// stored record by saveIncremental. A thrown error goes to the log (it can
// carry a path) and the browser gets the catalog's sentence as `{ ok:false }`.

import { ipcMain } from './bus';
import { incrementalView, saveIncremental } from '../data/incrementalSettings';
import type { IncrementalPatch } from '../data/incrementalSettings';
import { incrementalNotRead, incrementalNotSaved } from '../data/incrementalMessages';

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function register(): void {
  ipcMain.handle('incremental:get', async (_e, { projectId, datasetId }: { projectId: string; datasetId: string }) => {
    try {
      return await incrementalView(projectId, datasetId);
    } catch (err) {
      console.error('[incremental] incremental:get failed:', why(err));
      return { ok: false, error: incrementalNotRead() };
    }
  });

  ipcMain.handle('incremental:set', async (_e, { projectId, datasetId, ...patch }: { projectId: string; datasetId: string } & IncrementalPatch) => {
    try {
      return await saveIncremental(projectId, datasetId, patch);
    } catch (err) {
      console.error('[incremental] incremental:set failed:', why(err));
      return { ok: false, error: incrementalNotSaved() };
    }
  });
}
