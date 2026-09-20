// EXPORT FIDELITY — what actually lands on disk when you export a dashboard.
//
// The bug this file exists to catch: charts were captured off the LIVE canvases,
// which carry the app's Appearance. With the app in dark mode, a PNG export of a
// light dashboard came back as a light sheet with dark chart rectangles pasted
// onto it — three of them, plus a dark choropleth — and the PDF was the same
// page. An export must be rendered under the DASHBOARD's own style, whatever the
// app is set to.
//
// So the app is put into dark mode THROUGH THE REAL APPEARANCE CONTROL first
// (same path smoke-theme.ts drives), and everything after that is measured on
// the produced FILES, not on the DOM that produced them:
//
//   • all three formats are exported for real, through the export dialog and the
//     dashboard:export* IPC, with dialog.showSaveDialog stubbed to this run's
//     own tmp dir — Playwright cannot drive a native save panel;
//   • the PNG is read back as pixels (Electron's own nativeImage, no new
//     dependency) and asserted LIGHT — both overall and down the column through
//     the first chart card, which is where the dark rectangles were;
//   • the HTML is loaded into a hidden BrowserWindow and every chart card is
//     asserted to have actually DRAWN. A chart that throws leaves a plausible
//     blank canvas behind, so "the element exists" proves nothing — the canvases
//     are read for non-zero pixels and the images for non-zero natural size.

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-export-'));
const shotDir = process.env.SMOKE_ARTIFACT_DIR || userData;

// The one-pager's page box, mirroring DASH_EXPORT_PAGE_W / DASH_EXPORT_PAD in
// renderer/hub/dashShare.ts. They are `const`s in a classic script, so they are
// not on `window` and cannot be read across the bridge; `dashExportMeasure()` is
// a function declaration and IS, which is where the gap comes from below.
const PAGE_W = 1160;
const PAGE_PAD = 20;
const GRID_COLS = 12;

/**
 * Wait for an export to actually finish writing, or give up.
 *
 * Call clearFile(p) BEFORE triggering the export. SMOKE_ARTIFACT_DIR is reused
 * between runs on CI, and a leftover file from the last one satisfies this wait
 * instantly — which lets the NEXT export start while this one is still
 * capturing, and a map capture snapshots the live window, so the overlapping
 * export's dialog ends up composited into the map.
 */
function clearFile(p: string): void {
  try { fs.rmSync(p, { force: true }); } catch (_) { /* nothing to clear */ }
}

