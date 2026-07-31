import * as path from 'path';
import { BrowserWindow } from 'electron';

const ROOT = path.join(__dirname, '..', '..');

export function createPermissionWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 460,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Screen Recording Permission',
    webPreferences: {
      preload: path.join(ROOT, 'preload', 'permissionPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(ROOT, 'renderer', 'permission', 'index.html'));
  return win;
}
