import * as path from 'path';
import { BrowserWindow } from 'electron';

const ROOT = path.join(__dirname, '..', '..');

export function createAboutWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 480,
    height: 540,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'About Screenchart',
    webPreferences: {
      preload: path.join(ROOT, 'preload', 'aboutPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(ROOT, 'renderer', 'about', 'index.html'));
  return win;
}
