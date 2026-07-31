import * as path from 'path';
import { BrowserWindow, Display } from 'electron';

const ROOT = path.join(__dirname, '..', '..');

// Fullscreen-but-not-OS-fullscreen overlay covering the display. The dim is a
// CSS layer painted over an opaque frozen screenshot, so we do NOT need a
// transparent window (transparent + frameless is buggy across platforms).
// Avoiding fullscreen:true / kiosk:true keeps show instant and Escape clean.
export function createOverlayWindow(display: Display): BrowserWindow {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    enableLargerThanScreen: true, // macOS safety
    webPreferences: {
      preload: path.join(ROOT, 'preload', 'overlayPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Float above almost everything (menubar, fullscreen apps) on macOS.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);

  win.loadFile(path.join(ROOT, 'renderer', 'overlay', 'index.html'));
  return win;
}
