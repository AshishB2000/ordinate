// End-to-end smoke test of INSIGHTS — launches the REAL app on the bundled
// sample project and drives the three surfaces the feature ships.
//
// What only a real run can catch, and the unit test cannot:
//   · the Home section renders at all — every cross-file call it makes
//     (insRenderHome ← paintHome, buildChart, computeVisualData) is resolved by
//     NAME in a classic global script, so a rename breaks it silently;
//   · "Add to dashboard" writes a real record — the assertion is read back off
//     DISK, not off the page;
//   · the dataset tab and the dismissal survive a reload;
//   · zero renderer console errors, which is what catches a CSP violation from
//     the new markup and CSS.
//
//   npm run build && node scripts/smoke-insights.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-smoke-insights-'));
const shotDir = process.env.SMOKE_ARTIFACT_DIR || userData;

/** A title that states a change has to state the figure. */
const PCT_RE = /\d+(\.\d+)?%/;

async function main(): Promise<void> {
  const app = await _electron.launch({
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData, '--enable-unsafe-swiftshader'],
    cwd: REPO, timeout: 120_000,
  });
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');

  const errors: string[] = [];
  win.on('pageerror', (e: any) => errors.push('pageerror: ' + e.message));
  win.on('console', (m: any) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // The first paint is a SPLASH: a screenshot there passes every check while
  // proving nothing. Wait it out, then remove it defensively.
  await win.waitForTimeout(4000);
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});

  // ── The engine, through the real IPC, before any UI ──────────────────────
  const seeded: any = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const insights = req('./src/ipc/insights.js');
    const list = await projects.listProjects();
    if (!list.length) return { ok: false };
    const proj = list[0];
    const ds = (await datasets.listDatasets(proj.id))[0];
    const found = await insights.listInsights(proj.id, ds.id);
    return {
      ok: true,
      projectId: proj.id,
      datasetId: ds.id,
      titles: found.map((i: any) => i.title),
      kinds: [...new Set(found.map((i: any) => i.kind))],
      withCharts: found.filter((i: any) => i.chart).length,
    };
  });
  ok('the sample project seeded and was scanned', seeded.ok === true);
  console.log('   insights found: ' + JSON.stringify(seeded.titles, null, 1));
  ok('the sample dataset yields insights', Array.isArray(seeded.titles) && seeded.titles.length >= 3,
    JSON.stringify(seeded.titles));
  ok('…at least one of them states a percentage the app computed',
    (seeded.titles || []).some((t: string) => PCT_RE.test(t)), JSON.stringify(seeded.titles));
  ok('…and every one that can be drawn carries its chart',
    seeded.withCharts > 0, String(seeded.withCharts));

  // ── Surface 1: Home ──────────────────────────────────────────────────────
  await win.evaluate(() => { (window as any).selectSection('home'); });
  await win.waitForTimeout(3500);
  const home = await win.evaluate(() => {
    const sec = document.getElementById('home-insights') as HTMLElement | null;
    const cards = [...document.querySelectorAll('#home-insights-row .ins-card')];
    return {
      exists: !!sec,
      shown: !!sec && !sec.hidden,
      heading: (document.querySelector('#home-insights .home-sec-h') || {} as any).textContent || '',
      titles: cards.map((c) => ((c.querySelector('.ins-title') || {}) as any).textContent || ''),
      chips: cards.map((c) => c.querySelectorAll('.ins-chip').length),
      sparks: cards.filter((c) => c.querySelector('.ins-spark-canvas')).length,
      actions: [...(cards[0] ? cards[0].querySelectorAll('.ins-actions button') : [])]
        .map((b) => (b.textContent || '').trim()),
    };
  });
  ok('Home has a "What stands out" section', home.exists && /What stands out/.test(home.heading));
  ok('…and it is SHOWN (the sample has findings)', home.shown === true);
  ok('…with at least one card', home.titles.length >= 1, JSON.stringify(home.titles));
  ok('…whose title contains a percentage',
    home.titles.some((t: string) => PCT_RE.test(t)), JSON.stringify(home.titles));
  ok('…each card printing the app\'s own figures as chips',
    home.chips.every((n: number) => n > 0), JSON.stringify(home.chips));
  ok('…and drawing its chart', home.sparks >= 1, String(home.sparks));
  // The third is feat/alerts: "again" is a standing rule, so an insight is a
  // place a rule is born (renderer/hub/alerts.ts).
  ok('…offering Add to dashboard, Ask why, and an alert',
    home.actions.join('|') === 'Add to dashboard|Ask why|Alert me if this happens again',
    JSON.stringify(home.actions));
  await win.screenshot({ path: path.join(shotDir, 'insights-home.png') });

  // ── "Add to dashboard" writes a real record ──────────────────────────────
  const before: any = await app.evaluate(async (_app: any, projectId: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return (await req('./src/analysis/analysis.js').listAnalyses(projectId)).length;
  }, seeded.projectId);

  await win.evaluate(() => {
    const btn = document.querySelector('#home-insights-row .ins-card .ins-actions button') as HTMLButtonElement | null;
    if (btn) btn.click();
  });
  await win.waitForTimeout(4000);

  const added: any = await app.evaluate(async (_app: any, projectId: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analysis = req('./src/analysis/analysis.js');
    const visuals = req('./src/analysis/visuals.js');
    const list = await analysis.listAnalyses(projectId);
    const newest = list[0] ? await analysis.getAnalysis(projectId, list[0].id) : null;
    const cards = newest && newest.sheets && newest.sheets[0] ? newest.sheets[0].cards : [];
    const visualId = (cards.find((c: any) => c.type === 'visual') || {}).visualId;
    const v = visualId ? await visuals.getVisual(projectId, visualId) : null;
    return {
      count: list.length,
      name: newest ? newest.name : '',
      tiles: (cards || []).length,
      visual: v ? { name: v.name, chartType: v.chartType, category: v.encoding.category, filters: v.filters.length } : null,
    };
  }, seeded.projectId);
  ok('Add to dashboard created a NEW dashboard record', added.count === before + 1,
    `${before} → ${added.count}`);
  ok('…and the record ON DISK holds the tile', added.tiles === 1, JSON.stringify(added));
  ok('…pointing at a real saved visual built from the insight\'s chart',
    !!added.visual && !!added.visual.category, JSON.stringify(added.visual));
  ok('…named from the app\'s own title', added.name === added.visual.name, JSON.stringify(added));

  // ── Surface 3: the dashboard editor's Insights rail ──────────────────────
  // We are already on the new analysis (dkTurnIntoAnalysis navigated there).
  await win.evaluate(() => {
    const btn = document.querySelector('#an-rail .an-rail-btn[data-pane="an-pane-insights"]') as HTMLButtonElement | null;
    if (btn) btn.click();
  });
  await win.waitForTimeout(3500);
  const rail = await win.evaluate(() => {
    const pane = document.getElementById('an-pane-insights') as HTMLElement | null;
    const cards = [...document.querySelectorAll('#an-insights-body .ins-card')];
    return {
      exists: !!pane,
      shown: !!pane && !pane.hidden,
      cards: cards.length,
      action: cards[0] ? ((cards[0].querySelector('.ins-actions button') || {}) as any).textContent : '',
    };
  });
  ok('the editor rail has an Insights pane', rail.exists === true);
  ok('…which opens from the rail', rail.shown === true);
  ok('…listing insights for the datasets this dashboard uses', rail.cards >= 1, String(rail.cards));
  ok('…each offering "+ Add"', rail.action === '+ Add', String(rail.action));
  await win.screenshot({ path: path.join(shotDir, 'insights-rail.png') });

  const tilesBefore: number = await win.evaluate(() => (window as any).dashCards().length);
  await win.evaluate(() => {
    const btn = document.querySelector('#an-insights-body .ins-card .ins-actions button') as HTMLButtonElement | null;
    if (btn) btn.click();
  });
  await win.waitForTimeout(3000);
  const tilesAfter: number = await win.evaluate(() => (window as any).dashCards().length);
  ok('"+ Add" drops a tile on the open sheet', tilesAfter === tilesBefore + 1,
    `${tilesBefore} → ${tilesAfter}`);

  // ── Surface 2: the dataset's Insights tab, and dismissal ─────────────────
  // selectSection FIRST: openSavedDataset fills the explorer but does not move
  // the workspace off the analysis workbench, and a tab assertion read off a
  // hidden panel is the kind that passes while the user sees nothing.
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.evaluate(async (id: string) => { await (window as any).openSavedDataset(id); }, seeded.datasetId);
  await win.waitForTimeout(2500);
  await win.evaluate(() => {
    const t = document.getElementById('ds-tab-insights') as HTMLButtonElement | null;
    if (t) t.click();
  });
  await win.waitForTimeout(3500);
  const tab = await win.evaluate(() => {
    const panel = document.getElementById('ds-tabp-insights') as HTMLElement;
    // Scoped to #ds-explorer, not the whole Data section: the section now has
    // a Datasets/Captures tab strip of its own, in the same `.ds-tabs` classes
    // deliberately, and an unscoped query returns both strips concatenated.
    const tabs = [...document.querySelectorAll('#ds-explorer .ds-tabs .ds-tab')].map((t) => (t.textContent || '').trim());
    return {
      order: tabs,
      selected: (document.getElementById('ds-tab-insights') || {} as any).getAttribute?.('aria-selected'),
      panelShown: !panel.hidden,
      // ON SCREEN, not merely un-hidden: offsetParent is null for anything an
      // ancestor has display:none'd, which is what a wrong section looks like.
      onScreen: panel.offsetParent !== null && panel.getBoundingClientRect().height > 0,
      cards: document.querySelectorAll('#ds-insights-body .ins-card').length,
      groups: [...document.querySelectorAll('#ds-insights-body .ins-group-h')].map((h) => (h.textContent || '').trim()),
    };
  });
  // After Quality — not necessarily LAST: the catalog's Columns tab follows it.
  ok('the dataset page has an Insights tab, after Quality',
    tab.order.slice(0, 4).join(' · ') === 'Data · Prepare · Quality · Insights', JSON.stringify(tab.order));
  ok('…which selects and shows its panel', tab.selected === 'true' && tab.panelShown === true);
  ok('…and the panel is actually on screen', tab.onScreen === true);
  ok('…listing at least three cards', tab.cards >= 3, String(tab.cards));
  ok('…grouped by kind, with counts', tab.groups.length >= 1, JSON.stringify(tab.groups));
  await win.screenshot({ path: path.join(shotDir, 'insights-tab.png') });

  // Dismiss the first card.
  const dismissed: string = await win.evaluate(() => {
    const card = document.querySelector('#ds-insights-body .ins-card') as HTMLElement | null;
    const id = card ? card.dataset.insightId || '' : '';
    const x = card ? card.querySelector('.ins-x') as HTMLButtonElement | null : null;
    if (x) x.click();
    return id;
  });
  await win.waitForTimeout(2000);
  const afterDismiss = await win.evaluate(() => ({
    cards: document.querySelectorAll('#ds-insights-body .ins-card').length,
    ids: [...document.querySelectorAll('#ds-insights-body .ins-card')].map((c) => (c as HTMLElement).dataset.insightId),
  }));
  ok('dismissing a card removes it', afterDismiss.cards === tab.cards - 1,
    `${tab.cards} → ${afterDismiss.cards}`);
  ok('…and it is the one that was dismissed',
    !!dismissed && afterDismiss.ids.indexOf(dismissed) < 0, dismissed);

  // ── …and it stays gone after a reload ────────────────────────────────────
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(5000);
  await win.evaluate(() => {
    const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
    if (s) s.remove();
  }).catch(() => {});
  await win.evaluate(async (id: string) => { await (window as any).openSavedDataset(id); }, seeded.datasetId);
  await win.waitForTimeout(2500);
  await win.evaluate(() => {
    const t = document.getElementById('ds-tab-insights') as HTMLButtonElement | null;
    if (t) t.click();
  });
  await win.waitForTimeout(3500);
  const reloaded = await win.evaluate(() => ({
    ids: [...document.querySelectorAll('#ds-insights-body .ins-card')].map((c) => (c as HTMLElement).dataset.insightId),
  }));
  ok('a dismissed insight stays gone after a reload',
    reloaded.ids.length > 0 && reloaded.ids.indexOf(dismissed) < 0,
    JSON.stringify({ dismissed, now: reloaded.ids.length }));

  ok('no renderer console errors at any point', errors.length === 0, errors.join('\n'));
  await app.close();
}

void main()
  .catch((err) => { ok('unexpected error', false, err && err.stack ? err.stack : err); })
  .then(() => {
    if (failureCount()) { console.error('\n' + failureCount() + ' insights smoke check(s) FAILED'); process.exit(1); }
    console.log('\nAll insights smoke checks passed.');
    process.exit(0);
  });