async function waitForFile(p: string, timeoutMs: number): Promise<number> {
  const until = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < until) {
    if (fs.existsSync(p)) {
      const size = fs.statSync(p).size;
      // Two equal reads = the write has settled, not caught mid-flush.
      if (size > 0 && size === last) return size;
      last = size;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return fs.existsSync(p) ? fs.statSync(p).size : 0;
}

async function main(): Promise<void> {
  const app = await _electron.launch({
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData, '--enable-unsafe-swiftshader'],
    cwd: REPO,
    timeout: 120_000,
  });
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');
  const errors: string[] = [];
  win.on('pageerror', (e: any) => errors.push('pageerror: ' + e.message));
  win.on('console', (m: any) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await win.waitForTimeout(5000);
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => { /* already gone */ });

  // ── Dark mode, through the real Appearance control ───────────────────────
  const setDark = await (async (): Promise<boolean> => {
    await win.evaluate(() => { (document.getElementById('settings-gear') as HTMLElement | null)?.click(); });
    await win.waitForTimeout(600);
    const hit = await win.evaluate(() => {
      const opt = [...document.querySelectorAll('.menu-seg-opt[data-theme], .stp-seg-opt[data-theme]')]
        .find((e) => (e as HTMLElement).dataset.theme === 'dark' && (e as HTMLElement).offsetParent) as HTMLElement | undefined;
      if (!opt) return false;
      opt.click();
      return true;
    });
    await win.waitForTimeout(1200);
    await win.keyboard.press('Escape');
    await win.waitForTimeout(400);
    return hit;
  })();
  ok('the Appearance control offers Dark', setDark);
  ok('…and the app really is in dark mode',
    await win.evaluate(() => document.documentElement.dataset.theme === 'dark'));

  const ids = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const analysis = req('./src/analysis/analysis.js');
    for (const p of await projects.listProjects()) {
      const l = await analysis.listAnalyses(p.id);
      if (l.length) return { pid: p.id, aid: l[0].id };
    }
    return null;
  });
  ok('the sample dashboard is there to export', Boolean(ids && ids.pid), JSON.stringify(ids));
  if (!ids) { await app.close(); return; }

  await win.evaluate(async (i: any) => {
    await (window as any).adoptProject(i.pid);
    (window as any).selectSection('analyses');
    await (window as any).openAnalysis(i.aid);
  }, ids);
  await win.waitForTimeout(6000);

  // The sheet itself is 'auto' — it FOLLOWS the dark app on screen. That is the
  // whole trap: on paper there is no app to follow, so the export must resolve
  // it to light, and a capture that reads the app theme cannot know that.
  const onScreen = await win.evaluate(() => {
    const ed = document.getElementById('dash-editor') as HTMLElement | null;
    const card = document.querySelector('#dash-grid .dash-card') as HTMLElement | null;
    return {
      themeClass: (((ed && ed.className) || '').match(/dash-theme--(\w+)/) || [])[1] || '',
      cardBg: card ? getComputedStyle(card).backgroundColor : '',
      exportClasses: ((window as any).dashExportStyleClasses || (() => []))(),
    };
  });
  ok('the open dashboard follows the dark app on screen',
    onScreen.themeClass === 'auto', JSON.stringify(onScreen));
  ok('…but the EXPORT resolves that to a light sheet',
    Array.isArray(onScreen.exportClasses) && onScreen.exportClasses.indexOf('dash-theme--clean') >= 0,
    JSON.stringify(onScreen.exportClasses));

  // ── Export all three formats, for real ───────────────────────────────────
  const dest = {
    png: path.join(shotDir, 'export-fidelity.png'),
    pdf: path.join(shotDir, 'export-fidelity.pdf'),
    html: path.join(shotDir, 'export-fidelity.html'),
  };

  /** Drive the export dialog to `kind`, with the save panel pointed at `to`. */
  const exportAs = async (kind: 'html' | 'pdf' | 'png', to: string): Promise<boolean> => {
    clearFile(to);
    await app.evaluate((electron, p: string) => {
      (globalThis as any).__smokeOrigShowSaveDialog ||= electron.dialog.showSaveDialog;
      electron.dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as any;
    }, to);
    const opened = await win.evaluate(() => {
      const btn = document.getElementById('dash-export-btn') as HTMLElement | null;
      if (!btn) return false;
      btn.click();
      return true;
    });
    if (!opened) return false;
    await win.waitForTimeout(700);
    return win.evaluate((k: string) => {
      const box = [...document.querySelectorAll('.ws-modal-overlay')]
        .filter((o) => (o as HTMLElement).getClientRects().length > 0)
        .map((o) => o.querySelector('.ws-modal'))[0] as HTMLElement | undefined;
      const sel = box?.querySelector('select') as HTMLSelectElement | undefined;
      const go = box?.querySelector('.ws-modal-actions .btn-primary') as HTMLElement | undefined;
      if (!sel || !go) return false;
      sel.value = k;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      go.click();
      return true;
    }, kind);
  };

  // A capture waits on every chart AND on a MapLibre map settling (up to 8s of
  // its own), then renders the one-pager offscreen — generous, or this is a
  // flaky test of a slow machine rather than of the export.
  ok('PNG export runs', await exportAs('png', dest.png));
  const pngSize = await waitForFile(dest.png, 90_000);
  ok('…and writes a real PNG', pngSize > 20_000, `${Math.round(pngSize / 1024)} KB -> ${dest.png}`);

  ok('PDF export runs', await exportAs('pdf', dest.pdf));
  const pdfSize = await waitForFile(dest.pdf, 90_000);
  ok('…and writes a real PDF', pdfSize > 20_000, `${Math.round(pdfSize / 1024)} KB -> ${dest.pdf}`);

  ok('HTML export runs', await exportAs('html', dest.html));
  const htmlSize = await waitForFile(dest.html, 90_000);
  ok('…and writes a real HTML file', htmlSize > 50_000, `${Math.round(htmlSize / 1024)} KB -> ${dest.html}`);

  await app.evaluate((electron) => {
    if ((globalThis as any).__smokeOrigShowSaveDialog) {
      electron.dialog.showSaveDialog = (globalThis as any).__smokeOrigShowSaveDialog;
      delete (globalThis as any).__smokeOrigShowSaveDialog;
    }
  });

  // ── The PNG, as pixels ───────────────────────────────────────────────────
  // Where the first chart card sits ACROSS the page. Columns are a fixed
  // fraction of a fixed page width, so x is exact; y is not (an image card's
  // row band grows to its picture), which is why the check below reads the
  // whole column rather than one nominal centre point.
  const firstChart = await app.evaluate(async (_e, i: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analysis = req('./src/analysis/analysis.js');
    const rec = await analysis.getAnalysis(i.pid, i.aid);
    const cards = (rec && rec.sheets && rec.sheets[0] && rec.sheets[0].cards) || [];
    const c = cards.find((x: any) => x.type === 'visual');
    return c ? c.layout : null;
  }, ids);
  const gap = await win.evaluate(() => {
    const m = (window as any).dashExportMeasure ? (window as any).dashExportMeasure() : null;
    return m ? m.gap : 12;
  });
  ok('the first chart card has a layout to aim at', Boolean(firstChart), JSON.stringify(firstChart));

  const colW = (PAGE_W - 2 * PAGE_PAD - (GRID_COLS - 1) * gap) / GRID_COLS;
  const cx = firstChart
    ? PAGE_PAD + (firstChart.x || 0) * (colW + gap)
      + ((firstChart.w || 6) * colW + ((firstChart.w || 6) - 1) * gap) / 2
    : PAGE_W / 2;

  const pix = await app.evaluate((electron, arg: any) => {
    const img = electron.nativeImage.createFromPath(arg.png);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    // BGRA, 4 bytes per pixel. The cast is an UPSTREAM TYPINGS BUG, not a
    // shortcut: electron.d.ts declares `getBitmap(): void` while the docs and
    // the runtime both hand back a Buffer.
    const buf = img.getBitmap() as unknown as Buffer;
    const lum = (o: number) => (0.0722 * buf[o] + 0.7152 * buf[o + 1] + 0.2126 * buf[o + 2]) / 255;
    let dark = 0;
    let total = 0;
    // Every 4th pixel each way — a fixed, cheap sample that still sees any
    // region big enough to read as a rectangle.
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        if (lum((y * width + x) * 4) < 0.3) dark += 1;
        total += 1;
      }
    }
    // The column straight down the middle of the first chart card. The dark
    // rectangles were whole card bodies, so they cannot hide from this.
    const scale = width / arg.pageW;
    const col = Math.max(0, Math.min(width - 1, Math.round(arg.cx * scale)));
    let colDark = 0;
    let colTotal = 0;
    for (let y = 0; y < height; y += 2) {
      if (lum((y * width + col) * 4) < 0.3) colDark += 1;
      colTotal += 1;
    }
    // The page's own background, read in the left gutter (.d-root's padding) at
    // three heights — the sheet behind the cards, with no card on top of it.
    const gutter = Math.max(1, Math.round(4 * scale));
    const marginLum = Math.min(...[0.25, 0.5, 0.75].map(
      (f) => lum((Math.min(height - 1, Math.round(height * f)) * width + gutter) * 4),
    ));
    return {
      width, height,
      darkFraction: dark / total,
      colDarkFraction: colDark / colTotal,
      marginLum,
      scale,
    };
  }, { png: dest.png, cx, pageW: PAGE_W });

  ok('the PNG is readable as an image', Boolean(pix), String(pix));
  if (pix) {
    ok('the exported sheet is LIGHT, not a dark app screenshot',
      pix.darkFraction < 0.10, `${(pix.darkFraction * 100).toFixed(1)}% of sampled pixels are dark`);
    ok('…and there is no dark rectangle down the first chart card',
      pix.colDarkFraction < 0.15,
      `${(pix.colDarkFraction * 100).toFixed(1)}% dark down x=${Math.round(cx)} (logical)`);
    ok('…including the page margin the sheet shows through',
      pix.marginLum > 0.7, String(pix.marginLum));
    ok('the PNG kept the 1160 logical width and was captured at >=1x',
      pix.scale >= 1 && pix.width >= PAGE_W, `${pix.width}x${pix.height} (scale ${pix.scale})`);
  }

  // ── The HTML, actually rendered ──────────────────────────────────────────
  // A file that merely CONTAINS a <canvas> proves nothing: a chart that threw
  // leaves one behind, blank. Load it and read the pixels.
  const drawn = await app.evaluate(async (electron, arg: any) => {
    const w = new electron.BrowserWindow({
      width: 1280, height: 900, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        paintWhenInitiallyHidden: true, backgroundThrottling: false } as any,
    });
    try {
      await w.loadFile(arg.html);
      await w.webContents.executeJavaScript(
        'new Promise(function(r){setTimeout(function(){requestAnimationFrame(function(){r(1)})},2500)})',
      );
      return await w.webContents.executeJavaScript(`(function () {
        var out = { canvases: 0, drawnCanvases: 0, images: 0, drawnImages: 0, theme: '', bodyBg: '' };
        out.theme = (document.documentElement.className.match(/dash-theme--(\\w+)/) || [])[1] || '';
        out.bodyBg = getComputedStyle(document.body).backgroundColor;
        Array.prototype.forEach.call(document.querySelectorAll('canvas'), function (c) {
          out.canvases += 1;
          try {
            var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            for (var i = 3; i < d.length; i += 40) { if (d[i] !== 0) { out.drawnCanvases += 1; break; } }
          } catch (e) { /* tainted or zero-sized — counts as not drawn */ }
        });
        Array.prototype.forEach.call(document.querySelectorAll('img'), function (im) {
          out.images += 1;
          if (im.complete && im.naturalWidth > 10 && im.naturalHeight > 10) out.drawnImages += 1;
        });
        return out;
      })()`);
    } finally {
      if (!w.isDestroyed()) w.destroy();
    }
  }, { html: dest.html });

  ok('the exported HTML opens and reports its style', Boolean(drawn), JSON.stringify(drawn));
  if (drawn) {
    // The sample sheet is three visuals: two core Chart.js types that stay LIVE
    // in the HTML export, and a choropleth, which is embedded as a PNG (MapLibre
    // is deliberately not inlined — see src/analysis/dashboardExport.ts).
    ok('every chart card in the HTML actually drew',
      drawn.drawnCanvases + drawn.drawnImages >= 3
      && drawn.drawnCanvases === drawn.canvases,
      `${drawn.drawnCanvases}/${drawn.canvases} canvases + ${drawn.drawnImages}/${drawn.images} images`);
    ok('…and it resolved the SAME theme the PNG did, not the dark app',
      drawn.theme === 'auto' || drawn.theme === 'clean', drawn.theme);
    ok('…so its page is light too', /255|25[0-5]|24\d/.test(drawn.bodyBg), drawn.bodyBg);
  }

  ok('no renderer console errors across all three exports', errors.length === 0,
    errors.slice(0, 3).join(' | '));

  await win.screenshot({ path: path.join(shotDir, 'export-source-dashboard.png') });
  await app.close();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
}

main()
  .then(() => {
    if (failureCount()) {
      console.error('\n' + failureCount() + ' export smoke check(s) FAILED');
      process.exit(1);
    }
    console.log('\nAll export smoke checks passed.');
  })
  .catch((err) => { console.error(err); process.exit(1); });
