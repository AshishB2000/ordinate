// The bundled sample, on a genuinely FIRST launch.
//
// THE ASSERTIONS THAT MATTER ARE THE RENDERED ONES. Everything used to be
// checked on disk, and on disk everything was fine: the sample project existed,
// the dataset had 5000 rows, the dashboard had its tiles. What the user actually
// saw was Home reading "My project · 0 datasets · 0 dashboards" over a Starred
// row for that dashboard, Data saying "No datasets yet" and Dashboards saying
// "No dashboards yet" — because the sample was seeded into its OWN project and
// an empty "My project" was created last to be the adopted one, while Home's
// Recent and Starred are the app's only global-across-projects surfaces. Three
// of four surfaces empty. So this file reads the counts and the lists off the
// rendered page, which is the only place that bug was visible.
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
    if (!list.length) return { projects: [] };
    const only = list[0];
    return {
      projects: list.map((p: any) => p.name),
      datasets: (await datasets.listDatasets(only.id)).map((d: any) => ({ name: d.name, rows: d.rowCount })),
      visuals: (await visuals.listVisuals(only.id)).map((v: any) => v.name),
      analyses: (await analysis.listAnalyses(only.id)).map((a: any) => ({ id: a.id, name: a.name })),
    };
  });
  ok('a first launch creates exactly ONE project',
    Array.isArray(seeded.projects) && seeded.projects.length === 1, JSON.stringify(seeded.projects));
  ok('…named "My project" — the user\'s own, not a sample-only one',
    seeded.projects[0] === 'My project', JSON.stringify(seeded.projects));
  ok('…holding the sample dataset, every row of the committed CSV',
    seeded.datasets && seeded.datasets.length === 1
    && seeded.datasets[0].name === 'Retail orders' && seeded.datasets[0].rows === 5000,
    JSON.stringify(seeded.datasets));
  ok('…and the sample dashboard with its three charts',
    seeded.visuals && seeded.visuals.length === 3
    && seeded.analyses.length === 1 && seeded.analyses[0].name === 'Retail overview',
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
      sub: ((document.getElementById('home-greet-sub') || {}) as any).textContent || '',
    };
  });
  ok('the sample dashboard is pinned to Home, so Starred is not an empty state',
    home.starred.some((n: string) => /Retail overview/.test(n)), JSON.stringify(home.starred));
  ok('…and the ask bar suggests questions written for the sample',
    home.chips.includes('Which region had the worst month?'), JSON.stringify(home.chips));
  // THE BUG, in one assertion. Home's subtitle counts the ADOPTED project's
  // records; Starred above counts across all of them. They read "0 datasets ·
  // 0 dashboards" and "Retail overview" at the same time, on the same screen.
  ok('…and the header counts AGREE with what Starred is showing',
    /\b1 dataset\b/.test(home.sub) && /\b1 dashboard\b/.test(home.sub), home.sub);
  ok('…naming the one project', /My project/.test(home.sub), home.sub);
  await win.screenshot({ path: path.join(shotDir, 'sample-home.png') });

  // ── Data lists the sample, instead of "No datasets yet" ──────────────────
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(2500);
  const dataPage = await win.evaluate(() => ({
    rows: [...document.querySelectorAll('#ds-saved-list .ds-saved-item .ds-saved-name')]
      .map((r) => (r.textContent || '').trim()).filter(Boolean),
    emptyShown: !(document.getElementById('ds-saved-empty') as HTMLElement).hidden,
  }));
  ok('the Data page lists "Retail orders"',
    dataPage.rows.some((t: string) => /Retail orders/.test(t)), JSON.stringify(dataPage.rows.slice(0, 4)));
  ok('…and is not showing its "No datasets yet" empty state', dataPage.emptyShown === false);
  await win.screenshot({ path: path.join(shotDir, 'sample-data.png') });

  // ── Dashboards lists the sample, instead of "No dashboards yet" ──────────
  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await win.waitForTimeout(2500);
  const dashPage = await win.evaluate(() => ({
    rows: [...document.querySelectorAll('#an-list > *')].map((r) => (r.textContent || '').trim()).filter(Boolean),
    emptyShown: !(document.getElementById('an-list-empty') as HTMLElement).hidden,
  }));
  ok('the Dashboards page lists "Retail overview"',
    dashPage.rows.some((t: string) => /Retail overview/.test(t)), JSON.stringify(dashPage.rows.slice(0, 4)));
  ok('…and is not showing its "No dashboards yet" empty state', dashPage.emptyShown === false);
  await win.screenshot({ path: path.join(shotDir, 'sample-dashboards.png') });

  await win.evaluate(() => { (window as any).selectSection('home'); });
  await win.waitForTimeout(2000);

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

  // …and it gets the whole row. planBuild derives a chart's width from how many
  // charts share the sheet, so three charts are three half-widths and the map
  // landed alone in half a row, state shapes too small to read. Measured off the
  // laid-out tiles rather than the stored layout: the point is what the user sees.
  const widths = await win.evaluate(() => {
    const cards = [...document.querySelectorAll('#dash-grid .dash-card--visual')];
    const of = (re: RegExp) => {
      const c = cards.find((e) => re.test(((e.querySelector('.dash-card-title') || {}) as any).textContent || ''));
      return c ? Math.round(c.getBoundingClientRect().width) : 0;
    };
    return { map: of(/Profit by state/), month: of(/Revenue by month/), cat: of(/Revenue by category/) };
  });
  ok('…across the full row, not half of one',
    widths.map > widths.month * 1.7 && widths.map > widths.cat * 1.7, JSON.stringify(widths));

  // A month-grain axis printed '2023-01-01' twelve times over, the day part noise
  // on every one. Read off the live Chart.js instance, which is what the axis, the
  // tooltip and the value labels all draw from.
  const monthLabels = await win.evaluate(() => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')]
      .find((c) => /Revenue by month/.test(((c.querySelector('.dash-card-title') || {}) as any).textContent || ''));
    const cv = card && card.querySelector('canvas');
    const chart = cv && (window as any).Chart && (window as any).Chart.getChart(cv);
    return chart ? chart.data.labels.slice(0, 3) : null;
  });
  ok('the month axis reads as months, not ISO dates',
    Array.isArray(monthLabels) && monthLabels.length === 3
      && monthLabels.every((l: string) => /^[A-Z][a-z]{2} \d{4}$/.test(l)),
    JSON.stringify(monthLabels));

  // ── Screenshots for the PR, both themes ─────────────────────────────────
  // Through setThemePreference, not by poking data-theme: main owns the
  // preference and pushes the resolved value back, so a hand-set attribute is
  // overwritten on the next push and both screenshots come out identical.
  // The app theme is the ONLY thing switched. A dashboard's style theme now
  // defaults to 'auto', which declares no tokens of its own and lets the sheet
  // inherit the app's — so the sample follows the app, and these two shots are
  // what a user on a light and a dark machine actually sees.
  //
  // This block used to force the Dark and Clean presets alongside the switch,
  // because the default was 'clean' and the sheet stayed white inside a dark
  // app. Forcing them now would be worse than redundant: applyDashStylePreset
  // records a deliberate choice, so the reset afterwards would PIN the sample to
  // Light rather than return it to the shipped default.
  for (const theme of ['light', 'dark']) {
    await win.evaluate(async (t: string) => { await (window as any).hub.setThemePreference(t); }, theme);
    await win.waitForTimeout(3000); // charts rebuild and re-read their tokens
    const applied = await win.evaluate(() => {
      const ed = document.getElementById('dash-editor') as HTMLElement;
      return {
        root: document.documentElement.dataset.theme,
        sheetBg: getComputedStyle(ed).getPropertyValue('--bg').trim(),
      };
    });
    ok(`the app switches to the ${theme} theme`, applied.root === theme, JSON.stringify(applied));
    // Rough luminance: the sheet must follow, not sit white inside a dark app.
    const rgb = (/(\d+)\D+(\d+)\D+(\d+)/.exec(applied.sheetBg) || []).slice(1).map(Number);
    const hex = /^#([0-9a-f]{6})$/i.exec(applied.sheetBg);
    const px = hex ? [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) : rgb;
    const lum = px.length === 3 ? (0.2126 * px[0] + 0.7152 * px[1] + 0.0722 * px[2]) / 255 : 1;
    ok(`…and the sample sheet follows it into ${theme}`,
      theme === 'dark' ? lum < 0.3 : lum > 0.8, `${applied.sheetBg} → lum ${lum.toFixed(2)}`);
    await win.screenshot({ path: path.join(shotDir, `sample-dashboard-${theme}.png`) });
  }
  await win.evaluate(async () => { await (window as any).hub.setThemePreference('light'); });
  await win.waitForTimeout(1500);
  console.log('screenshots: ' + shotDir);

  // The note card carries the behaviour change, so it gets its own shot.
  await win.evaluate(() => {
    const btn = document.querySelector('#dash-grid .dash-sample-delete');
    if (btn) btn.scrollIntoView({ block: 'center' });
  });
  await win.waitForTimeout(1200);
  await win.screenshot({ path: path.join(shotDir, 'sample-note-card.png') });

  // ── The note card's Remove takes the SAMPLE, and leaves the PROJECT ──────
  // The note promises the sample can be taken out. It used to do that by
  // deleting the whole project, which was right when the sample had one to
  // itself; now the project is the user's only one, so removing the sample must
  // remove three records and leave the project standing. Done LAST, because it
  // destroys the fixture everything above needed.
  const deleted = await win.evaluate(async () => {
    const btn = document.querySelector('#dash-grid .dash-sample-delete') as HTMLElement | null;
    if (!btn) return { found: false };
    const origConfirm = window.confirm;
    (window as any).confirm = () => true; // the dialog is the user's, not the test's
    btn.click();
    await new Promise((r) => setTimeout(r, 5000));
    (window as any).confirm = origConfirm;
    return { found: true, section: (document.querySelector('.hub-body') as HTMLElement | null)?.dataset.section || '' };
  });
  ok('the note card offers a working Remove', deleted.found === true, JSON.stringify(deleted));
  ok('…which returns to Home', deleted.section === 'home', JSON.stringify(deleted));

  const after: any = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const nodeFs = req('fs');
    const nodePath = req('path');
    const { app: electronApp } = req('electron');
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const analysis = req('./src/analysis/analysis.js');
    const visuals = req('./src/analysis/visuals.js');
    const base = nodePath.join(electronApp.getPath('userData'), 'projects');
    const walk = (dir: string, out: string[] = []): string[] => {
      if (!nodeFs.existsSync(dir)) return out;
      for (const e of nodeFs.readdirSync(dir, { withFileTypes: true })) {
        const p = nodePath.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else out.push(p);
      }
      return out;
    };
    const list = await projects.listProjects();
    const only = list[0];
    return {
      names: list.map((p: any) => p.name),
      datasets: only ? (await datasets.listDatasets(only.id)).length : -1,
      visuals: only ? (await visuals.listVisuals(only.id)).length : -1,
      analyses: only ? (await analysis.listAnalyses(only.id)).length : -1,
      parquet: walk(base).filter((f) => f.endsWith('.parquet')),
    };
  });
  ok('the project SURVIVES — it is the user\'s, and it is their only one',
    after.names.length === 1 && after.names[0] === 'My project', JSON.stringify(after.names));
  ok('…with the sample\'s dashboard, charts and dataset all gone',
    after.datasets === 0 && after.visuals === 0 && after.analyses === 0, JSON.stringify(after));
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
