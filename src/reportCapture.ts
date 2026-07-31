import { BrowserWindow } from 'electron';

// Offscreen HTML → PNG / PDF capture — MAIN PROCESS. The single source for the
// "render a self-contained HTML string in a hidden, content-sized BrowserWindow and
// snapshot it" routine that `hub:captureReport` has always used. Extracted here so the
// report path AND the Week 10 dashboard export path share ONE implementation (reuse, not
// reinvent): a hidden sandboxed window (no node access), fonts + every <img> awaited so
// nothing is captured half-painted, sized to the full content height so a footer is
// never clipped, then captured at the display scale factor (2× on retina) for crisp text
// and charts. No html2canvas / leaflet-image / new dependency — capturePage + printToPDF
// are native Chromium.

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
  try {
    win = offscreenWindow(w);
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await settleAndSize(win, w);
    const img = await win.webContents.capturePage();
    return img && !img.isEmpty() ? img.toDataURL() : null;
  } catch (e) {
    console.error('captureHtmlToPng failed', e);
    return null;
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
  }
}

// Render `html` offscreen and return PDF bytes via Chromium's native printToPDF (no
// pdfmake, no new dependency — the same offscreen window as the PNG path). Used by
// `dashboard:exportPdf`.
export async function captureHtmlToPdf(html: string, width?: number): Promise<Buffer | null> {
  if (typeof html !== 'string' || !html) return null;
  const w = Math.max(320, Math.min(1600, Math.round(width as number) || 900));
  let win: BrowserWindow | undefined;
  try {
    win = offscreenWindow(w);
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
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
  }
}
