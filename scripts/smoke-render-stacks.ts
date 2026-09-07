// The three render stacks in the real window — Chart.js, Mosaic/vgplot and
// MapLibre GL — plus the deferred export bundles.
//
// Split out of smoke-app.ts (see that file's banner). This is the file whose
// whole subject is what a bundle does once the CSP is real. A CSP violation
// once survived 2,400 passing assertions because no test rendered the page, and
// every stack here is that shape of risk again: Observable Plot injects a
// <style> element, which `style-src 'self'` refuses; MapLibre loads a worker
// from a URL that resolves INSIDE the asar when packaged and fetches tiles with
// Fetch rather than <img>; the three export bundles are inserted as <script>
// elements at first use, in an order that only holds because lazyScript sets
// `async = false`. "The build stripped it" and "the bundle compiled" are claims
// about a bundle, not about the running app.
//
// Both flags are asserted in both directions. The Svelte island is checked OFF
// first — a spike that auto-mounts its debug card for everyone is what this
// gate exists to prevent — and only then turned on. The export engines are
// checked ABSENT at startup for the same reason: if someone re-adds a static
// <script> tag every ensureBundle() still resolves and every export still
// works, so only the absence check notices the saving was quietly given back.
//
//   npm run build:ts && node scripts/smoke-render-stacks.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { launchSmoke, reloadSmoke, seedProject, finishSmoke } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

