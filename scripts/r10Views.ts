// Round-10 smoke SECTION: saved views, driven through the REAL UI. Not a
// standalone smoke — scripts/smoke-round10.ts calls viewsSection(s, fx) on its
// one launch.
//
//   The sample dashboard gets a Region control and a second page → the Views
//   menu's empty state → a reader's state (Region = West, a Technology
//   selection, page 2) saved as a view from the menu → main stored exactly that
//   → rename and set as default from the row's actions → reopening the
//   dashboard lands on it → a ⌘K row "Dashboard › View" opens it → main parses
//   an ordinate:// link (and refuses a bad one), and acting on it opens the app
//   on the view → the project bundle carries the views and an import brings
//   them back → the published page offers it → a report's scope is the view's →
//   update and delete from the menu. The sample is restored exactly, the
//   control, page and views it added are gone, and the imported copy is deleted.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject, domDriver } from './smokeFixture';

const path: typeof import('path') = require('path');

type Win = Smoke['win'];
// Page-level globals (dashboards.ts, dashSelection.ts, savedViews.ts), read by bare name inside evaluate.
declare let dashCurrent: any;
declare let dashSaveTimer: number | null;
declare let dashPageIdx: number;
declare let controlState: Map<string, any>;
declare let dashSel: any[];

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(200);
  }
  return false;
}

const click = (win: Win, sel: string): Promise<boolean> =>
  win.evaluate((q: string) => {
    const el = document.querySelector(q) as HTMLElement | null;
    if (!el || el.getClientRects().length === 0 || (el as HTMLButtonElement).disabled) return false;
    el.click();
    return true;
  }, sel);

/** One action button on a view's row in the open Views menu. */
async function rowAct(win: Win, viewId: string, label: string): Promise<boolean> {
  if (!(await click(win, '#dash-views-btn'))) return false;
  await win.waitForTimeout(250);
  return win.evaluate((a: { id: string; label: string }) => {
    const b = document.querySelector(`.sv-menu .sv-row[data-view-id="${a.id}"] .sv-act[aria-label="${a.label}"]`) as HTMLElement | null;
    if (!b) return false;
    b.click();
    return true;
  }, { id: viewId, label });
}

/** The reader state a view should restore, as the renderer holds it. */
const live = (win: Win, regionId: string): Promise<{ region: string; sel: string; page: number; label: string }> =>
  win.evaluate((rid: string) => ({
    region: controlState.has(rid) ? String(controlState.get(rid).value) : '',
    sel: dashSel.map((s: any) => s.column + '=' + s.value).join(','),
    page: dashPageIdx,
    label: (document.getElementById('dash-views-name')?.textContent || '').trim(),
  }), regionId);

/** Back to the authored state: no control pick, no selection, page 1. */
const clearLive = (win: Win): Promise<void> => win.evaluate(() => {
  (window as any).resetAllControls();
  dashSel = [];
  dashPageIdx = 0;
  (window as any).renderDashSelStrip();
  (window as any).renderDashPages();
  (window as any).renderDashGrid();
});

