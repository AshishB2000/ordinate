// Smoke: the Visuals gallery renders LIVE chart thumbnails on its cards
// (renderer/hub/vizThumbs.ts) — real app, real data, no mocks.
//
// Asserts, against seeded bar + line + map visuals:
//   • chartable cards grow a real thumbnail canvas (nonzero bitmap) once the
//     tile is in view;
//   • the MAP card draws a static mini choropleth (mapThumb.ts) — MapLibre is
//     never involved, so the check reads the CANVAS PIXELS: a blank canvas
//     passes every structural check while proving nothing;
//   • the card meta line carries the VIZ_LABELS type label;
//   • re-entering the section repeatedly does NOT leak Chart instances —
//     vizThumbsReset() destroys the previous paint's charts (Chart.instances
//     is Chart.js's own live registry, so the count is ground truth);
//   • no renderer console errors (incl. CSP violations).
//
// A separate boot, not more lines in smoke-app.ts, which sits EXACTLY at its
// file-size ratchet cap (scripts/test-file-size.ts) — the same reasoning
// smoke-ask-actions.ts documents.
//
//   npm run smoke   (runs after smoke-ask-actions.js)

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { closeApp } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-vizthumb-'));


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

  await win.waitForSelector('#splash', { state: 'hidden', timeout: 60_000 }).catch(() => {});
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});
  await win.waitForSelector('#side-ai-btn', { timeout: 60_000 });

  // ── Seed: one dataset, three visuals (bar, line, map) via the REAL stores ──
  const seeded: any = await app.evaluate(async (_electronModule) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const visuals = req('./src/analysis/visuals.js');
    await projects.init();
    const proj = await projects.createProject('Thumbs smoke');
    // Full state names, like sampleProject.ts's "Profit by state" — geoMatch
    // joins on names, so "CA" would match nothing and the map would be blank.
    const ds = await datasets.saveDataset(proj.id, {
      name: 'Regional revenue',
      sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }],
      rows: [['California', 120], ['Texas', 240], ['New York', 180], ['Florida', 90]],
    });
    const encoding = { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] };
    const bar = await visuals.saveVisual(proj.id, { name: 'Bar thumb', datasetId: ds.id, chartType: 'bar', encoding });
    const line = await visuals.saveVisual(proj.id, { name: 'Line thumb', datasetId: ds.id, chartType: 'line', encoding });
    const map = await visuals.saveVisual(proj.id, {
      name: 'Map thumb', datasetId: ds.id, chartType: 'map_choropleth',
      encoding: Object.assign({}, encoding, { geo: { level: 'us_state' } }),
    });
    return { projectId: proj.id, ok: Boolean(bar && line && map) };
  });
  ok('seeded a dataset and bar/line/map visuals', seeded.ok === true);

  await win.evaluate((pid: string) => (window as any).openWorkspace(pid), seeded.projectId);
  await win.waitForTimeout(1000);
  await win.evaluate(() => { (window as any).selectSection('visuals'); });

  // Thumbs are lazy (IntersectionObserver + concurrency cap): wait for ALL
  // three cards to carry a canvas, not just the first. The map's is last —
  // it also has to pull the us-states boundaries in.
  const settled = await win.waitForFunction(
    () => document.querySelectorAll('#viz-grid .viz-card-tile--thumb canvas').length >= 3,
    { timeout: 20_000 },
  ).then(() => true).catch(() => false);
  ok('all three cards grew a live thumbnail canvas', settled);

  const state = await win.evaluate(() => {
    const cards = [...document.querySelectorAll('#viz-grid .viz-card')] as HTMLElement[];
    const byName = (re: RegExp) => cards.find((c) => re.test(c.textContent || ''));
    const bar = byName(/Bar thumb/); const line = byName(/Line thumb/); const map = byName(/Map thumb/);
    const canvasOf = (c?: HTMLElement) => c?.querySelector('.viz-card-tile canvas') as HTMLCanvasElement | null;
    const glyphOf = (c?: HTMLElement) => c?.querySelector('.viz-card-glyph') as HTMLElement | null;
    // READ THE PIXELS. A canvas of the right size that was never drawn into
    // passes every structural check and proves nothing, so count the opaque
    // pixels and the distinct colours actually on it.
    const pixels = (c: HTMLCanvasElement | null) => {
      if (!c || !c.width || !c.height) return { painted: 0, colors: 0 };
      const ctx = c.getContext('2d');
      if (!ctx) return { painted: 0, colors: 0 };
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let painted = 0;
      const colors = new Set<number>();
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 8) continue;
        painted += 1;
        colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      }
      return { painted, colors: colors.size };
    };
    return {
      cards: cards.length,
      barDrawn: Boolean(canvasOf(bar) && canvasOf(bar)!.width > 0 && canvasOf(bar)!.height > 0),
      lineDrawn: Boolean(canvasOf(line) && canvasOf(line)!.width > 0 && canvasOf(line)!.height > 0),
      mapGlyphShown: Boolean(glyphOf(map) && glyphOf(map)!.offsetParent !== null),
      mapPixels: pixels(canvasOf(map)),
      barMeta: (bar?.querySelector('.viz-card-meta')?.textContent || ''),
      chartCount: Object.keys(((window as any).Chart && (window as any).Chart.instances) || {}).length,
    };
  });
  ok('the gallery lists all three cards', state.cards === 3, `${state.cards} cards`);
  ok('the bar card renders a real chart (nonzero bitmap)', state.barDrawn);
  ok('the line card renders a real chart (nonzero bitmap)', state.lineDrawn);
  ok('the MAP card draws real pixels, not a blank canvas',
    state.mapPixels.painted > 500, JSON.stringify(state.mapPixels));
  ok('…and more than one colour, so matched states are actually filled',
    state.mapPixels.colors > 1, JSON.stringify(state.mapPixels));
  ok('…so the glyph is hidden, like every other rendered thumbnail',
    state.mapGlyphShown === false);
  ok('the card meta carries the VIZ_LABELS type label', /^Bar · /.test(state.barMeta), state.barMeta);

  // ── No leaks across repeated section switches ────────────────────────────
  // Each re-entry repaints the gallery; vizThumbsReset() must destroy the
  // previous paint's charts, so Chart.js's own instance registry stays flat.
  for (let i = 0; i < 3; i += 1) {
    await win.evaluate(() => { (window as any).selectSection('home'); });
    await win.waitForTimeout(400);
    await win.evaluate(() => { (window as any).selectSection('visuals'); });
    await win.waitForFunction(
      () => document.querySelectorAll('#viz-grid .viz-card-tile--thumb canvas').length >= 3,
      { timeout: 20_000 },
    ).catch(() => {});
  }
  const after = await win.evaluate(() => ({
    chartCount: Object.keys(((window as any).Chart && (window as any).Chart.instances) || {}).length,
    canvases: document.querySelectorAll('#viz-grid canvas').length,
  }));
  ok('three section round-trips leak no Chart instances',
    after.chartCount <= state.chartCount, `before=${state.chartCount} after=${after.chartCount}`);
  // Three canvases, two Chart instances: the map's canvas is drawn directly and
  // registers nothing, so it can't leak — but it must not accumulate either.
  ok('…and the grid holds exactly the three live thumbnail canvases', after.canvases === 3, `${after.canvases} canvases`);

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 3).join(' | '));

  await closeApp(app);
}

main()
  .catch((err) => { ok('smoke-viz-thumbs crashed', false, err); })
  .finally(() => {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    console.log('');
    if (failureCount()) { console.error(`${failureCount()} viz-thumbs smoke check(s) FAILED.`); process.exit(1); }
    console.log('All viz-thumbs smoke checks passed.');
  });
