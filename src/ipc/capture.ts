import { ipcMain, BrowserWindow } from 'electron';
import { captureHtmlToPng } from '../reportCapture';

// Snapshot a rectangular region of the hub window's rendered page to a PNG data URL.
// Used to export the Leaflet MAP (tiles + choropleth/bubble SVG overlay + legend) into
// reports: a map isn't a single <canvas>, so the renderer draws it on-screen and we
// capture the real pixels here. webContents.capturePage is native — no CORS/canvas
// tainting and no extra dependency, unlike leaflet-image / html2canvas.
export function register() {
  // ponytail: untrusted renderer payloads — any, validated field-by-field below.
  ipcMain.handle('hub:captureRegion', async (event, rect: any) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return null;
      const r = rect || {};
      const box = {
        x: Math.max(0, Math.round(r.x) || 0),
        y: Math.max(0, Math.round(r.y) || 0),
        width: Math.round(r.width) || 0,
        height: Math.round(r.height) || 0,
      };
      if (box.width <= 0 || box.height <= 0) return null;
      const img = await win.webContents.capturePage(box);
      if (!img || img.isEmpty()) return null;
      return img.toDataURL();
    } catch (e) {
      console.error('captureRegion failed', e);
      return null;
    }
  });

  // Render a self-contained HTML report (built in the renderer) to a PNG data URL
  // via a hidden, content-sized BrowserWindow + capturePage. An offscreen window
  // (vs. capturing a region of the hub) means the FULL one-pager is captured at any
  // height without being clipped by the hub window, and capturePage snapshots at the
  // display's scale factor (2x on retina) so text + chart stay crisp. No html2canvas
  // or any new dependency. The HTML is fully inline (CSS + logo SVG + chart as a
  // data: URL) and runs sandboxed with no node access.
  ipcMain.handle('hub:captureReport', async (_e, { html, width }: any = {}) =>
    // Delegates to the shared src/reportCapture.captureHtmlToPng — the ONE offscreen
    // HTML→PNG routine reused by the Week 10 dashboard export path.
    captureHtmlToPng(html, width),
  );
}
