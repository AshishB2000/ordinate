import { ipcMain } from 'electron';
import * as recent from '../app/recent';

// Cross-project "Recent" list IPC — one read-only channel. See src/recent.ts:
// metadata-only, never hydrates a table or computes a figure.
export function register() {
  ipcMain.handle('recent:list', async (_e, { limit }: any = {}) =>
    recent.listRecent(typeof limit === 'number' ? limit : 50),
  );
}
