// Workspace maturity, in the REAL app: version history, Trash, lineage,
// projects and first-run guidance, each driven through its rendered UI.
//
// A fresh userData, so the first launch seeds the sample exactly as a new user
// sees it — the Get-started card and the coach marks only exist on that path.
// Every assertion that matters is read off the rendered page; disk is only
// consulted to find ids.
//
// Screenshots land in SMOKE_ARTIFACT_DIR (the PR's pictures come from here).
//
//   npm run build && node scripts/smoke-workspace.js

export {};
import { ok, failureCount } from './selfcheck';
import { closeApp } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-smoke-workspace-'));
const shotDir = process.env.SMOKE_ARTIFACT_DIR || userData;
fs.mkdirSync(shotDir, { recursive: true });

// ponytail: Playwright's Page/ElectronApplication types, loosely — this file drives them
type Win = any;
type App = any;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll a renderer predicate until it holds (or time runs out). */
async function waitFor(win: Win, fn: string, timeout = 15000): Promise<boolean> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await win.evaluate(fn).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
}

/** A screenshot for the PR: earlier steps' toasts are cleared first — they were
 *  asserted where they appeared, and in a picture of a later page they are noise. */
async function shot(win: Win, name: string): Promise<void> {
  await win.evaluate(() => document.querySelectorAll('#hub-toast .toast').forEach((t) => t.remove()));
  await win.screenshot({ path: path.join(shotDir, name + '.png') });
}

/** The sample's ids, off disk through the real main-process modules. */
async function sampleIds(app: App): Promise<{ projectId: string; datasetId: string; analysisId: string; visualIds: string[] }> {
  return app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const analysis = req('./src/analysis/analysis.js');
    const visuals = req('./src/analysis/visuals.js');
    const p = (await projects.listProjects())[0];
    return {
      projectId: p.id,
      datasetId: (await datasets.listDatasets(p.id))[0].id,
      analysisId: (await analysis.listAnalyses(p.id))[0].id,
      visualIds: (await visuals.listVisuals(p.id)).map((v: any) => v.id),
    };
  });
}

