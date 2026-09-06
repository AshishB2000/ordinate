// The bundled sample project, on a genuinely FIRST launch.
//
// This is its own smoke file rather than assertions bolted onto smoke-app.ts for
// two reasons, both hard. smoke-app.ts is at its allowlisted line count so it
// cannot grow; and its very first app.evaluate creates two projects of its own
// before anything asserts, which would make the newest project something other
// than the sample and mask the whole feature. A clean first launch can only be
// observed by a run that does nothing before looking.
//
// So: a fresh userData, no seeding of our own, and the first thing asserted is
// what the user actually sees.
//
//   npm run build:ts && node scripts/smoke-sample.js

export {};
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-smoke-sample-'));
const shotDir = process.env.SMOKE_ARTIFACT_DIR || userData;

async function main(): Promise<void> {
  const app = await _electron.launch({
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData, '--enable-unsafe-swiftshader'],
    cwd: REPO, timeout: 120_000,
  });
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  win.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // The first paint is a SPLASH — a screenshot there passes every size and DOM
  // check while proving nothing. Wait it out, then remove it defensively.
  await win.waitForTimeout(4000);
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});

  // ── Seeded on disk, by the real main-process path ────────────────────────
  const seeded: any = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const analysis = req('./src/analysis/analysis.js');
    const visuals = req('./src/analysis/visuals.js');
    const list = await projects.listProjects();
    const sample = list.find((p: any) => p.name === 'Sample: Retail orders');
    if (!sample) return { projects: list.map((p: any) => p.name) };
    return {
      projects: list.map((p: any) => p.name),
      newest: list[0].name,
      datasets: (await datasets.listDatasets(sample.id)).map((d: any) => ({ name: d.name, rows: d.rowCount })),
      visuals: (await visuals.listVisuals(sample.id)).map((v: any) => v.name),
      analyses: (await analysis.listAnalyses(sample.id)).map((a: any) => ({ id: a.id, name: a.name })),
    };
  });
  ok('a first launch seeds the sample project',
    Array.isArray(seeded.projects) && seeded.projects.includes('Sample: Retail orders'),
    JSON.stringify(seeded.projects));
  ok('…and an empty project that is newest, so the sample never receives real work',
    seeded.newest === 'My project', String(seeded.newest));
  ok('…with the full dataset imported',
    seeded.datasets && seeded.datasets.length === 1 && seeded.datasets[0].rows === 5000,
    JSON.stringify(seeded.datasets));
  ok('…three visuals and one dashboard',
    seeded.visuals && seeded.visuals.length === 3 && seeded.analyses.length === 1,
    JSON.stringify({ visuals: seeded.visuals, analyses: seeded.analyses }));

  // ── Home is not empty ────────────────────────────────────────────────────
  await win.evaluate(() => { (window as any).selectSection('home'); });
  await win.waitForTimeout(2500);
  const home = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#home-starred-rows .home-row')];
    const chips = [...document.querySelectorAll('#home-ask-suggests .home-ask-chip')]
      .map((c) => (c.textContent || '').trim());
    return {
      starred: rows.map((r) => ((r.querySelector('.home-row-name') || {}) as any).textContent || ''),
      chips,
    };
  });
  ok('the sample dashboard is pinned to Home, so Starred is not an empty state',
    home.starred.some((n: string) => /Retail overview/.test(n)), JSON.stringify(home.starred));
  ok('…and the ask bar suggests questions written for the sample',
    home.chips.includes('Which region had the worst month?'), JSON.stringify(home.chips));

  // ── Opening it from Home renders real tiles ──────────────────────────────
  // Clicked, not called: the row IS the path a first-time user takes.
  await win.evaluate(() => {
    const row = [...document.querySelectorAll('#home-starred-rows .home-row')]
      .find((r) => /Retail overview/.test(((r.querySelector('.home-row-name') || {}) as any).textContent || ''));
    if (row) (row as HTMLElement).click();
  });
  await win.waitForTimeout(7000);

  const tiles = await win.evaluate(() => [...document.querySelectorAll('#dash-grid .dash-card')].map((c) => {
    const r = c.getBoundingClientRect();
    return {
      kind: (c.className.match(/dash-card--(\w+)/) || [])[1],
      title: ((c.querySelector('.dash-card-title') || {}) as any).textContent || '',
      metric: ((c.querySelector('.dash-metric-value') || {}) as any).textContent || '',
      canvas: !!c.querySelector('canvas'),
      w: Math.round(r.width), h: Math.round(r.height),
    };
  }));
  ok('the sample dashboard opens with at least five tiles', tiles.length >= 5, JSON.stringify(tiles.map((t) => t.kind)));
  ok('…every tile is laid out, none collapsed',
    tiles.every((t) => t.w > 10 && t.h > 10), JSON.stringify(tiles.map((t) => `${t.w}x${t.h}`)));
  // A KPI showing "—" is what a sample built on mistyped columns looks like, and
  // it would pass every structural check above.
  const kpis = tiles.filter((t) => t.kind === 'metric');
  ok('…every KPI shows a real figure, not a dash',
    kpis.length === 4 && kpis.every((k) => /\d/.test(k.metric)), JSON.stringify(kpis.map((k) => k.metric)));
  const charts = tiles.filter((t) => t.kind === 'visual');
  ok('…and every chart drew onto a canvas',
    charts.length === 3 && charts.every((c) => c.canvas), JSON.stringify(charts.map((c) => c.title)));

  // The map is the one tile that needs WebGL2 and the shipped GeoJSON, so its
  // canvas is asserted separately — MapLibre renders into its own.
  const map = await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')]
      .find((c) => /Profit by state/.test(((c.querySelector('.dash-card-title') || {}) as any).textContent || ''));
    if (!card) return { found: false };
    const cv = card.querySelector('canvas') as HTMLCanvasElement | null;
    const fallback = card.querySelector('.cv-chart-fallback');
    return {
      found: true,
      canvas: !!cv, w: cv ? cv.width : 0, h: cv ? cv.height : 0,
      fallback: fallback ? (fallback.textContent || '') : '',
    };
  });
  ok('the choropleth renders a real map, not the no-WebGL fallback',
    Boolean(map.found && map.canvas && (map.w || 0) > 100 && (map.h || 0) > 50 && !map.fallback),
    JSON.stringify(map));

  // ── Screenshots for the PR, both themes ─────────────────────────────────
  // Through setThemePreference, not by poking data-theme: main owns the
  // preference and pushes the resolved value back, so a hand-set attribute is
  // overwritten on the next push and both screenshots come out identical.
  // A dashboard carries its OWN style (theme/density/accent on #dash-editor), so
  // flipping the app theme deliberately does not repaint its tiles — the sample
  // ships with the default Clean style like any new dashboard. The dark shot
  // therefore switches BOTH, which is also the honest picture of what a user on
  // a dark machine sees once they pick the Dark dashboard style.
  for (const theme of ['light', 'dark']) {
    await win.evaluate(async (t: string) => { await (window as any).hub.setThemePreference(t); }, theme);
    await win.waitForTimeout(1500);
    const applied = await win.evaluate(() => document.documentElement.dataset.theme);
    ok(`the app switches to the ${theme} theme`, applied === theme, String(applied));
    await win.evaluate((t: string) => {
      if (typeof (window as any).applyDashStylePreset === 'function') {
        (window as any).applyDashStylePreset(t === 'dark' ? 'dark' : 'clean');
      }
    }, theme);
    await win.waitForTimeout(3000); // charts rebuild and re-read their tokens
    await win.screenshot({ path: path.join(shotDir, `sample-dashboard-${theme}.png`) });
  }
  // Back to the shipped default before the delete assertions below.
  await win.evaluate(() => {
    if (typeof (window as any).applyDashStylePreset === 'function') (window as any).applyDashStylePreset('clean');
  });
  await win.waitForTimeout(1500);
  await win.evaluate(async () => { await (window as any).hub.setThemePreference('light'); });
  await win.waitForTimeout(1500);
  console.log('screenshots: ' + shotDir);

  // ── The note card's Delete actually deletes ─────────────────────────────
  // The note promises the sample can be removed, and until this change nothing
  // in the app could delete a project at all — projects:delete had a handler, a
  // preload binding and a type, and no caller. Done LAST, because it destroys
  // the fixture everything above needed.
  const deleted = await win.evaluate(async () => {
    const btn = document.querySelector('#dash-grid .dash-sample-delete') as HTMLElement | null;
    if (!btn) return { found: false };
    const origConfirm = window.confirm;
    (window as any).confirm = () => true; // the dialog is the user's, not the test's
    btn.click();
    await new Promise((r) => setTimeout(r, 4000));
    (window as any).confirm = origConfirm;
    return { found: true, section: (document.querySelector('.hub-body') as HTMLElement | null)?.dataset.section || '' };
  });
  ok('the note card offers a working Delete', deleted.found === true, JSON.stringify(deleted));
  ok('…which returns to Home', deleted.section === 'home', JSON.stringify(deleted));

  const after: any = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const nodeFs = req('fs');
    const nodePath = req('path');
    const { app: electronApp } = req('electron');
    const projects = req('./src/app/projects.js');
    const base = nodePath.join(electronApp.getPath('userData'), 'projects');
    const walk = (dir: string, out: string[] = []): string[] => {
      if (!nodeFs.existsSync(dir)) return out;
      for (const e of nodeFs.readdirSync(dir, { withFileTypes: true })) {
        const p = nodePath.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else out.push(p);
      }
      return out;
    };
    return {
      names: (await projects.listProjects()).map((p: any) => p.name),
      parquet: walk(base).filter((f) => f.endsWith('.parquet')),
    };
  });
  ok('…removing the sample project from disk',
    !after.names.includes('Sample: Retail orders'), JSON.stringify(after.names));
  ok('…and leaving no orphan Parquet behind', after.parquet.length === 0, JSON.stringify(after.parquet));

  ok('no renderer console errors on a first launch', errors.length === 0, errors.slice(0, 3).join(' | '));

  await app.close();
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
}

main()
  .then(() => {
    if (failureCount()) {
      console.error('\n' + failureCount() + ' sample smoke check(s) FAILED');
      process.exit(1);
    }
    console.log('\nAll sample smoke checks passed.');
  })
  .catch((err) => { console.error(err); process.exit(1); });
