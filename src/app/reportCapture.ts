import { BrowserWindow, app } from 'electron';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Offscreen HTML → PNG / PDF capture — MAIN PROCESS. The single source for the
// "render a self-contained HTML string in a hidden, content-sized BrowserWindow and
// snapshot it" routine that `hub:captureReport` has always used. Extracted here so the
// report path AND the Week 10 dashboard export path share ONE implementation (reuse, not
// reinvent): a hidden sandboxed window (no node access), fonts + every <img> awaited so
// nothing is captured half-painted, sized to the full content height so a footer is
// never clipped, then captured at the display scale factor (2× on retina) for crisp text
// and charts. No html2canvas / new dependency — capturePage + printToPDF are native
// Chromium.
//
// NO-WEBGL INVARIANT (Phase 4 — MapLibre). The HTML rendered here is RASTER ONLY: every
// map card and every plugin chart arrives as an already-captured `data:` PNG <img>, and
// the only live drawing is core Chart.js on a 2D canvas. A MapLibre map is NEVER built
// inside this window. That is deliberate, not incidental:
//   • a hidden BrowserWindow is the least reliable place to run WebGL — it depends on
//     `paintWhenInitiallyHidden` keeping the compositor alive, and on a GPU (or a
//     SwiftShader fallback) being available to a window nobody is looking at;
//   • the map is instead rendered in the VISIBLE hub window and snapshotted through
//     `hub:captureRegion`, where WebGL is unambiguously composited (see
//     renderer/hub/reportExport.ts `captureMapPNG` and src/ipc/capture.ts);
//   • `settleAndSize` below waits on `document.images`, which is exactly the right
//     barrier for a page of PNGs and would be the WRONG one for a live GL map (an <img>
//     load event says nothing about a map having finished rendering).
// If a live map is ever wanted in an exported page, it needs its own idle barrier and a
// verified GPU path in a hidden window — do not assume this routine covers it.

/**
 * Load `html` into the offscreen window from a TEMP FILE, not a data: URL.
 *
 * A `data:text/html,` + encodeURIComponent() navigation has a size ceiling, and
 * a dashboard one-pager is mostly base64 PNG — the sample dashboard alone came
 * to 2.4 MB of HTML, which `loadURL` refused, and every caller reports that as
 * "Could not render the dashboard". Nothing here needs a data: origin: both the
 * report and the dashboard one-pager are fully self-contained (inline CSS,
 * `data:` images, no relative URL and no network), which is exactly what makes
 * a file:// origin equivalent — and the window is still sandboxed with no node
 * integration, and Chromium blocks file→file reads from a page by default.
 *
 * The temp file is removed in `finally`, whether or not the capture worked.
 */
async function loadHtml(win: BrowserWindow, html: string): Promise<string> {
  const file = path.join(app.getPath('temp'), 'ordinate-capture-' + randomUUID() + '.html');
  await fs.promises.writeFile(file, html, 'utf8');
  try {
    await win.loadFile(file);
  } catch (e) {
    await fs.promises.rm(file, { force: true }).catch(() => {});
    throw e;
  }
  return file;
}

function discard(file: string | undefined): void {
  if (file) fs.promises.rm(file, { force: true }).catch(() => { /* temp file */ });
}

function offscreenWindow(width: number): BrowserWindow {
  const w = Math.max(320, Math.min(1600, Math.round(width) || 640));
  return new BrowserWindow({
    width: w,
    height: 800,
    show: false,
    enableLargerThanScreen: true, // allow a content height taller than the screen
    backgroundColor: '#ffffff',
    // Cast: paintWhenInitiallyHidden is kept exactly where the JS original put it
    // (electron.d.ts doesn't list it under WebPreferences).
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      paintWhenInitiallyHidden: true, // render even though never shown
      backgroundThrottling: false,
    } as Electron.WebPreferences,
  });
}

// Wait for fonts and EVERY <img> (chart PNGs, embedded map snapshots) so the snapshot is
// never taken half-painted, then size the window to the full scroll height and let two
// animation frames lay out + paint before returning. Generic over any report/dashboard
// HTML (the old report used a single `img.report-chart`; this awaits all images).
async function settleAndSize(win: BrowserWindow, width: number): Promise<void> {
  const w = Math.max(320, Math.min(1600, Math.round(width) || 640));
  await win.webContents
    .executeJavaScript(
      `new Promise(function (res) {
        function fontsReady() { return (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve(); }
        function done() { fontsReady().then(function () { res(true); }); }
        var imgs = Array.prototype.slice.call(document.images || []).filter(function (i) { return !i.complete; });
        if (imgs.length === 0) { done(); return; }
        var left = imgs.length;
        function tick() { if (--left <= 0) done(); }
        imgs.forEach(function (i) { i.addEventListener('load', tick); i.addEventListener('error', tick); });
        setTimeout(done, 3000);
      })`,
    )
    .catch(() => {});
  const h = await win.webContents
    .executeJavaScript('Math.ceil(document.body.scrollHeight)')
    .catch(() => 0);
  win.setContentSize(w, Math.max(1, Math.min(8000, h || 800)));
  await win.webContents
    .executeJavaScript(
      'new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(function () { r(true); }); }); })',
    )
    .catch(() => {});
}

// Render `html` offscreen and return a PNG data URL (2× on retina) of the full page, or
// null on failure. Used by `hub:captureReport` and `dashboard:exportPng`.
export async function captureHtmlToPng(html: string, width?: number): Promise<string | null> {
  if (typeof html !== 'string' || !html) return null;
  const w = Math.max(320, Math.min(1600, Math.round(width as number) || 640));
  let win: BrowserWindow | undefined;
  let file: string | undefined;
  try {
    win = offscreenWindow(w);
    file = await loadHtml(win, html);
    await settleAndSize(win, w);
    const img = await win.webContents.capturePage();
    return img && !img.isEmpty() ? img.toDataURL() : null;
  } catch (e) {
    console.error('captureHtmlToPng failed', e);
    return null;
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    discard(file);
  }
}

// Render `html` offscreen and return PDF bytes via Chromium's native printToPDF (no
// pdfmake, no new dependency — the same offscreen window as the PNG path). Used by
// `dashboard:exportPdf`.
export async function captureHtmlToPdf(html: string, width?: number): Promise<Buffer | null> {
  if (typeof html !== 'string' || !html) return null;
  const w = Math.max(320, Math.min(1600, Math.round(width as number) || 900));
  let win: BrowserWindow | undefined;
  let file: string | undefined;
  try {
    win = offscreenWindow(w);
    file = await loadHtml(win, html);
    await settleAndSize(win, w);
    const data = await win.webContents.printToPDF({
      printBackground: true,
      landscape: true,
      margins: { marginType: 'custom', top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
    });
    return data && data.length ? data : null;
  } catch (e) {
    console.error('captureHtmlToPdf failed', e);
    return null;
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    discard(file);
  }
}