// ── 0. First-run guidance — FIRST, on the fresh profile ─────────────────────
async function firstRunSection(win: Win, ids: { projectId: string; datasetId: string; analysisId: string }): Promise<void> {
  const card = async () => win.evaluate(() => {
    const c = document.getElementById('home-getstarted')!;
    return {
      shown: !c.hidden && c.offsetParent !== null,
      count: (c.querySelector('.gs-count') || {} as any).textContent,
      items: [...c.querySelectorAll('.gs-item')].map((i) => ({
        step: (i as HTMLElement).dataset.step, done: i.classList.contains('is-done'),
        action: (i.querySelector('.gs-action') || {} as any).textContent,
      })),
    };
  });
  await win.evaluate(() => (window as any).selectSection('home'));
  await waitFor(win, `!document.getElementById('home-getstarted').hidden && document.querySelectorAll('.gs-item').length === 4`);
  let gs = await card();
  ok('a first launch shows Get started on Home', gs.shown, JSON.stringify(gs));
  ok('…at 0 of 4, with no model and nothing made yet', gs.count === '0 of 4', JSON.stringify(gs));
  ok('…four steps, each with its door',
    JSON.stringify(gs.items.map((i: any) => i.step)) === JSON.stringify(['import', 'visual', 'dashboard', 'assistant'])
    && gs.items.every((i: any) => !i.done && i.action && i.action !== 'Done'), JSON.stringify(gs.items));
  await shot(win, 'get-started');

  // Saving a visual ticks "Build a visual" — read off the record, in main.
  const saved = await win.evaluate(async (a: any) => (window as any).hub.saveVisual({
    projectId: a.projectId, datasetId: a.datasetId, name: 'Units by region', chartType: 'column',
    encoding: { category: 'region', values: [{ column: 'units', aggregation: 'sum' }] },
  }), ids);
  await win.evaluate(() => (window as any).selectSection('visuals'));
  await win.evaluate(() => (window as any).selectSection('home'));
  await waitFor(win, `(document.querySelector('#home-getstarted .gs-count') || {}).textContent === '1 of 4'`);
  gs = await card();
  ok('saving a visual ticks it: 1 of 4', gs.count === '1 of 4'
    && gs.items.find((i: any) => i.step === 'visual').done && gs.items.find((i: any) => i.step === 'visual').action === 'Done', JSON.stringify(gs));
  // The tick latches; the visual itself would skew the lineage counts below.
  await win.evaluate(async (a: any) => (window as any).hub.deleteVisual(a.p, a.v, { permanent: true }), { p: ids.projectId, v: saved.id });

  // Folding keeps the count in the header.
  await win.click('#home-getstarted .gs-fold');
  await waitFor(win, `!document.getElementById('home-gs-pill').hidden`);
  ok('the card folds into a "1 of 4" pill in the header',
    (await win.evaluate(() => document.querySelector('#home-gs-pill .gs-pill-text')!.textContent)) === '1 of 4'
    && (await win.evaluate(() => document.getElementById('home-getstarted')!.hidden)));
  await win.click('#home-gs-pill');
  await waitFor(win, `!document.getElementById('home-getstarted').hidden`);

  // The sample dashboard's tour: once.
  const openSample = async (): Promise<void> => {
    await win.evaluate(async (a: any) => {
      const w = window as any;
      await w.openWorkspace(a.projectId);
      w.selectSection('analyses');
      await w.openAnalysis(a.analysisId);
    }, ids);
  };
  await openSample();
  ok('opening the sample dashboard the first time starts the tour', await waitFor(win, `!!document.querySelector('.cm-card')`, 10000));
  const tips: string[] = [];
  for (let i = 0; i < 3; i++) {
    const t = await win.evaluate(() => ({
      step: (document.querySelector('.cm-card .cm-step') || {} as any).textContent,
      target: !!document.querySelector('.cm-target'),
      next: (document.querySelector('.cm-card .cm-next') || {} as any).textContent,
    }));
    tips.push(`${t.step}|${t.target}|${t.next}`);
    if (i === 1) { await sleep(300); await shot(win, 'coach-mark'); }
    await win.click('.cm-card .cm-next');
    await sleep(250);
  }
  ok('…three tips, each pointing at its target, the last one "Got it"',
    JSON.stringify(tips) === JSON.stringify(['Tip 1 of 3|true|Next', 'Tip 2 of 3|true|Next', 'Tip 3 of 3|true|Got it']), JSON.stringify(tips));
  ok('…and the tour is gone after the last', await win.evaluate(() => !document.querySelector('.cm-card') && !document.querySelector('.cm-target')));
  await win.evaluate(() => (window as any).handleBackToList());
  await openSample();
  await sleep(3000);
  ok('reopening the sample dashboard does not show it again', await win.evaluate(() => !document.querySelector('.cm-card')));
  await win.evaluate(() => (window as any).handleBackToList());
}

