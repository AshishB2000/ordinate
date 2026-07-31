import { ipcMain, app } from 'electron';

// File-save dialogs — route image / PDF / PPTX / DOCX exports through the native
// save panel (no broad folder entitlement; the user picks each destination file).
// Extracted from main.js as a pure structural move (no logic changes).
export function register() {
  // ponytail: untrusted renderer payloads — any, validated field-by-field below.
  ipcMain.handle('hub:saveImage', async (_e, { src, defaultName }: any = {}) => {
    if (typeof src !== 'string' || !src) return { ok: false };
    const { dialog } = require('electron');
    const path = require('path');
    const fs = require('fs');

    let buf;
    if (src.startsWith('data:image/')) {
      const base64 = src.replace(/^data:image\/[^;]+;base64,/, '');
      buf = Buffer.from(base64, 'base64');
    } else if (src.startsWith('file://')) {
      const fp = decodeURIComponent(src.replace(/^file:\/\//, ''));
      try { buf = fs.readFileSync(fp); } catch (e) { return { ok: false }; }
    } else {
      return { ok: false };
    }

    // Title-derived name from PNG export, else the timestamped screenshot default.
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safe = (typeof defaultName === 'string' && /\.png$/i.test(defaultName)) ? defaultName : `screenchart-${ts}.png`;

    // Saving always goes through the native save panel. It runs out-of-process and
    // grants write access only to the single file the user picks, so we need NO
    // broad folder entitlement and trigger NO Downloads/Documents/Desktop access
    // prompt. The app never writes to a user folder without this explicit pick.
    const { filePath: savePath, canceled } = await dialog.showSaveDialog({
      title: 'Save image',
      defaultPath: path.join(app.getPath('downloads'), safe),
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (canceled || !savePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(savePath, buf);
      return { ok: true, dest: savePath };
    } catch (e) {
      console.error('saveImage failed', e);
      return { ok: false };
    }
  });

  // Save a generated PDF report. The renderer builds the PDF (pdfmake) and sends its
  // base64 bytes; we route through the same native save panel as images — no broad
  // folder entitlement, the user picks the single destination file.
  ipcMain.handle('hub:savePdf', async (_e, { base64, defaultName }: any = {}) => {
    if (typeof base64 !== 'string' || !base64) return { ok: false };
    const { dialog } = require('electron');
    const path = require('path');
    const fs = require('fs');

    let buf;
    try { buf = Buffer.from(base64, 'base64'); } catch (e) { return { ok: false }; }
    if (!buf || !buf.length) return { ok: false };

    const safe = (typeof defaultName === 'string' && /\.pdf$/i.test(defaultName)) ? defaultName : 'screenchart-report.pdf';
    const { filePath: savePath, canceled } = await dialog.showSaveDialog({
      title: 'Save report',
      defaultPath: path.join(app.getPath('downloads'), safe),
      filters: [{ name: 'PDF Document', extensions: ['pdf'] }],
    });
    if (canceled || !savePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(savePath, buf);
      return { ok: true, dest: savePath };
    } catch (e) {
      console.error('savePdf failed', e);
      return { ok: false };
    }
  });

  // Save a generated PowerPoint (.pptx) report. Same native-panel flow as savePdf.
  ipcMain.handle('hub:savePptx', async (_e, { base64, defaultName }: any = {}) => {
    if (typeof base64 !== 'string' || !base64) return { ok: false };
    const { dialog } = require('electron');
    const path = require('path');
    const fs = require('fs');

    let buf;
    try { buf = Buffer.from(base64, 'base64'); } catch (e) { return { ok: false }; }
    if (!buf || !buf.length) return { ok: false };

    const safe = (typeof defaultName === 'string' && /\.pptx$/i.test(defaultName)) ? defaultName : 'screenchart-report.pptx';
    const { filePath: savePath, canceled } = await dialog.showSaveDialog({
      title: 'Save presentation',
      defaultPath: path.join(app.getPath('downloads'), safe),
      filters: [{ name: 'PowerPoint Presentation', extensions: ['pptx'] }],
    });
    if (canceled || !savePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(savePath, buf);
      return { ok: true, dest: savePath };
    } catch (e) {
      console.error('savePptx failed', e);
      return { ok: false };
    }
  });

  ipcMain.handle('hub:saveDocx', async (_e, { base64, defaultName }: any = {}) => {
    if (typeof base64 !== 'string' || !base64) return { ok: false };
    const { dialog } = require('electron');
    const path = require('path');
    const fs = require('fs');

    let buf;
    try { buf = Buffer.from(base64, 'base64'); } catch (e) { return { ok: false }; }
    if (!buf || !buf.length) return { ok: false };

    const safe = (typeof defaultName === 'string' && /\.docx$/i.test(defaultName)) ? defaultName : 'screenchart-report.docx';
    const { filePath: savePath, canceled } = await dialog.showSaveDialog({
      title: 'Save report',
      defaultPath: path.join(app.getPath('downloads'), safe),
      filters: [{ name: 'Word Document', extensions: ['docx'] }],
    });
    if (canceled || !savePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(savePath, buf);
      return { ok: true, dest: savePath };
    } catch (e) {
      console.error('saveDocx failed', e);
      return { ok: false };
    }
  });
}
