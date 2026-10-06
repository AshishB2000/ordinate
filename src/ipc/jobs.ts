import { ipcMain } from './bus';
import * as jobs from '../app/jobs';

// Jobs IPC — the Jobs popover's list, Cancel and Clear. The queue itself is
// src/app/jobs.ts.

/**
 * The server's Jobs channels (src/server/app.ts). A tab sees, cancels and
 * clears only its own user's jobs — the queue is shared by every org on the
 * pod — each as `jobs.publicJob` (no server path). No Reveal: there is no file
 * manager to open; an export's file reaches a tab as a download (T0.4).
 */
export function registerServer(): void {
  const owner = (): string => jobs.requestOwner() ?? '\u0000'; // outside a request: matches no job
  ipcMain.handle('jobs:list', () => jobs.snapshotFor(owner()));
  ipcMain.handle('jobs:cancel', (_e, { id }: { id: string }) => ({
    ok: jobs.get(id)?.owner === owner() && jobs.cancel(id),
  }));
  ipcMain.handle('jobs:clear', () => {
    jobs.clearRecent(owner());
    return { ok: true };
  });
}
