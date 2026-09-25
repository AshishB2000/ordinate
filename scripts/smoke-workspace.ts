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

async function shot(win: Win, name: string): Promise<void> {
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
    await historySection(win, ids);
  } finally {
    ok('zero renderer console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
    await app.close().catch(() => {});
  }
  process.exit(failureCount() ? 1 : 0);
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
