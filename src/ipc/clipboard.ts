import { ipcMain, clipboard, nativeImage } from 'electron';

// Clipboard IPC — copy a captured image (data URL or file://) or text to the
// system clipboard. Extracted from main.js as a pure structural move. No state.
export function register() {
  ipcMain.on('hub:copy', (_e, src: any) => {
    if (typeof src !== 'string') return;
    if (src.startsWith('data:image/')) {
      clipboard.writeImage(nativeImage.createFromDataURL(src));
    } else if (src.startsWith('file://')) {
      const filePath = decodeURIComponent(src.replace(/^file:\/\//, ''));
      try { clipboard.writeImage(nativeImage.createFromPath(filePath)); } catch (_) {}
    }
  });

  ipcMain.on('hub:copyText', (_e, text: any) => {
    if (typeof text !== 'string') return;
    clipboard.writeText(text);
  });
}
