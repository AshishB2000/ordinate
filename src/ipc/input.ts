// Input tables IPC — MAIN PROCESS. Wired from src/ipc/round6.ts.
//
//   input:create       New dataset → Input table (name + column definitions)
//   input:load         the table as the grid shows it, and what is wrong with it
//   input:validate     the grid's live check of the rows it is showing — no write
//   input:save         the batches made since the last save (save on blur)
//   input:setColumns   Edit columns — rename, retype, required, lookup, add, remove
//
// Every payload is untrusted: ids are UUID-checked in the store, definitions go
// through columns.checkColumns, and every batch is replayed over the STORED
// table by edits.applyBatch, which refuses anything malformed. A save that
// lands runs what follows every data replace the user asked for — alerts,
// quality checks and the SQL datasets built on this one (datasets.afterRefresh)
// — so a metric, an alert or a scorecard target over an input table moves the
// moment the table does. Every handler answers `{ ok:false, error }` rather than
// throwing.

import { ipcMain } from 'electron';
import * as store from '../data/inputTable/store';
import { afterRefresh } from './datasets';

// ponytail: IPC payloads are JSON envelopes; every field is re-checked in the store
type Payload = Record<string, any>;

function guard<T>(run: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  return run().catch((err: unknown) => ({ ok: false as const, error: (err as Error)?.message || 'Something went wrong' }));
}

export function register(): void {
  ipcMain.handle('input:create', (_e, p: Payload = {}) =>
    guard(() => store.createInputTable(String(p.projectId || ''), { name: p.name, columns: p.columns })));

  ipcMain.handle('input:load', (_e, p: Payload = {}) =>
    guard(() => store.loadInputTable(String(p.projectId || ''), String(p.id || ''))));

  ipcMain.handle('input:validate', (_e, p: Payload = {}) =>
    guard(() => store.validateInput(String(p.projectId || ''), String(p.id || ''), p.rows)));

  ipcMain.handle('input:save', (_e, p: Payload = {}) =>
    guard(async () => {
      const pid = String(p.projectId || '');
      const id = String(p.id || '');
      const res = await store.saveInputBatches(pid, id, p.batches);
      if (res.ok) await afterRefresh(pid, id);
      return res;
    }));

  ipcMain.handle('input:setColumns', (_e, p: Payload = {}) =>
    guard(async () => {
      const pid = String(p.projectId || '');
      const id = String(p.id || '');
      const res = await store.setInputColumns(pid, id, p.columns, p.from);
      if (res.ok) await afterRefresh(pid, id);
      return res;
    }));
}