// ── 1. Version history ───────────────────────────────────────────────────────
async function historySection(win: Win, ids: { projectId: string; analysisId: string }): Promise<void> {
  await win.evaluate(async (a: any) => {
    const w = window as any;
    await w.openWorkspace(a.projectId);
    w.selectSection('analyses');
    await w.openAnalysis(a.analysisId);
  }, ids);
  await waitFor(win, `!!window.dashCurrent && document.querySelectorAll('#dash-grid .dash-card').length > 0`);
  const tilesBefore: number = await win.evaluate(() => (window as any).dashCards().length);

  // Save #1 — nothing changed since the sample was seeded, and the seeder's own
  // writes are not versions, so this is the first one.
  await win.click('#dash-save-btn');
  await sleep(400);
  // Save #2 — with one tile added.
  await win.evaluate(() => {
    const w = window as any;
    w.pushCard({ id: w.dashUuid(), type: 'text', heading: 'Smoke note', text: 'Added by the smoke.', layout: { ...w.dashFindSlot(w.dashCards(), 6, 2), w: 6, h: 2 } });
  });
  await win.click('#dash-save-btn');
  await sleep(400);

  await win.click('#dash-history-btn');
  await waitFor(win, `document.querySelectorAll('.ws-side[data-kind="history"] .vh-row').length >= 2`);
  const rows: any[] = await win.evaluate(() => [...document.querySelectorAll('.ws-side .vh-row')].map((r) => ({
    summary: (r.querySelector('.vh-summary') || {} as any).textContent,
    current: r.classList.contains('is-current'),
    thumbTiles: r.querySelectorAll('.vh-thumb rect').length,
  })));
  ok('History lists two versions after two saves', rows.length === 2, JSON.stringify(rows));
  ok('…the newest reads "Added 1 tile"', rows[0] && rows[0].summary === 'Added 1 tile', JSON.stringify(rows));
  ok('…and is marked Current', rows[0] && rows[0].current === true);
  ok('…with a thumbnail drawn from the snapshot (one more tile than the first)',
    rows.length === 2 && rows[0].thumbTiles === rows[1].thumbTiles + 1, JSON.stringify(rows));

  // Preview the first version, in place.
  await win.locator('.ws-side .vh-row').nth(1).click();
  await waitFor(win, `!!document.querySelector('#dash-editor .vh-banner')`);
  const preview = await win.evaluate(() => ({
    banner: (document.querySelector('#dash-editor .vh-banner strong') || {} as any).textContent || '',
    readOnly: document.getElementById('dash-editor')!.classList.contains('dash-editor--readonly'),
    tiles: (window as any).dashCards().length,
    saveHidden: getComputedStyle(document.getElementById('dash-save-btn')!).display === 'none',
  }));
  ok('previewing a version shows the banner on the dashboard', /^Viewing version from /.test(preview.banner), preview.banner);
  ok('…read-only (Save is hidden, the editor is in its read-only mode)', preview.readOnly && preview.saveHidden, JSON.stringify(preview));
  ok('…showing that version\'s tiles', preview.tiles === tilesBefore, JSON.stringify({ preview, tilesBefore }));
  await shot(win, 'history-preview');

  await win.click('#dash-editor .vh-restore-btn');
  await waitFor(win, `!document.querySelector('.vh-banner') && document.querySelectorAll('.ws-side .vh-row').length === 3`);
  const after = await win.evaluate(() => ({
    tiles: (window as any).dashCards().length,
    readOnly: document.getElementById('dash-editor')!.classList.contains('dash-editor--readonly'),
    rows: [...document.querySelectorAll('.ws-side .vh-row')].map((r) => ({
      summary: (r.querySelector('.vh-summary') || {} as any).textContent,
      restored: !!r.querySelector('.vh-restored'),
    })),
  }));
  ok('Restore puts the old content back — the added tile is gone', after.tiles === tilesBefore, JSON.stringify(after));
  ok('…the editor is editable again', after.readOnly === false);
  ok('…and a THIRD version exists, marked as a restore',
    after.rows.length === 3 && after.rows[0].restored && after.rows[0].summary === 'Removed 1 tile', JSON.stringify(after.rows));
  await shot(win, 'history-restored');
  // Escape closes the panel — and must, even though the import dialog's
  // overlay lives hidden in the document the whole time.
  await win.keyboard.press('Escape');
  ok('Escape closes the History panel',
    await waitFor(win, `!document.querySelector('.ws-side') && !document.body.classList.contains('ws-side-push')`, 3000));
  await win.evaluate(() => (window as any).handleBackToList());
}

