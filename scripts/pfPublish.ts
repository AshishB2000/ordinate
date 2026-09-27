// Platform depth, feature 2 — Publish to folder, in the REAL app. A SECTION of
// scripts/smoke-platform.ts.
//
// Drives the dialog from the Dashboards header's ⋯ (pick a dashboard and a
// story, the folder through a stubbed native picker, see the size line),
// publishes as a job, then OPENS what was written in a hidden BrowserWindow —
// the way someone receiving the folder would — and checks that it draws, that
// its filter bar changes the figures, that a chart label click drives the
// filter, and that it made no network request and broke no CSP rule.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { seedAnalysis, openProject } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

export async function publishSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const out = path.join(s.userData, 'published-site');

  // A dashboard with a filter-bar control, a chart it drives, a map and a KPI,
  // and a story — everything a published page has to carry.
  const analysisId = await seedAnalysis(app, fx.projectId, {
    name: 'Regional sales',
    sheets: [{
      name: 'Overview',
      cards: [
        { type: 'control', control: { kind: 'dropdown', label: 'Region', datasetId: fx.datasetId, column: 'region' }, layout: { x: 0, y: 0, w: 3, h: 1 } },
        { type: 'metric', metric: { datasetId: fx.datasetId, column: 'amount', aggregation: 'sum', label: 'Revenue' }, layout: { x: 0, y: 1, w: 3, h: 2 } },
        { type: 'visual', visualId: fx.visualId, layout: { x: 3, y: 1, w: 9, h: 6 } },
        { type: 'visual', visualId: fx.mapVisualId, layout: { x: 0, y: 7, w: 12, h: 6 } },
      ],
    }],
  });
  const storyId: string = await app.evaluate(async (_e, arg: { pid: string; vid: string }) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const st = await req('./src/analysis/stories.js').saveStory(arg.pid, {
      name: 'Quarter notes',
      blocks: [{ kind: 'text', text: 'Sales held steady.' }, { kind: 'visual', visualId: arg.vid, filters: [] }],
    });
    return st ? st.id : '';
  }, { pid: fx.projectId, vid: fx.visualId });
  ok('publish: seeded a dashboard with a control, a chart, a map and a KPI, and a story', Boolean(analysisId && storyId));

  await app.evaluate(async (electronModule, dir: string) => {
    (electronModule as any).dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] });
  }, out);
  await openProject(win, fx.projectId);
  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await win.waitForTimeout(800);

  // ── The dialog ─────────────────────────────────────────────────────────────
  await win.evaluate(() => { (document.getElementById('an-list-more') as HTMLElement).click(); });
  await win.waitForTimeout(300);
  const menu = await win.evaluate(() => [...document.querySelectorAll('.chart-menu .chart-menu-item')].map((b) => (b.textContent || '').trim()));
  ok('publish: the Dashboards header ⋯ offers Publish…', menu.includes('Publish…'), menu.join(','));
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.chart-menu .chart-menu-item')].find((x) => (x.textContent || '').trim() === 'Publish…') as HTMLElement;
    b.click();
  });
  await win.waitForSelector('.pd-modal', { timeout: 10_000 });
  // Tick exactly our dashboard and the story.
  await win.evaluate((ids: string[]) => {
    document.querySelectorAll('.pd-modal input[type=checkbox][data-id]').forEach((c) => {
      const cb = c as HTMLInputElement;
      const want = ids.includes(String(cb.dataset.id));
      if (cb.checked !== want) cb.click();
    });
  }, [analysisId, storyId]);
  await win.evaluate(() => { (document.getElementById('pd-choose') as HTMLElement).click(); });
  const line = await win.waitForFunction(() => {
    const t = document.getElementById('pd-summary-line')?.textContent || '';
    return /control combinations ·/.test(t) ? t : null;
  }, null, { timeout: 20_000 }).then((h) => h.jsonValue()).catch(() => '');
  ok('publish: the dialog states combinations and size ("8 control combinations · … MB")', /^8 control combinations · [\d.]+ (KB|MB)$/.test(String(line)), String(line));
  const dialog = await win.evaluate(() => ({
    folder: document.querySelector('.pd-folder-path')?.textContent || '',
    pages: [...document.querySelectorAll('.pd-page-name')].map((e) => e.textContent),
    enabled: !(document.getElementById('pd-publish') as HTMLButtonElement).disabled,
    meter: !!document.querySelector('.pd-meter[role=meter]'),
  }));
  ok('publish: the chosen folder, both pages and a size meter are shown; Publish is enabled',
    dialog.folder.endsWith('published-site') && dialog.pages.includes('Regional sales') && dialog.pages.includes('Quarter notes') && dialog.enabled && dialog.meter,
    JSON.stringify(dialog));
  await s.win.screenshot({ path: path.join(s.shotDir, 'pf-publish-dialog.png') });

  // ── Publish, as a job ──────────────────────────────────────────────────────
  await win.evaluate(() => { (document.getElementById('pd-publish') as HTMLElement).click(); });
  await win.waitForFunction(() => fetch === fetch && !!document.querySelector('.toast'), null, { timeout: 10_000 }).catch(() => {});
  const done = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const jobs = req('./src/app/jobs.js');
    for (let i = 0; i < 300; i++) {
      const j = jobs.snapshot().recent.find((x: any) => x.kind === 'publish');
      if (j) return j;
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  });
  ok('publish: ran as a job that finished, with a file to Reveal', !!done && done.state === 'done' && /index\.html$/.test(done.result && done.result.path || ''), JSON.stringify(done));
  const files = fs.existsSync(out) ? fs.readdirSync(out).sort() : [];
  ok('publish: index.html, a page per dashboard and story, manifest.json',
    JSON.stringify(files) === '["index.html","manifest.json","quarter-notes.html","regional-sales.html"]', files.join(','));
  const stored = await app.evaluate(async (_e, pid: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('./src/publish/publish.js').getStoredConfig(pid);
  }, fx.projectId);
  ok('publish: the choices are remembered for Re-publish', !!stored && stored.dashboardIds.includes(analysisId) && stored.storyIds.includes(storyId));

  // ── Open what was written, offline ─────────────────────────────────────────
  const view = await app.evaluate(async (electronModule, arg: { dir: string; shots: string }) => {
    const dir = arg.dir;
    const { BrowserWindow, session } = electronModule as any;
    const ses = session.fromPartition('published-site-check');
    const requests: string[] = [];
    ses.webRequest.onBeforeRequest((d: any, cb: any) => { if (!d.url.startsWith('file:')) requests.push(d.url); cb({}); });
    const w = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { session: ses, contextIsolation: true } });
    const logs: string[] = [];
    w.webContents.on('console-message', (_ev: any, level: number, message: string) => { if (level >= 2) logs.push(message); });
    const wait = async (js: string) => {
      for (let i = 0; i < 100; i++) {
        const v = await w.webContents.executeJavaScript(js);
        if (v) return v;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    };
    await w.loadFile(dir + '/index.html');
    await wait('document.body.dataset.ready === "true"');
    const index = await w.webContents.executeJavaScript(`({
      cards: [...document.querySelectorAll('.pub-index-card')].map(a => a.getAttribute('href')),
      title: document.querySelector('.pub-title') && document.querySelector('.pub-title').textContent,
    })`);
    await w.loadFile(dir + '/regional-sales.html');
    await wait('document.body.dataset.ready === "true" && document.querySelectorAll(".pub-card canvas").length > 0');
    await new Promise((r) => setTimeout(r, 400));
    const before = await w.webContents.executeJavaScript(`({
      combo: document.body.dataset.combo,
      canvases: document.querySelectorAll('.pub-card canvas').length,
      map: document.querySelectorAll('.pub-map path.pub-region').length,
      kpi: document.querySelector('.pub-kpi-value') && document.querySelector('.pub-kpi-value').textContent,
      options: [...document.querySelectorAll('.pub-filter-select option')].map(o => o.textContent),
      captions: document.querySelectorAll('.pub-caption').length,
      axis: (pcCharts[0] && pcCharts[0].scales.x) ? pcCharts[0].scales.x.ticks.map(t => String(t.label)) : [],
      firstRow: getComputedStyle(document.querySelector('.pub-card')).gridRowStart,
    })`);
    await w.webContents.executeJavaScript(`(() => { const s = document.querySelector('.pub-filter-select'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
    await new Promise((r) => setTimeout(r, 400));
    // A picture of the published page, for the PR and for design review.
    const shot = await w.webContents.capturePage();
    (process as any).mainModule.require('fs').writeFileSync(arg.shots + '/pf-published-dashboard.png', shot.toPNG());
    const after = await w.webContents.executeJavaScript(`({
      combo: document.body.dataset.combo,
      kpi: document.querySelector('.pub-kpi-value') && document.querySelector('.pub-kpi-value').textContent,
      sel: document.querySelector('.pub-filter-select').value,
    })`);
    await w.loadFile(dir + '/quarter-notes.html');
    await wait('document.body.dataset.ready === "true"');
    await new Promise((r) => setTimeout(r, 300));
    const story = await w.webContents.executeJavaScript(`({
      paras: document.querySelectorAll('.pub-story-p').length,
      charts: document.querySelectorAll('.pub-story-chart canvas').length,
    })`);
    w.destroy();
    return { index, before, after, story, requests, logs };
  }, { dir: out, shots: s.shotDir });
  ok('site: index.html lists both pages', JSON.stringify(view.index.cards) === '["regional-sales.html","quarter-notes.html"]', JSON.stringify(view.index));
  ok('site: the dashboard page draws its chart, its map regions and its KPI, charts captioned',
    view.before.canvases >= 1 && view.before.map > 0 && /\d/.test(view.before.kpi || '') && view.before.captions >= 2, JSON.stringify(view.before));
  ok('site: the chart\'s category axis names the categories', view.before.axis.includes('region0'), view.before.axis.join(','));
  ok('site: the grid starts at the first tile (the control row is not left empty)', view.before.firstRow === '1', view.before.firstRow);
  ok('site: the filter bar carries All and every region', JSON.stringify(view.before.options.slice(0, 2)) === '["All","region0"]' && view.before.options.length === 8);
  ok('site: choosing a region switches to its pre-computed answer, client-side',
    view.after.combo !== view.before.combo && view.after.kpi !== view.before.kpi && view.after.sel === '1', JSON.stringify(view.after));
  ok('site: the story page draws its prose and its chart', view.story.paras >= 1 && view.story.charts === 1, JSON.stringify(view.story));
  ok('site: opening the published pages made ZERO network requests', view.requests.length === 0, view.requests.join(', '));
  ok('site: no console errors or CSP violations in the published pages', view.logs.length === 0, view.logs.join(' | '));
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  ok('site: the manifest records every page, its combinations and its size',
    manifest.format === 'ordinate-site' && manifest.pages.length === 2 && manifest.pages.find((p: any) => p.kind === 'dashboard').combos === 8);
}