export async function viewsSection(s: Smoke, _fx: Fixture): Promise<void> {
  const { app, win } = s;
  const errors0 = s.errors.length;
  const dom = domDriver(win);
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(400);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };
  const ids: { projectId: string; datasetId: string; analysisId: string } | null = await app.evaluate(() => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('./src/app/config.js').get().sample || null;
  });
  ok('views: the bundled sample is there', !!ids && !!ids.projectId && !!ids.analysisId);
  if (!ids) return;
  const pid = ids.projectId;
  const aid = ids.analysisId;
  const stored = (): Promise<any> => app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const rec = await req('./src/analysis/analysis.js').getAnalysis(a.pid, a.aid);
    return { views: rec.views, defaultViewId: rec.defaultViewId, pages: rec.sheets.map((p: any) => p.id) };
  }, { pid, aid });
  const openSample = async (): Promise<boolean> => {
    await win.evaluate(async (id: string) => {
      (window as any).selectSection('analyses');
      await (window as any).openAnalysis(id);
    }, aid);
    return until(win, () => win.evaluate((id: string) => !!dashCurrent && dashCurrent.id === id, aid));
  };

  await openProject(win, pid);
  ok('views: the sample dashboard opens', await openSample());
  const original = await win.evaluate(() => JSON.parse(JSON.stringify({ filters: dashCurrent.filters, pages: dashCurrent.pages })));
  let importedPid = '';

  try {
    // ── A Region control and a second page to have state worth saving ──
    const setup = await win.evaluate(async (dsId: string) => {
      const uuid = (window as any).dashUuid;
      const regionId = uuid();
      const y = Math.max(0, ...dashCurrent.pages[0].cards.map((c: any) => c.layout.y + c.layout.h));
      dashCurrent.pages[0].cards.push({ id: regionId, type: 'control', layout: { x: 0, y, w: 3, h: 1 }, control: { kind: 'dropdown', label: 'Region', datasetId: dsId, column: 'region' } });
      dashCurrent.pages.push({ id: uuid(), name: 'Detail', cards: [] });
      await (window as any).persistAnalysis();
      (window as any).renderDashPages();
      (window as any).renderDashGrid();
      return { regionId, page2: dashCurrent.pages[1].id, name: String(dashCurrent.name) };
    }, ids.datasetId);
    const regionId = setup.regionId;
    ok('views: a Region control and a Detail page were added', !!regionId && !!setup.page2);

    // ── Empty state ──
    ok('views: the header has a Views button', await click(win, '#dash-views-btn'));
    const empty = await win.evaluate(() => (document.querySelector('.sv-menu .sv-empty')?.textContent || '').trim());
    ok('views: the empty menu says what a view is', /No saved views yet — save the current filters, page and selection as a view/.test(empty), empty);
    await shot('views-empty.png');

    // ── Save the reader's state as a view ──
    await win.evaluate((rid: string) => {
      controlState.set(rid, { value: 'West' });
      dashSel = [{ type: 'filter', column: 'category', op: '=', value: 'Technology' }];
      dashPageIdx = 1;
      (window as any).renderDashSelStrip();
      (window as any).renderDashPages();
      (window as any).renderDashGrid();
    }, regionId);
    ok('views: Save current view… is in the menu', await click(win, '#sv-save-btn'));
    await win.waitForTimeout(300);
    ok('views: name it', await dom.fillPrompt('West Q4'));
    ok('views: the view is saved', await until(win, () => win.evaluate(() => (dashCurrent.views || []).length === 1)));
    let disk = await stored();
    const vid: string = disk.views[0] && disk.views[0].id;
    const st = disk.views[0] && disk.views[0].state;
    ok('views: main stored the Region pick, the selection and the page',
      !!st && st.controls[regionId] && st.controls[regionId].value === 'West' && st.selection.length === 1
      && st.selection[0].value === 'Technology' && st.page === setup.page2, JSON.stringify(st));
    ok('views: the header names the view on screen', (await live(win, regionId)).label === 'West Q4');

    // ── Rename, set as default ──
    ok('views: Rename from the row', await rowAct(win, vid, 'Rename'));
    await win.waitForTimeout(300);
    ok('views: the new name', await dom.fillPrompt('West — Q4'));
    ok('views: renamed on disk', await until(win, async () => (await stored()).views[0].name === 'West — Q4'));
    ok('views: set as the default from the row', await rowAct(win, vid, 'Open the dashboard on this view'));
    ok('views: it is the default on disk', await until(win, async () => (await stored()).defaultViewId === vid));
    await click(win, '#dash-views-btn');
    await win.waitForTimeout(300);
    const menu = await win.evaluate(() => ({
      rows: [...document.querySelectorAll('.sv-menu .sv-row .sv-name')].map((e) => e.textContent),
      badge: (document.querySelector('.sv-menu .sv-row .sv-badge')?.textContent || '').trim(),
    }));
    ok('views: the menu lists it, marked Default', menu.rows.length === 1 && menu.rows[0] === 'West — Q4' && menu.badge === 'Default', JSON.stringify(menu));
    await shot('views-menu.png');
    await win.keyboard.press('Escape');

    // ── Reopening lands on the default ──
    await clearLive(win);
    ok('views: cleared back to the authored state', (await live(win, regionId)).region === '');
    await win.evaluate(() => (window as any).closeDashboardEditor());
    ok('views: reopened', await openSample());
    await win.waitForTimeout(500);
    let now = await live(win, regionId);
    ok('views: it opens on the default view — Region West, the selection, page 2',
      now.region === 'West' && now.sel === 'category=Technology' && now.page === 1 && now.label === 'West — Q4', JSON.stringify(now));
    ok('views: the cards read the view\'s filters', await win.evaluate(() =>
      (window as any).effectiveFilters().some((f: any) => f.column === 'region' && f.value === 'West')));

    // ── ⌘K: "Dashboard › View" ──
    await clearLive(win);
    await win.evaluate(() => (window as any).paletteOpen('West — Q4'));
    const title = setup.name + ' › West — Q4';
    ok('views: ⌘K lists "' + title + '"', await until(win, () => win.evaluate((t: string) =>
      [...document.querySelectorAll('.cp-row .cp-row-title')].some((e) => e.textContent === t), title)));
    await shot('views-palette.png');
    await win.locator('.cp-row', { hasText: title }).first().click(); // rows act on mousedown, so a real click
    ok('views: the ⌘K row opens the dashboard on the view', await until(win, async () => {
      const n = await live(win, regionId);
      return n.region === 'West' && n.page === 1;
    }));
    await win.evaluate(() => { if ((window as any).paletteIsOpen()) (window as any).paletteClose(); });

    // ── Deep links ──
    const link = `ordinate://dashboard/${aid}?view=${vid}&from=mail`;
    const parsed = await win.evaluate((u: string) => (window as any).hubViews.parseLink(u), link);
    ok('views: main parses the link, ignoring the unknown parameter', JSON.stringify(parsed) === JSON.stringify({ dashboardId: aid, viewId: vid }), JSON.stringify(parsed));
    ok('views: main refuses a malformed link', await win.evaluate((u: string) => (window as any).hubViews.parseLink(u), `ordinate://dashboard/${aid}/../x?view=west`) === null);
    await clearLive(win);
    await win.evaluate(() => { (window as any).closeDashboardEditor(); (window as any).selectSection('home'); });
    await win.waitForTimeout(500);
    ok('views: acting on the link is accepted', await win.evaluate((u: string) => (window as any).hubViews.openLink(u), link));
    ok('views: the link opens the app on the dashboard, on the view', await until(win, async () => {
      const open = await win.evaluate((id: string) => !!dashCurrent && dashCurrent.id === id, aid);
      if (!open) return false;
      const n = await live(win, regionId);
      return n.region === 'West' && n.page === 1 && n.label === 'West — Q4';
    }));

    // ── Bundles ──
    const bundled = await app.evaluate(async (_e, a: any) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const bundle = req('./src/app/bundle.js');
      const out = await bundle.exportProject(a.pid);
      const entry = bundle.readZip(out.bytes).find((e: any) => e.name === `analyses/${a.aid}.json`);
      const rec = entry ? JSON.parse(entry.data.toString('utf8')) : null;
      const imp = await bundle.importBundle(out.bytes, { name: 'Views smoke import' });
      let back: any = null;
      if (imp.ok) {
        const an = req('./src/analysis/analysis.js');
        for (const s of await an.listAnalyses(imp.project.id)) {
          const r = await an.getAnalysis(imp.project.id, s.id);
          if (r && r.views && r.views.length) back = { views: r.views.map((v: any) => v.name), def: r.defaultViewId, ids: r.views.map((v: any) => v.id), cards: r.sheets[0].cards.map((c: any) => c.id), controls: Object.keys(r.views[0].state.controls) };
        }
      }
      return { views: rec ? rec.views.map((v: any) => v.name) : [], def: rec ? rec.defaultViewId : '', pid: imp.ok ? imp.project.id : '', back };
    }, { pid, aid });
    importedPid = bundled.pid;
    ok('views: the exported bundle carries the views and the default', JSON.stringify(bundled.views) === JSON.stringify(['West — Q4']) && bundled.def === vid, JSON.stringify(bundled));
    ok('views: an import brings them back, the default and the control pick still pointing inside the copy',
      !!bundled.back && JSON.stringify(bundled.back.views) === JSON.stringify(['West — Q4']) && bundled.back.ids.includes(bundled.back.def)
      && bundled.back.controls.every((c: string) => bundled.back.cards.includes(c)), JSON.stringify(bundled.back));

    // ── Publish: the page's views dropdown ──
    const pub = await app.evaluate(async (_e, a: any) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const d = await req('./src/publish/dashboardData.js').buildDashboard(a.pid, a.aid, 64, {}, undefined, {});
      const page: any = req('./src/publish/sanitize.js').sanitizePage({ site: {}, kind: 'dashboard', dashboard: d });
      const ctl = d.controls.findIndex((c: any) => c.label === 'Region');
      return { views: page.dashboard.views, west: ctl >= 0 ? d.controls[ctl].options.indexOf('West') : -2, ctl };
    }, { pid, aid });
    const pv = pub.views && pub.views[0];
    ok('views: the published page offers the view, on page 2 with Region = West, as the default',
      pub.views.length === 1 && pv.name === 'West — Q4' && pv.sheet === 1 && pv.picks[pub.ctl] === pub.west && pv.default === true, JSON.stringify(pub));

    // ── Reports: a view's scope ──
    const scope = await win.evaluate((a: any) => (window as any).hubViews.scope(a.pid, a.aid, a.vid), { pid, aid, vid });
    ok('views: a report on the view prints under its filters', !!scope && scope.ok
      && scope.filters.some((f: any) => f.column === 'region' && f.value === 'West')
      && scope.filters.some((f: any) => f.column === 'category' && f.value === 'Technology'), JSON.stringify(scope));
    const opts = await win.evaluate(() => {
      const sel = document.createElement('select');
      (window as any).svFillReportViews(sel, dashCurrent, '');
      return [...sel.options].map((o) => o.textContent);
    });
    ok('views: the report builder offers the view', JSON.stringify(opts) === JSON.stringify(['As saved — no view', 'West — Q4']), JSON.stringify(opts));

    // ── Update and delete from the menu ──
    await win.evaluate(() => { dashSel = []; (window as any).renderDashSelStrip(); (window as any).renderDashGrid(); });
    ok('views: Update from the row', await rowAct(win, vid, 'Update with what is on screen'));
    ok('views: the view now has no selection', await until(win, async () => (await stored()).views[0].state.selection.length === 0));
    ok('views: Delete from the row', await rowAct(win, vid, 'Delete'));
    disk = await stored();
    ok('views: deleted, and the default with it', await until(win, async () => {
      disk = await stored();
      return disk.views.length === 0 && disk.defaultViewId === '';
    }));
  } finally {
    // ── Leave the sample exactly as found ──
    await win.evaluate(() => { if ((window as any).paletteIsOpen()) (window as any).paletteClose(); });
    await win.keyboard.press('Escape').catch(() => undefined);
    await app.evaluate(async (_e, a: any) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      await req('./src/analysis/analysis.js').updateAnalysis(a.pid, a.aid, { views: [], defaultViewId: '' });
      if (a.imported) await req('./src/app/projects.js').deleteProject(a.imported);
    }, { pid, aid, imported: importedPid });
    const reopened = await openSample();
    if (reopened) {
      await win.evaluate(async (orig: any) => {
        if (dashSaveTimer) clearTimeout(dashSaveTimer);
        dashSaveTimer = null;
        dashCurrent.filters = orig.filters;
        dashCurrent.pages = orig.pages;
        dashCurrent.sheets = dashCurrent.pages;
        dashCurrent.views = [];
        dashCurrent.defaultViewId = '';
        await (window as any).persistAnalysis();
      }, original);
      await win.evaluate(() => (window as any).closeDashboardEditor());
      await openSample();
    }
  }
  const after = await app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const rec = await req('./src/analysis/analysis.js').getAnalysis(a.pid, a.aid);
    const gone = a.imported ? !(await req('./src/app/projects.js').getProject(a.imported)) : true;
    return { pages: rec.sheets.length, views: (rec.views || []).length, def: rec.defaultViewId, gone,
      controls: rec.sheets.flatMap((p: any) => p.cards).filter((c: any) => c.type === 'control').length };
  }, { pid, aid, imported: importedPid });
  ok('views: the sample is restored — its pages, no added control, no views',
    after.pages === original.pages.length && after.views === 0 && after.def === ''
    && after.controls === original.pages.flatMap((p: any) => p.cards).filter((c: any) => c.type === 'control').length, JSON.stringify(after));
  ok('views: the imported copy is deleted', after.gone);
  ok('views: no renderer errors in this section', s.errors.length === errors0, s.errors.slice(errors0).join('\n'));
}