// ── 2. Trash ─────────────────────────────────────────────────────────────────
async function trashSection(win: Win): Promise<void> {
  const NAME = 'Revenue by category';
  await win.evaluate(async () => { const w = window as any; w.selectSection('visuals'); await w.refreshVisualList(); });
  await waitFor(win, `[...document.querySelectorAll('.viz-card')].some((c) => /${NAME}/.test(c.textContent || ''))`);
  // Through the card's own ⋯ → Delete, as a user would.
  await win.evaluate((name: string) => {
    const card = [...document.querySelectorAll('.viz-card')].find((c) => (c.textContent || '').includes(name)) as HTMLElement;
    (card.querySelector('.viz-card-menu') as HTMLElement).click();
  }, NAME);
  await win.locator('.viz-card-pop .chart-menu-item', { hasText: 'Delete' }).click();
  await waitFor(win, `![...document.querySelectorAll('.viz-card')].some((c) => /${NAME}/.test(c.textContent || ''))`);
  const toast = await win.evaluate(() => [...document.querySelectorAll('#hub-toast .toast')].map((t) => t.textContent || '').join(' | '));
  ok('deleting a visual takes it off the gallery with a "Moved to Trash · Undo" toast',
    /Moved “Revenue by category” to Trash/.test(toast) && /Undo/.test(toast), toast);
  await waitFor(win, `document.getElementById('as-trash-count') && !document.getElementById('as-trash-count').hidden`);
  ok('…and the sidebar\'s Trash entry counts it',
    (await win.evaluate(() => document.getElementById('as-trash-count')!.textContent)) === '1');

  await win.click('#as-trash-btn');
  await waitFor(win, `document.querySelectorAll('#tr-list .tr-row').length === 1`);
  const row = await win.evaluate(() => {
    const r = document.querySelector('#tr-list .tr-row') as HTMLElement;
    return {
      name: (r.querySelector('.tr-name') || {} as any).textContent,
      type: r.dataset.type,
      left: (r.querySelector('.tr-left') || {} as any).textContent,
      actions: [...r.querySelectorAll('button')].map((b) => (b.textContent || '').trim()),
    };
  });
  ok('Trash lists it by name and type', row.name === NAME && row.type === 'visual', JSON.stringify(row));
  ok('…with "30 days left"', row.left === '30 days left', JSON.stringify(row));
  ok('…and Restore / Delete permanently on the row',
    JSON.stringify(row.actions) === JSON.stringify(['Restore', 'Delete permanently']), JSON.stringify(row));
  await shot(win, 'trash-page');

  await win.click('#tr-list .tr-restore');
  await waitFor(win, `document.querySelectorAll('#tr-list .tr-row').length === 0 && !document.getElementById('tr-empty').hidden`);
  ok('Restore empties the Trash, which shows its empty state',
    await win.evaluate(() => !!document.querySelector('#tr-empty .ws-empty') && document.getElementById('as-trash-count')!.hidden));
  await win.evaluate(async () => { const w = window as any; w.selectSection('visuals'); await w.refreshVisualList(); });
  ok('…and the visual is back on Visuals',
    await waitFor(win, `[...document.querySelectorAll('.viz-card')].some((c) => /${NAME}/.test(c.textContent || ''))`));
}

