// Interface languages (src/app/i18n.ts): the renderer's boot catalog, read
// SYNCHRONOUSLY by preload/hubLanguagePreload.ts before the hub's first script runs
// — renderer scripts build labels at load time, so an async answer would arrive
// after the English had already been drawn — and the Settings switch.

import { app } from 'electron';
import { ipcMain } from './bus';
import * as config from '../app/config';
import { bootPayload, isLanguage, languages } from '../app/i18n';

export function register(): void {
  ipcMain.on('i18n:boot', (e) => {
    try {
      e.returnValue = { ...bootPayload(), dev: !app.isPackaged };
    } catch (_) {
      e.returnValue = null;
    }
  });
  ipcMain.handle('i18n:languages', () => languages());
  ipcMain.handle('i18n:setLanguage', (_e, code: unknown) => {
    if (!isLanguage(code)) return { ok: false, error: 'Unknown language.' };
    const cfg = config.save({ language: code });
    return { ok: true, language: cfg.language };
  });
}
