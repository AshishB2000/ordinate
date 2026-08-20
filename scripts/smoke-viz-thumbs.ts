// Smoke: the Visuals gallery renders LIVE chart thumbnails on its cards
// (renderer/hub/vizThumbs.ts) — real app, real data, no mocks.
//
// Asserts, against seeded bar + line + map visuals:
//   • chartable cards grow a real thumbnail canvas (nonzero bitmap) once the
//     tile is in view;
//   • the MAP card keeps its glyph — MapLibre needs WebGL2 and the visible
//     window, so thumbs never render maps;
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

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-vizthumb-'));

let failures = 0;
function ok(label: string, cond: boolean, extra?: string): void {
  if (cond) console.log('ok   ' + label + (extra ? '  ' + extra : ''));
  else {
    console.error('FAIL ' + label + (extra ? '  ' + extra : ''));
    failures++;
  }
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
    const ds = await datasets.saveDataset(proj.id, {
      name: 'Regional revenue',
      sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }],
      rows: [['North', 120], ['South', 240], ['East', 180], ['West', 90]],
    });
    const encoding = { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] };
    const bar = await visuals.saveVisual(proj.id, { name: 'Bar thumb', datasetId: ds.id, chartType: 'bar', encoding });
    const line = await visuals.saveVisual(proj.id, { name: 'Line thumb', datasetId: ds.id, chartType: 'line', encoding });
    const map = await visuals.saveVisual(proj.id, { name: 'Map thumb', datasetId: ds.id, chartType: 'map_choropleth', encoding });
    return { projectId: proj.id, ok: Boolean(bar && line && map) };
  });
  ok('seeded a dataset and bar/line/map visuals', seeded.ok === true);

  await win.evaluate((pid: string) => (window as any).openWorkspace(pid), seeded.projectId);
  await win.waitForTimeout(1000);
  await win.evaluate(() => { (window as any).selectSection('visuals'); });

  // Thumbs are lazy (IntersectionObserver + concurrency cap): wait for both
  // chartable cards to carry a canvas, not just the first.
  const settled = await win.waitForFunction(
    () => document.querySelectorAll('#viz-grid .viz-card-tile--thumb canvas').length >= 2,
    { timeout: 20_000 },
  ).then(() => true).catch(() => false);
  ok('both chartable cards grew a live thumbnail canvas', settled);

  const state = await win.evaluate(() => {
    const cards = [...document.querySelectorAll('#viz-grid .viz-card')] as HTMLElement[];
    const byName = (re: RegExp) => cards.find((c) => re.test(c.textContent || ''));
    const bar = byName(/Bar thumb/); const line = byName(/Line thumb/); const map = byName(/Map thumb/);
    const canvasOf = (c?: HTMLElement) => c?.querySelector('.viz-card-tile canvas') as HTMLCanvasElement | null;
    const glyphOf = (c?: HTMLElement) => c?.querySelector('.viz-card-glyph') as HTMLElement | null;
    return {
      cards: cards.length,
      barDrawn: Boolean(canvasOf(bar) && canvasOf(bar)!.width > 0 && canvasOf(bar)!.height > 0),
      lineDrawn: Boolean(canvasOf(line) && canvasOf(line)!.width > 0 && canvasOf(line)!.height > 0),
      mapHasCanvas: Boolean(map && map.querySelector('canvas')),
      mapGlyphShown: Boolean(glyphOf(map) && glyphOf(map)!.offsetParent !== null),
      barMeta: (bar?.querySelector('.viz-card-meta')?.textContent || ''),
      chartCount: Object.keys(((window as any).Chart && (window as any).Chart.instances) || {}).length,
    };
  });
  ok('the gallery lists all three cards', state.cards === 3, `${state.cards} cards`);
  ok('the bar card renders a real chart (nonzero bitmap)', state.barDrawn);
  ok('the line card renders a real chart (nonzero bitmap)', state.lineDrawn);
  ok('the MAP card has NO canvas — maps never thumbnail (WebGL2 + visible window)', state.mapHasCanvas === false);
  ok('…and its glyph is still shown as the presentation', state.mapGlyphShown === true);
  ok('the card meta carries the VIZ_LABELS type label', /^Bar · /.test(state.barMeta), state.barMeta);

  // ── No leaks across repeated section switches ────────────────────────────
  // Each re-entry repaints the gallery; vizThumbsReset() must destroy the
  // previous paint's charts, so Chart.js's own instance registry stays flat.
  for (let i = 0; i < 3; i += 1) {
    await win.evaluate(() => { (window as any).selectSection('home'); });
    await win.waitForTimeout(400);
    await win.evaluate(() => { (window as any).selectSection('visuals'); });
    await win.waitForFunction(
      () => document.querySelectorAll('#viz-grid .viz-card-tile--thumb canvas').length >= 2,
      { timeout: 20_000 },
    ).catch(() => {});
  }
  const after = await win.evaluate(() => ({
    chartCount: Object.keys(((window as any).Chart && (window as any).Chart.instances) || {}).length,
    canvases: document.querySelectorAll('#viz-grid canvas').length,
  }));
  ok('three section round-trips leak no Chart instances',
    after.chartCount <= state.chartCount, `before=${state.chartCount} after=${after.chartCount}`);
  ok('…and the grid holds exactly the two live thumbnail canvases', after.canvases === 2, `${after.canvases} canvases`);

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 3).join(' | '));

  await app.close();
}

main()
  .catch((err) => { console.error('FAIL smoke-viz-thumbs crashed:', err); failures++; })
  .finally(() => {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    console.log('');
    if (failures) { console.error(`${failures} viz-thumbs smoke check(s) FAILED.`); process.exit(1); }
    console.log('All viz-thumbs smoke checks passed.');
  });
