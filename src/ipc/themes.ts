// Workspace THEMES over IPC. MAIN PROCESS. (Not ./theme.ts — that one is the
// app's light/dark Appearance preference; this is the dashboard theme records.)
//
// Settings → Appearance → Themes and every dashboard's Style panel read and
// write here. Each write re-validates in the store, then the new state is
// PUSHED to every hub window (`themes:changed`), so a sheet already open
// repaints under the edited theme without a reload.

import { ipcMain } from 'electron';
import * as store from '../app/themeStore';
import * as hubs from '../windows/hubRegistry';

export function register(): void {
  const push = async (): Promise<void> => {
    hubs.broadcast('themes:changed', await store.listThemes());
  };
  const after = async <T>(res: T): Promise<T> => {
    await push();
    return res;
  };

  ipcMain.handle('themes:list', () => store.listThemes());
  ipcMain.handle('themes:save', async (_e, theme: unknown) => after(await store.saveTheme(theme)));
  ipcMain.handle('themes:delete', async (_e, id: unknown) => after(await store.deleteTheme(id)));
  ipcMain.handle('themes:setDefault', async (_e, id: unknown) => after(await store.setDefaultTheme(id)));
}