// ── 3. Lineage ───────────────────────────────────────────────────────────────
async function lineageSection(win: Win, ids: { projectId: string; datasetId: string }): Promise<void> {
  await win.evaluate(async (a: any) => {
    const w = window as any;
    w.selectSection('datasets');
    await w.openSavedDataset(a.datasetId);
  }, ids);
  await waitFor(win, `!document.getElementById('ds-explorer-usedin').hidden`);
  const usedIn = await win.evaluate(() => (document.querySelector('#ds-explorer-usedin span') || {} as any).textContent);
  ok('the dataset header says what uses it', usedIn === 'Used in 3 visuals · 1 dashboard', String(usedIn));

  await win.click('#ds-explorer-usedin');
  await waitFor(win, `document.querySelectorAll('.ws-side[data-kind="lineage"] .ln-node').length > 0`);
  const graph = await win.evaluate(() => {
    const nodes = [...document.querySelectorAll('.ln-node')].map((g) => ({
      kind: ([...g.classList].find((c) => c.startsWith('ln-node--')) || '').slice(9),
      name: ((g.querySelector('title') || {} as any).textContent || '').split('\n')[0],
      focus: g.classList.contains('is-focus'),
    }));
    return { nodes, edges: document.querySelectorAll('.ln-edge').length };
  });
  const of = (k: string) => graph.nodes.filter((n: any) => n.kind === k).map((n: any) => n.name).sort();
  ok('Lineage opens on the dataset, highlighted',
    graph.nodes.some((n: any) => n.kind === 'dataset' && n.name === 'Retail orders' && n.focus), JSON.stringify(graph.nodes));
  ok('…with the Month calculated field', of('calc').join() === 'Month', JSON.stringify(of('calc')));
  ok('…three visuals', of('visual').length === 3, JSON.stringify(of('visual')));
  ok('…and one dashboard', of('dashboard').join() === 'Retail overview', JSON.stringify(of('dashboard')));
  ok('…joined by curves', graph.edges >= 6, String(graph.edges));

  // Hover a chart: the other two charts are not on its path and step back.
  await win.locator('.ln-node--visual', { hasText: 'Revenue by month' }).hover();
  const hover = await win.evaluate(() => ({
    hovering: document.querySelector('.ln-svg')!.classList.contains('is-hovering'),
    dimmedVisuals: [...document.querySelectorAll('.ln-node--visual:not(.is-related)')].length,
  }));
  ok('hovering a node dims the paths it is not on', hover.hovering && hover.dimmedVisuals === 2, JSON.stringify(hover));
  await win.mouse.move(5, 5);
  await shot(win, 'lineage');
  await win.click('.ws-side .ws-side-x');
}

