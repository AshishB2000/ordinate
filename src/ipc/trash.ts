import { ipcMain } from './bus';
import * as trash from '../app/trash';
import * as scheduler from '../app/refreshScheduler';
import { readsPublishedOnly } from '../analysis/analysis';
import { rankOn } from '../server/authz/caller';
import { ADMIN_RANK } from '../ai/agentAccess';
import { agentRestoreAdminOnly } from '../ai/agentMessages';

// Trash IPC — list, restore, delete for good, empty. The deletes that PUT
// things here are the record types' own `*:delete` handlers, each of which now
// calls trash.trashRecord instead of removing a file.
//
// `trash:changed` is pushed (send/on) after any change so the sidebar's count
// badge follows deletes made anywhere — a ⋯ menu, the sample note's Remove
// button, a purge on the scheduler's tick.
export function register(): void {
  // The purge rides the refresh scheduler's tick, which fires every minute
  // whether or not auto-refresh is on — so "30 days" holds for everyone.
  scheduler.afterTick(() => { void trash.purgeExpired().catch(() => 0); });

  // A deleted dashboard is a draft now (nothing publishes it): not a viewer's to see (docs/analysis/00-model.md).
  ipcMain.handle('trash:list', async (_e, { projectId }: any = {}) => {
    const items = await trash.list(String(projectId || ''));
    return (await readsPublishedOnly(String(projectId || ''))) ? items.filter((e) => e.type !== 'dashboard') : items;
  });

  // An Assistant agent is a project admin's to create and delete (docs/assistant-agents rule 5), so to bring back too.
  ipcMain.handle('trash:restore', async (_e, { projectId, type, id }: any = {}) => {
    if (type === 'agent' && (await rankOn(String(projectId || ''))) < ADMIN_RANK) return { ok: false, error: agentRestoreAdminOnly(), restored: [] };
    return trash.restore(String(projectId || ''), type, String(id || ''));
  });

  ipcMain.handle('trash:purge', async (_e, { projectId, type, id }: any = {}) =>
    ({ ok: await trash.purge(String(projectId || ''), type, String(id || '')) }));

  ipcMain.handle('trash:empty', async (_e, { projectId }: any = {}) =>
    ({ ok: true, removed: await trash.empty(String(projectId || '')) }));
}
