// Workspace THEMES over IPC. MAIN PROCESS. (Not ./theme.ts — that one is the
// app's light/dark Appearance preference; this is the dashboard theme records.)
//
// Settings → Appearance → Themes and every dashboard's Style panel read and
// write here. Each write re-validates in the store, then the new state is
// PUSHED to every hub window (`themes:changed`), so a sheet already open
// repaints under the edited theme without a reload.

import { ipcMain } from './bus';
import * as store from '../app/themeStore';

export function register(): void {
  ipcMain.handle('themes:list', () => store.listThemes());
  ipcMain.handle('themes:save', async (_e, theme: unknown) => store.saveTheme(theme));
  ipcMain.handle('themes:delete', async (_e, id: unknown) => store.deleteTheme(id));
  ipcMain.handle('themes:setDefault', async (_e, id: unknown) => store.setDefaultTheme(id));
}