async function main(): Promise<void> {
  const smoke = await launchSmoke('render-stacks');
  const { win, errors, shotDir, killSplash } = smoke;

  const r = await seedProject(smoke.app, { rows: 5_000 });
  await reloadSmoke(smoke);

  // Nothing above set `scSvelte`, so this is the DEFAULT user experience. The
  // Phase 5 spike shipped auto-mounting its debug card — tick counter, "Probe
  // globals", "not probed" — onto the Projects home screen for everyone. This
  // asserts the GATE, not the island: developer evidence stays invisible until
  // it is asked for.
  const islandOff = await win.evaluate(() => {
    const host = document.getElementById('svelte-island-host');
    return { present: !!host, children: host ? host.children.length : 0 };
  });
  ok('the Svelte spike island does NOT mount by default', islandOff.children === 0,
     `host present=${islandOff.present} children=${islandOff.children}`);

  // ── The Mosaic/vgplot path (Phase 3c), with the flag ON ───────────────────
  // Everything above ran with `scMosaic` unset, i.e. Chart.js. That proves the
  // default path is intact and NOTHING about the new one. The whole reason this
  // file exists is that a CSP violation once survived 2,400 passing assertions
  // because no test rendered the page — and vgplot's stack is exactly that shape
  // of risk again: Observable Plot injects a <style> element, which `style-src
  // 'self'` refuses. The build strips those injections, but "the build stripped
  // them" is a claim about a bundle, not about the running app.
  // The same reload turns on the Phase 5 Svelte island, asserted just below.
  await win.evaluate(() => {
    localStorage.setItem('scMosaic', '1');
    localStorage.setItem('scSvelte', '1');
  });
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(3000);
  await killSplash();

  // ── The Svelte island (Phase 5) ───────────────────────────────────────────
  // docs/phase-5/01-toolchain.md §10 names `npm run smoke` as "the check
  // standing between this design and a stale bundle shipping unnoticed" — but
  // nothing asserted the island at all. A MISSING bundle surfaces as a load
  // error; a STALE one produces no error whatsoever, it just renders old code.
  // Compiling it is not evidence; mounting it is.
  const island = await win.evaluate(() => {
    const host = document.getElementById('svelte-island-host');
    const g = (window as any).OrdinateSvelte;
    return {
      bundleLoaded: !!(g && typeof g.mountIsland === 'function'),
      version: (g && g.version) || null,
      mounted: !!(host && host.children.length > 0),
      text: host ? (host.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '',
      // Svelte compiles scoped styles OUT to svelte/bundle.css (`css: 'external'`).
      // A <style> here means a build regressed to runtime injection, which
      // `style-src 'self'` refuses.
      styleEls: document.querySelectorAll('style').length,
      cssLinked: [...document.styleSheets].some((s) => (s.href || '').includes('svelte/bundle.css')),
    };
  });
  ok('the Svelte bundle loaded and exposes one global', island.bundleLoaded,
     `version=${island.version}`);
  ok('the island mounts when scSvelte is on', island.mounted, island.text);
  ok('scoped styles came from the linked bundle.css, not an injected <style>',
     island.cssLinked && island.styleEls === 0,
     `linked=${island.cssLinked} styleEls=${island.styleEls}`);

  // Prefer a REAL control. A presentational wrapper can both match [class*=card]
  // and sit earlier in document order than the button inside it — clicking the
  // wrapper then does nothing, and every downstream assertion reports "nothing
  // rendered" rather than "the test clicked the wrong element".
  const clickText = (re: string) =>
    win.evaluate((src: string) => {
      const rx = new RegExp(src, 'i');
      const match = (sel: string) =>
        [...document.querySelectorAll(sel)].find((b) => rx.test(b.textContent || '')) as
          | HTMLElement
          | undefined;
      const el = match('button, a, [role=button]') || match('[class*=card], li');
      if (el) el.click();
      return !!el;
    }, re);

  // Re-open the project (no card to click) and jump to Visuals via the nav.
  await win.evaluate((id) => (window as any).openWorkspace?.(id), r.projectId);
  await win.waitForTimeout(1500);
  await clickText('^\\s*Visuals\\s*$');
  await win.waitForTimeout(1500);
  const openedViz = await clickText('sales by region');
  ok('saved visual opens from the UI with Mosaic enabled', openedViz);

  // WAIT FOR THE CONDITION, never a fixed sleep. A 4 s pause was enough on a dev
  // machine and not on a CI runner, where this reported `marks=0 canvases=0` —
  // neither stack had drawn yet, which reads exactly like "vgplot is broken".
  // Rendering here is a resident DuckDB query plus a view round trip, so its
  // latency tracks the host, not the code.
  await win
    .waitForFunction(
      () => !!document.querySelector('svg[class*="plot-"], #viz-area canvas'), // #viz-area: gallery thumbs are canvases too
      undefined,
      { timeout: 60_000 },
    )
    .catch(() => {}); // fall through to the assertions, which report what's there

  // Plot stamps every figure with the constant class `plot-d6a7b5`; an <svg>
  // carrying it is proof vgplot drew, not Chart.js (which draws to <canvas>).
  const mosaic = await win.evaluate(() => {
    const svg = document.querySelector('svg[class*="plot-"]');
    return {
      drew: !!svg,
      marks: svg ? svg.querySelectorAll('rect, path, circle, line').length : 0,
      // The injection the build removes. One of these means style-src fired.
      styleEls: document.querySelectorAll('style').length,
      canvases: document.querySelectorAll('#viz-area canvas').length, // scoped: gallery thumbs are canvases too
    };
  });
  ok('vgplot rendered an SVG (not a Chart.js canvas)', mosaic.drew,
     `marks=${mosaic.marks} canvases=${mosaic.canvases}`);
  ok('the vgplot figure actually has marks', mosaic.marks > 0, `${mosaic.marks} mark elements`);
  // Zero is the whole point: Plot's injected <style> is stripped at bundle time,
  // so the rules come only from the linked vendor/plot.css. A non-zero count here
  // means a future Plot version re-introduced an injection the build didn't catch.
  ok('no <style> element was injected (CSP style-src stays clean)', mosaic.styleEls === 0,
     `${mosaic.styleEls} <style> elements in the document`);

  // ── The MAP path (Phase 4, MapLibre GL) ───────────────────────────────────
  // Until this block, nothing in the repo rendered a map in the real app. That
  // left the entire WebGL stack uncovered by the one check that runs it — a
  // worker loaded from a URL that resolves INSIDE the asar when packaged, a CSP
  // that had to gain `connect-src` because MapLibre fetches tiles with Fetch
  // rather than <img>, and a GL context that must actually initialise. None of
  // that is observable from a unit test.
  await clickText('^\\s*Visuals\\s*$');
  await win.waitForTimeout(1500);
  ok('map visual opens from the UI', await clickText('revenue by state'));

  await win
    .waitForFunction(() => !!document.querySelector('.maplibregl-map canvas'), undefined, {
      timeout: 60_000,
    })
    .catch(() => {});
  // Tiles are network-bound; the markers only appear once the geo join resolves.
  await win
    .waitForFunction(() => document.querySelectorAll('.maplibregl-marker').length > 0, undefined, {
      timeout: 60_000,
    })
    .catch(() => {});

  const map = await win.evaluate(() => {
    const cv = document.querySelector('.maplibregl-map canvas') as HTMLCanvasElement | null;
    let gl = false;
    // Re-getting the same context type returns the LIVE context; a lost or never
    // created one is null. Cheap proof the GL path really initialised.
    try { gl = !!(cv && (cv.getContext('webgl2') || cv.getContext('webgl'))); } catch (_) { /* no GL */ }
    const fb = document.querySelector('.cv-chart-fallback');
    return {
      hasMap: !!document.querySelector('.maplibregl-map'),
      size: cv ? `${cv.width}x${cv.height}` : 'none',
      gl,
      markers: document.querySelectorAll('.maplibregl-marker').length,
      // The WebGL-missing / no-boundaries message. Present means the map did NOT
      // draw and the app fell back — which passes a naive "something rendered" check.
      fallback: fb ? (fb.textContent || '').trim().slice(0, 80) : null,
    };
  });
  ok('MapLibre map rendered', map.hasMap && map.gl, `canvas=${map.size} gl=${map.gl}`);
  ok('the GL canvas has real pixels', !/^0x|x0$|none/.test(map.size), map.size);
  ok('no map fallback message (WebGL present, boundaries matched)', map.fallback === null,
     map.fallback || '');
  // Value labels are DOM Markers, not a symbol layer, because the style ships no
  // glyphs (adding one would mean a second network host). Zero here means the geo
  // join found nothing — the map would look fine and say nothing.
  ok('choropleth value labels placed as DOM markers', map.markers > 0, `${map.markers} markers`);

  // ── The deferred export bundles ────────────────────────────────────────────
  // The map assertions above already prove the 'map' bundle loads on demand
  // under the real hub CSP — a map rendered, and this run fails on any renderer
  // console error, which a refused <script src> would be. The three EXPORT
  // bundles have no such witness: nothing in this run opens a PDF/PPT/Word
  // export, so without this block they would be deferred and unverified, and a
  // broken one would surface as "PDF engine not loaded" on a user's machine.
  //
  // Asserted in both directions. Absent-at-startup is the half that would rot
  // silently: if someone re-adds a static <script> tag, every ensureBundle()
  // still resolves and every export still works, so only the ABSENCE check
  // notices that the saving was quietly given back.
  const lazyExports = await win.evaluate(async () => {
    const w = window as any;
    const before = { pdf: !!w.pdfMake, pptx: !!w.PptxGenJS, docx: !!w.docx };
    const loaded = {
      pdf: await w.ensureBundle('pdf'),
      pptx: await w.ensureBundle('pptx'),
      docx: await w.ensureBundle('docx'),
    };
    return {
      before,
      loaded,
      after: { pdf: !!w.pdfMake, pptx: !!w.PptxGenJS, docx: !!w.docx },
      // Order proof, done the only way that cannot be faked: actually build a
      // PDF. vfs_fonts.js does not set a property to check — it CALLS
      // pdfMake.addVirtualFileSystem(), guarded on pdfMake already existing. So
      // if the two ever loaded concurrently (a dynamically inserted <script> is
      // async by default, which is why lazyScript sets async = false) the fonts
      // would silently never register, every property check would still pass,
      // and the failure would appear only when a user exported a PDF.
      pdfBuilds: await w.pdfMake
        .createPdf({ content: 'smoke' })
        .getBase64()
        .then((b: string) => typeof b === 'string' && b.length > 100)
        .catch(() => false),
      docxUsable: !!(w.docx && w.docx.Packer),
    };
  });
  ok('the export engines are ABSENT at startup — the 3,411K is genuinely not parsed',
     !lazyExports.before.pdf && !lazyExports.before.pptx && !lazyExports.before.docx,
     JSON.stringify(lazyExports.before));
  ok('...and each loads on demand under the real hub CSP (script-src \'self\')',
     lazyExports.loaded.pdf && lazyExports.loaded.pptx && lazyExports.loaded.docx,
     JSON.stringify(lazyExports.loaded));
  ok('...defining the globals the export paths guard on',
     lazyExports.after.pdf && lazyExports.after.pptx && lazyExports.after.docx,
     JSON.stringify(lazyExports.after));
  ok('...with intra-bundle order preserved — a real PDF builds, so the fonts registered',
     lazyExports.pdfBuilds);
  ok('...and docx exposing Packer, which exportDocx checks before building',
     lazyExports.docxUsable);

  const shot = path.join(shotDir, 'app-window.png');
  await win.screenshot({ path: shot });
  ok('screenshot captured', fs.existsSync(shot) && fs.statSync(shot).size > 5000,
     `${Math.round(fs.statSync(shot).size / 1024)} KB -> ${shot}`);

  const visible: string = await win.evaluate(() => {
    const vis = [...document.querySelectorAll('body *')].filter((e) => {
      const rect = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return rect.width > 0 && rect.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0'
        && e.children.length === 0 && (e.textContent || '').trim();
    });
    return vis.map((e) => (e.textContent || '').trim()).join(' | ').slice(0, 200);
  });
  ok('something is actually visible on screen', visible.length > 20, `"${visible.slice(0, 100)}"`);

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 3).join(' | '));


  await smoke.close();
}

main()
  .then(() => finishSmoke('render-stacks', failureCount()))
  .catch((err) => {
    console.error('SMOKE DRIVER ERROR:', err && err.message ? err.message : err);
    process.exit(1);
  });