// ── 4. Projects ──────────────────────────────────────────────────────────────
async function projectsSection(win: Win, app: App): Promise<void> {
  // The native dialogs cannot be driven, so main's are answered with a path in
  // the test profile — the handlers, the bundle and the renderer flow are real.
  const bundlePath = path.join(userData, 'sample.ordinate');
  await app.evaluate(({ dialog }: any, p: string) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, bundlePath);
  await win.evaluate(() => (window as any).selectSection('home'));
  const openSwitcher = async (): Promise<any[]> => {
    await win.click('#as-project-btn');
    await waitFor(win, `document.querySelectorAll('.pj-pop .pj-row').length > 0`);
    return win.evaluate(() => [...document.querySelectorAll('.pj-pop .pj-row')].map((r) => ({
      name: (r.querySelector('.pj-row-name') || {} as any).textContent,
      meta: (r.querySelector('.pj-row-meta') || {} as any).textContent,
      current: r.classList.contains('is-current'),
      sample: !!r.querySelector('.pj-badge'),
    })));
  };
  let rows = await openSwitcher();
  ok('the switcher lists the one project, current, with its counts and the Sample badge',
    rows.length === 1 && rows[0].current && rows[0].sample && /1 dataset · 1 dashboard · opened/.test(rows[0].meta), JSON.stringify(rows));

  // Export the sample through the row's ⋯.
  await win.hover('.pj-pop .pj-row');
  await win.click('.pj-pop .pj-row .pj-more');
  await win.locator('.pj-menu .chart-menu-item', { hasText: 'Export project' }).click();
  ok('Export project… writes a .ordinate bundle', await waitFor(win, `[...document.querySelectorAll('#hub-toast .toast')].some((t) => /Exported/.test(t.textContent || ''))`)
    && fs.existsSync(bundlePath) && fs.statSync(bundlePath).size > 1000);

  // New project "Test".
  await openSwitcher();
  await win.click('.pj-pop .pj-new');
  await win.waitForSelector('.ws-modal-overlay .ws-modal-input');
  await win.fill('.ws-modal-overlay .ws-modal-input', 'Test');
  await win.keyboard.press('Enter');
  await waitFor(win, `(document.getElementById('ws-project-name') || {}).textContent === 'Test'`);
  ok('New project creates "Test" and switches to it, no reload',
    (await win.evaluate(() => document.getElementById('ws-project-name')!.textContent)) === 'Test');
  rows = await openSwitcher();
  ok('…and the switcher shows two', rows.length === 2 && rows.some((r) => r.name === 'Test' && r.current), JSON.stringify(rows));

  // Import the bundle: a third project.
  await win.click('.pj-pop .pj-import');
  await waitFor(win, `/^My project/.test((document.getElementById('ws-project-name') || {}).textContent || '') && document.getElementById('ws-project-name').textContent !== 'My project'`, 30000);
  const imported = await win.evaluate(() => document.getElementById('ws-project-name')!.textContent);
  ok('Import project… opens the bundle into a NEW project and switches to it', /^My project \(imported\)$/.test(String(imported)), String(imported));
  await sleep(1500); // let Home finish repainting for the new project before the picture
  rows = await openSwitcher();
  ok('…a third project in the switcher', rows.length === 3, JSON.stringify(rows.map((r) => r.name)));
  await sleep(400); // the popover fades in (--dur-menu); a shot fired at once catches it transparent
  await shot(win, 'projects-switcher');
  await win.keyboard.press('Escape');

  // Its dashboard renders, drawn from the imported dataset.
  await win.evaluate(async () => { const w = window as any; w.selectSection('analyses'); await w.refreshAnalysisList(); });
  const listed = await waitFor(win, `document.querySelectorAll('#an-list .an-card .an-card-body').length === 1`, 30000);
  ok('the imported project lists its one dashboard', listed,
    await win.evaluate(() => document.getElementById('an-list')!.textContent!.slice(0, 200)));
  if (!listed) return;
  await win.evaluate(() => (document.querySelector('#an-list .an-card .an-card-body') as HTMLElement).click());
  await waitFor(win, `document.querySelectorAll('#dash-grid .dash-card canvas').length >= 2`, 30000);
  const dash = await win.evaluate(() => ({
    name: document.getElementById('dash-name')!.textContent,
    canvases: document.querySelectorAll('#dash-grid .dash-card canvas').length,
    missing: document.querySelectorAll('#dash-grid .dash-card-missing').length,
  }));
  ok('the imported dashboard renders its charts, none missing a source',
    dash.name === 'Retail overview' && dash.canvases >= 2 && dash.missing === 0, JSON.stringify(dash));
  await win.evaluate(() => (window as any).handleBackToList());
}

async function main(): Promise<void> {
  const app = await _electron.launch({
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData, '--enable-unsafe-swiftshader'],
    cwd: REPO, timeout: 120_000,
  });
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');
  const errors: string[] = [];
  win.on('pageerror', (e: Error) => errors.push('pageerror: ' + e.message));
  win.on('console', (m: any) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // The first paint is a SPLASH — wait it out, then remove it defensively.
  await sleep(4000);
  await win.evaluate(() => { const s = document.getElementById('splash'); if (s) s.remove(); }).catch(() => {});
  // SMOKE_THEME=light|dark pins the theme for the screenshots; unset follows the OS.
  if (process.env.SMOKE_THEME) await win.evaluate((t: string) => (window as any).setThemePreference(t), process.env.SMOKE_THEME);

  const ids = await sampleIds(app);
  try {
    await firstRunSection(win, ids);
    await historySection(win, ids);
    await trashSection(win);
    await lineageSection(win, ids);
    await projectsSection(win, app);
  } finally {
    ok('zero renderer console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
    await closeApp(app);
  }
  process.exit(failureCount() ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
