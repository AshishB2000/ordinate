import { BrowserWindow } from 'electron';
import { ipcMain } from './bus';
import { captureHtmlToPng } from '../app/reportCapture';

// Snapshot a rectangular region of the hub window's rendered page to a PNG data URL.
// Used to export the MAP (MapLibre's WebGL canvas + the DOM legend / value chips /
// "couldn't place" note that sit on top of it) into reports: the renderer draws it
// on-screen and we capture the real pixels here.
//
// capturePage snapshots the COMPOSITED page, which is why it is the right primitive for
// a WebGL map: GL layers and DOM overlays come back in a single image, at the display's
// scale factor, and — unlike `canvas.toDataURL()` — it does not depend on the canvas
// having been created with `preserveDrawingBuffer`, because the compositor reads the
// presented surface rather than the drawing buffer. Native, so no CORS/canvas tainting
// and no extra dependency (no html2canvas, no maplibre-gl-export).
//
// The window captured here is the VISIBLE hub. Maps are deliberately never rendered in
// the hidden offscreen window used by captureHtmlToPng below — that path only ever
// receives an already-rasterized `data:` PNG. See src/reportCapture.ts.
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
