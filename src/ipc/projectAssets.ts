// Project assets IPC: pick an image into the project, read one back. The
// renderer names a project and an asset id, never a path — the one path this
// sees comes from the native picker it opens itself.

import { BrowserWindow, dialog } from 'electron';
import { ipcMain } from './bus';
import { importImage, readImageDataUrl } from '../app/projectAssets';

export function register(): void {
  ipcMain.handle('asset:pickImage', async (e, { projectId }: any = {}) => {
    try {
      const win = BrowserWindow.fromWebContents(e.sender);
      const opts = {
        title: 'Add an image',
        properties: ['openFile' as const],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'svg'] }],
      };
      const pick = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (pick.canceled || !pick.filePaths.length) return { ok: false, canceled: true };
      const res = await importImage(projectId, pick.filePaths[0]);
      return 'error' in res ? { ok: false, error: res.error } : { ok: true, asset: res };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not add that image.' };
    }
  });
  ipcMain.handle('asset:read', async (_e, { projectId, id, ext }: any = {}) => {
    const dataUrl = await readImageDataUrl(projectId, id, ext);
    return dataUrl ? { ok: true, dataUrl } : { ok: false, error: 'That image is missing from the project.' };
  });
}
