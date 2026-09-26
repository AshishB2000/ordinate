import { ipcMain } from 'electron';
import * as trash from '../app/trash';
import * as scheduler from '../app/refreshScheduler';
import * as hubs from '../windows/hubRegistry';

// Trash IPC — list, restore, delete for good, empty. The deletes that PUT
// things here are the record types' own `*:delete` handlers, each of which now
// calls trash.trashRecord instead of removing a file.
//
// `trash:changed` is pushed (send/on) after any change so the sidebar's count
// badge follows deletes made anywhere — a ⋯ menu, the sample note's Remove
// button, a purge on the scheduler's tick.
export function register(): void {
  // Every hub window carries the badge.
  trash.onChange((projectId) => hubs.broadcast('trash:changed', { projectId }));

  // The purge rides the refresh scheduler's tick, which fires every minute
  // whether or not auto-refresh is on — so "30 days" holds for everyone.
  scheduler.afterTick(() => { void trash.purgeExpired().catch(() => 0); });

  ipcMain.handle('trash:list', async (_e, { projectId }: any = {}) => trash.list(String(projectId || '')));

  ipcMain.handle('trash:restore', async (_e, { projectId, type, id }: any = {}) =>
    trash.restore(String(projectId || ''), type, String(id || '')));

  ipcMain.handle('trash:purge', async (_e, { projectId, type, id }: any = {}) =>
    ({ ok: await trash.purge(String(projectId || ''), type, String(id || '')) }));

  ipcMain.handle('trash:empty', async (_e, { projectId }: any = {}) =>
    ({ ok: true, removed: await trash.empty(String(projectId || '')) }));
}
