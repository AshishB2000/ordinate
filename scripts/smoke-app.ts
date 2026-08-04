// End-to-end smoke test of the REAL app — launches Electron and drives it.
//
// This is the only check in the repo that runs the ACTUAL application. Every
// other self-check exercises a module in isolation, which is why a CSP
// violation that made two hub banners paint visible on every load survived
// 2,400 passing assertions: no test rendered the page.
//
// Not part of `npm test` — it boots Electron (~5s) and needs a display. Run it
// with `npm run smoke`; CI runs it as its own job under xvfb.
//
// Uses a throwaway userData dir, so a developer's real projects are untouched.

export {}; // module scope — sibling scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

// playwright is a devDependency; its Electron driver talks to the app over the
// DevTools protocol, so it needs no screen-capture or accessibility permission.
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-smoke-'));
const shotDir = process.env.SMOKE_ARTIFACT_DIR || userData;

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
    args: [
      '.',
      '--password-store=basic',
      '--user-data-dir=' + userData,
      // MapLibre needs a real WebGL context. Under xvfb there is no GPU, and
      // modern Chromium refuses to fall back to its software rasteriser for
      // WebGL unless explicitly told it may — so without this the map renders
      // the app's honest "This map needs WebGL" fallback and the map assertions
      // below fail on CI while passing on any developer machine.
      //
      // SwiftShader is slower but it is a REAL GL implementation: the same
      // MapLibre code path, the same shaders, the same tile requests. The
      // alternative — letting the assertions accept the fallback when GL is
      // missing — would mean CI silently stops testing maps, which is the gap
      // this coverage was added to close.
      '--enable-unsafe-swiftshader',
    ],
    cwd: REPO,
    timeout: 120_000,
  });

  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');

  // A chart that throws still leaves a plausible-looking blank canvas, and a
  // blocked inline style is only ever visible here.
  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });

  ok('window opened', true, `title="${await win.title()}"`);

  // Drive the workspace through the same modules main.js registered its IPC
  // handlers against — `process.mainModule.require` returns those instances,
  // not fresh copies, so this is the shipped code path.
  const r: any = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/projects.js');
    const datasets = req('./src/datasets.js');
    const visuals = req('./src/visuals.js');
    const vizData = req('./src/vizData.js');
    const metricValue = req('./src/metricValue.js');
    const out: any = {};

    await projects.init();
    const proj = await projects.createProject('Smoke test');
    out.projectId = proj && proj.id;

    // The correctness-sensitive shapes: leading zeros, '', negatives.
    const rows: any[][] = [];
    for (let i = 0; i < 1_000_000; i++) {
      rows.push([
        'region' + (i % 7),
        String(i % 500).padStart(3, '0'),
        (i % 97) - 10,
        i % 3 === 0 ? '' : 'n' + i,
      ]);
    }
    const ds = await datasets.saveDataset(proj.id, {
      name: 'Sales',
      sourceKind: 'csv',
      columns: [
        { name: 'region', type: 'text' },
        { name: 'sku', type: 'text' },
        { name: 'amount', type: 'number' },
        { name: 'note', type: 'text' },
      ],
      rows,
    });
    out.rowCount = ds && ds.rowCount;

    const meta = await datasets.getDatasetMeta(proj.id, ds.id);
    out.resident = meta && meta.resident;

    // Chart and metric go through the RESIDENT paths — what visual:data and
    // dashboard:metric actually use since Phase 2.5. At a million rows the old
    // hydrate-then-fold would dominate this test's runtime while exercising a
    // path the app no longer takes.
    const residentQuery = req('./src/residentQuery.js');
    const datasetPage = req('./src/datasetPage.js');
    const src = await datasets.residentSource(proj.id, ds.id);
    out.hasResidentSource = !!src;

    let t = Date.now();
    const agg = src && residentQuery.aggregateResident(src, 'region', [
      { column: 'amount', aggregation: 'sum' },
    ]);
    out.aggMs = Date.now() - t;
    out.labels = agg && agg.labels;
    out.seriesName = agg && agg.series[0] && agg.series[0].name;
    out.values = agg && agg.series[0] && agg.series[0].values;

    t = Date.now();
    out.metric = src && residentQuery.computeMetricResident(src, {
      column: 'amount',
      aggregation: 'sum',
    });
    out.metricMs = Date.now() - t;

    // One page of the Explore grid — the path that replaced holding the table.
    t = Date.now();
    const page = src && datasetPage.readPage(src, { offset: 0, limit: 500 });
    out.pageMs = Date.now() - t;
    out.pageRows = page && page.rows.length;
    out.pageTotal = page && page.total;
    out.skuSample = page ? page.rows.slice(0, 3).map((x: any[]) => x[1]) : [];
    out.skuTypes = page ? page.rows.slice(0, 3).map((x: any[]) => typeof x[1]) : [];

    const v = await visuals.saveVisual(proj.id, {
      datasetId: ds.id,
      name: 'Sales by region',
      chartType: 'column',
      encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] },
    });
    out.visualId = v && v.id;

    // A second, tiny dataset for the MAP path (Phase 4). Deliberately its own
    // dataset: the geo join matches on region NAME, and 'region0'..'region6'
    // above match nothing. Eight real states, so the choropleth has both a
    // colour ramp and a min/max to label.
    const states = ['California', 'Texas', 'Florida', 'New York',
                    'Illinois', 'Ohio', 'Georgia', 'Washington'];
    const geoDs = await datasets.saveDataset(proj.id, {
      name: 'By state',
      sourceKind: 'csv',
      columns: [{ name: 'state', type: 'text' }, { name: 'revenue', type: 'number' }],
      rows: states.map((s, i) => [s, (i + 1) * 1000]),
    });
    const mv = await visuals.saveVisual(proj.id, {
      datasetId: geoDs.id,
      name: 'Revenue by state',
      chartType: 'map_choropleth',
      encoding: {
        category: 'state',
        values: [{ column: 'revenue', aggregation: 'sum' }],
        geo: { level: 'us_state' },
      },
    });
    out.mapVisualId = mv && mv.id;
    return out;
  });

  ok('project created', !!r.projectId);
  ok('1,000,000-row dataset saved — the full cap, 20x the old one', r.rowCount === 1_000_000, `rowCount=${r.rowCount}`);
  ok('dataset is Parquet-backed', r.resident === true);
  ok('chart data computed', Array.isArray(r.labels) && r.labels.length === 7,
     `labels=${JSON.stringify(r.labels)}`);
  ok('series named by measureLabel', r.seriesName === 'sum of amount', `"${r.seriesName}"`);
  ok('chart values are JS numbers', r.values.every((v: unknown) => typeof v === 'number'),
     `first=${r.values[0]}, agg took ${r.aggMs} ms`);
  ok('metric card computed', typeof r.metric === 'number', `sum=${r.metric} in ${r.metricMs} ms`);
  ok('dataset exposes a resident source', r.hasResidentSource === true);
  ok('one Explore page read', r.pageRows === 500 && r.pageTotal === 1_000_000,
     `${r.pageRows} rows of ${r.pageTotal} in ${r.pageMs} ms`);
  // These are the numbers the whole migration exists to produce. Loose bounds —
  // a CI runner is slower than a dev machine — but a regression to seconds fails.
  ok('aggregate over 1M rows is fast', r.aggMs < 2000, `${r.aggMs} ms`);
  ok('page read over 1M rows is fast', r.pageMs < 2000, `${r.pageMs} ms`);
  ok('leading zeros stayed text',
     r.skuTypes.every((t: string) => t === 'string') && r.skuSample[0] === '000',
     JSON.stringify(r.skuSample));
  ok('visual saved', !!r.visualId);

  // The first paint is a SPLASH. Screenshotting here yields a loading screen
  // that passes every size and DOM check while proving nothing — this cost a
  // false pass once already, so wait it out rather than trusting byte count.
  await win.waitForTimeout(3000);
  await win
    .evaluate(() => {
      const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
      if (s) s.remove();
    })
    .catch(() => {});

  // Reload so the renderer picks up the project written above, then open it.
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForTimeout(3000);
  await win
    .evaluate(() => {
      const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
      if (s) s.remove();
    })
    .catch(() => {});

  const opened: string | null = await win.evaluate(() => {
    const el = [...document.querySelectorAll('button, a, [role=button], [class*=card], li')].find(
      (b) => /smoke test/i.test(b.textContent || ''),
    ) as HTMLElement | undefined;
    if (el) {
      el.click();
      return (el.textContent || '').trim().slice(0, 40);
    }
    return null;
  });
  ok('project opens from the UI list', opened !== null, opened || 'not found in the rendered list');
  await win.waitForTimeout(1500);

  await win.evaluate(() => {
    const el = [...document.querySelectorAll('button, a, [role=button], li')].find((b) =>
      /^\s*Datasets\s*$/.test(b.textContent || ''),
    ) as HTMLElement | undefined;
    if (el) el.click();
  });
  await win.waitForTimeout(2000);

  // The dataset must be VISIBLE in the UI, with its real row count — this is
  // what proves the Parquet store reaches the screen, not just the API.
  const listed: string | null = await win.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && /1000000 rows/.test(e.textContent || ''),
    );
    return el ? (el.textContent || '').trim().slice(0, 60) : null;
  });
  ok('dataset is listed in the UI with its row count', listed !== null, listed || 'not rendered');

  // ── Phase D: the analysis authoring surface, driven as a user ─────────────
  // Everything below clicks real buttons and fills real modals. It is here and
  // not in a node self-check for the reason this whole file exists: a panel that
  // renders at zero height, or a control hidden by a CSP-blocked style, passes
  // every DOM assertion made outside a running window.
  //
  // Playwright dismisses dialogs by default, which would silently answer "no" to
  // a window.confirm(). Accept them, and keep the text so an UNEXPECTED alert
  // (the failure path of every handler in analyses.ts) is visible rather than
  // swallowed.
  const dialogs: string[] = [];
  win.on('dialog', (d) => {
    dialogs.push(d.type() + ': ' + d.message());
    d.accept().catch(() => {});
  });

  // A tiny DOM driver, defined once and re-used: click by visible text, click by
  // id, fill the prompt modal, pick from the chooser modal.
  const clickExact = async (text: string): Promise<boolean> =>
    win.evaluate((t) => {
      const el = [...document.querySelectorAll('button, a, [role=button], li')].find(
        (b) => (b as HTMLElement).offsetParent !== null && (b.textContent || '').trim() === t,
      ) as HTMLElement | undefined;
      if (!el) return false;
      el.click();
      return true;
    }, text);
  const clickId = async (id: string): Promise<boolean> =>
    win.evaluate((i) => {
      const el = document.getElementById(i) as HTMLElement | null;
      if (!el || el.hidden) return false;
      el.click();
      return true;
    }, id);
  const fillPrompt = async (value: string): Promise<boolean> =>
    win.evaluate((v) => {
      const box = document.querySelector('.ws-modal-overlay .ws-modal');
      if (!box) return false;
      const input = box.querySelector('.ws-modal-input') as HTMLInputElement | null;
      if (input) input.value = v;
      const okBtn = box.querySelector('.ws-modal-actions .btn-primary') as HTMLElement | null;
      if (!okBtn) return false;
      okBtn.click();
      return true;
    }, value);
  const pickFirstOption = async (): Promise<boolean> =>
    win.evaluate(() => {
      const box = document.querySelector('.ws-modal-overlay .ws-modal');
      if (!box) return false;
      const sel = box.querySelector('select.ws-modal-input') as HTMLSelectElement | null;
      if (!sel || sel.options.length === 0) return false;
      sel.selectedIndex = 0;
      const okBtn = box.querySelector('.ws-modal-actions .btn-primary') as HTMLElement | null;
      if (!okBtn) return false;
      okBtn.click();
      return true;
    });

  ok('the Analyses section is in the workspace nav', await clickExact('Analyses'));
  await win.waitForTimeout(800);

  ok('New analysis opens the name prompt', await clickId('an-new-btn'));
  await win.waitForTimeout(400);
  ok('the name prompt accepts a name', await fillPrompt('Smoke analysis'));
  await win.waitForTimeout(1500);

  // The editor must be INSIDE the Analyses panel, in analysis mode, and — the
  // check a DOM assertion cannot make — actually have a box on screen.
  const anEditor = await win.evaluate(() => {
    const ed = document.getElementById('dash-editor');
    if (!ed) return null;
    const r = ed.getBoundingClientRect();
    return {
      inAnalysesPanel: !!ed.closest('#ws-analyses'),
      analysisMode: ed.classList.contains('dash-editor--analysis'),
      w: Math.round(r.width),
      h: Math.round(r.height),
      pubstate: (document.getElementById('an-pubstate')?.textContent || '').trim().slice(0, 60),
      publishVisible: (document.getElementById('an-publish-btn') as HTMLElement | null)?.offsetParent != null,
      addVisualVisible: (document.getElementById('dash-add-visual') as HTMLElement | null)?.offsetParent != null,
      summaryVisible: (document.getElementById('dash-summary-btn') as HTMLElement | null)?.offsetParent != null,
      sheetTabs: document.querySelectorAll('#dash-pages .dash-page-tab').length,
      // `hidden` on a .btn was a no-op until hub.css got `.btn[hidden]` — the
      // rule that hid these three lost to `display: inline-flex`. Nothing but a
      // rendered window can tell the difference, which is why they are asserted
      // by VISIBILITY (offsetParent) and not by the attribute.
      republishVisible: (document.getElementById('an-republish-btn') as HTMLElement | null)?.offsetParent != null,
      legacyWrapVisible: (document.getElementById('dash-legacy-wrap-btn') as HTMLElement | null)?.offsetParent != null,
      clearFiltersVisible: (document.getElementById('dash-clear-filters') as HTMLElement | null)?.offsetParent != null,
      aiPanelVisible: (document.getElementById('dash-ai-out') as HTMLElement | null)?.offsetParent != null,
    };
  });
  ok('the analysis editor opened inside the Analyses panel',
     !!anEditor && anEditor.inAnalysesPanel && anEditor.analysisMode,
     JSON.stringify(anEditor));
  ok('the analysis editor has a real box (not zero-height)',
     !!anEditor && anEditor.w > 200 && anEditor.h > 200, `${anEditor?.w}x${anEditor?.h}`);
  ok('an unpublished analysis says so', !!anEditor && /Not published yet/.test(anEditor.pubstate),
     anEditor?.pubstate || '');
  ok('Publish and the card controls are offered on an analysis',
     !!anEditor && anEditor.publishVisible && anEditor.addVisualVisible);
  ok('the dashboard-only AI actions are hidden on an analysis',
     !!anEditor && anEditor.summaryVisible === false);
  ok('the analysis opens with one sheet', anEditor?.sheetTabs === 1, String(anEditor?.sheetTabs));
  ok('nothing that should be hidden is painted (Republish / Edit-as-analysis / Clear all / AI panel)',
     !!anEditor && !anEditor.republishVisible && !anEditor.legacyWrapVisible &&
     !anEditor.clearFiltersVisible && !anEditor.aiPanelVisible,
     JSON.stringify({
       republish: anEditor?.republishVisible, legacyWrap: anEditor?.legacyWrapVisible,
       clearFilters: anEditor?.clearFiltersVisible, aiPanel: anEditor?.aiPanelVisible,
     }));

  // Add the saved visual as a card, through the picker.
  ok('+ Visual opens the picker', await clickId('dash-add-visual'));
  await win.waitForTimeout(500);
  ok('the picker adds the saved visual', await pickFirstOption());
  await win.waitForTimeout(3000); // render + the 600 ms debounced autosave

  const cardCount = await win.evaluate(() => document.querySelectorAll('#dash-grid .dash-card').length);
  ok('the card lands on the sheet grid', cardCount === 1, String(cardCount));

  const anShot = path.join(shotDir, 'analysis-editor.png');
  await win.screenshot({ path: anShot });
  ok('analysis editor screenshot captured', fs.existsSync(anShot) && fs.statSync(anShot).size > 5000,
     `${Math.round(fs.statSync(anShot).size / 1024)} KB -> ${anShot}`);

  // PUBLISH.
  ok('Publish is clickable', await clickId('an-publish-btn'));
  await win.waitForTimeout(3000);
  const afterPublish = await win.evaluate(() => ({
    pubstate: (document.getElementById('an-pubstate')?.textContent || '').trim(),
    republishVisible: (document.getElementById('an-republish-btn') as HTMLElement | null)?.offsetParent != null,
  }));
  ok('the analysis reports it published, and to which dashboard',
     /Published/.test(afterPublish.pubstate) && /Smoke analysis/.test(afterPublish.pubstate),
     afterPublish.pubstate.slice(0, 120));
  ok('Republish appears once there is something to republish over', afterPublish.republishVisible);

  // The published dashboard, in the Dashboards surface.
  ok('the Dashboards section is reachable', await clickExact('Dashboards'));
  await win.waitForTimeout(1500);
  const dashRow = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#dash-list .dash-list-item')];
    const row = rows.find((r) => /Smoke analysis/.test(r.textContent || ''));
    return row
      ? {
          text: (row.textContent || '').trim().slice(0, 90),
          badge: !!row.querySelector('.dash-list-badge'),
          renameOffered: !!row.querySelector('[aria-label="Rename dashboard"]'),
        }
      : null;
  });
  ok('the published dashboard is listed', !!dashRow, dashRow ? dashRow.text : 'not found');
  ok('and it is marked read-only in the list', !!dashRow && dashRow.badge, dashRow ? dashRow.text : '');
  ok('and its list Rename is withdrawn (main would refuse the write)',
     !!dashRow && dashRow.renameOffered === false);

  ok('the published dashboard opens', await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#dash-list .dash-list-item')];
    const row = rows.find((r) => /Smoke analysis/.test(r.textContent || ''));
    const open = row?.querySelector('.dash-list-open') as HTMLElement | undefined;
    if (!open) return false;
    open.click();
    return true;
  }));
  await win.waitForTimeout(3000);
  const published = await win.evaluate(() => {
    const ed = document.getElementById('dash-editor');
    const note = document.getElementById('dash-readonly') as HTMLElement | null;
    return {
      inDashPanel: !!ed?.closest('#ws-dashboards'),
      readOnly: !!ed?.classList.contains('dash-editor--readonly'),
      noteVisible: !!note && note.offsetParent !== null,
      noteText: (note?.textContent || '').trim().slice(0, 140),
      routeBack: (document.getElementById('dash-open-analysis') as HTMLElement | null)?.offsetParent != null,
      addVisual: (document.getElementById('dash-add-visual') as HTMLElement | null)?.offsetParent != null,
      save: (document.getElementById('dash-save-btn') as HTMLElement | null)?.offsetParent != null,
      cardCtrls: [...document.querySelectorAll('#dash-grid .dash-card-ctrls')]
        .filter((c) => (c as HTMLElement).offsetParent !== null).length,
      cards: document.querySelectorAll('#dash-grid .dash-card').length,
      pages: document.querySelectorAll('#dash-pages .dash-page-tab').length,
    };
  });
  ok('the published dashboard renders in the Dashboards panel',
     published.inDashPanel && published.cards === 1, JSON.stringify(published));
  ok('it presents itself as read-only, and says why', published.readOnly && published.noteVisible,
     published.noteText);
  ok('with a route back to its analysis', published.routeBack);
  ok('every edit affordance is withdrawn (add / save / card controls)',
     !published.addVisual && !published.save && published.cardCtrls === 0,
     JSON.stringify({ addVisual: published.addVisual, save: published.save, ctrls: published.cardCtrls }));

  const pubShot = path.join(shotDir, 'published-dashboard.png');
  await win.screenshot({ path: pubShot });
  ok('published dashboard screenshot captured', fs.existsSync(pubShot) && fs.statSync(pubShot).size > 5000,
     `${Math.round(fs.statSync(pubShot).size / 1024)} KB -> ${pubShot}`);

  // THE SNAPSHOT GUARANTEE, from the UI: edit the analysis, and the published
  // dashboard must not move until it is published again.
  // Take the route back the read-only banner offers, rather than navigating —
  // that button is `analysis:forDashboard`, and on a PUBLISHED dashboard it must
  // resolve the existing analysis rather than wrap a second one.
  ok('the banner routes back to the analysis', await clickId('dash-open-analysis'));
  await win.waitForTimeout(2500);
  const routed = await win.evaluate(() => {
    const ed = document.getElementById('dash-editor');
    return {
      inAnalysesPanel: !!ed?.closest('#ws-analyses'),
      analysisMode: !!ed?.classList.contains('dash-editor--analysis'),
      navActive: (document.querySelector('.ws-nav-item.active') as HTMLElement | null)?.textContent?.trim(),
      name: (document.getElementById('dash-name')?.textContent || '').trim(),
      analyses: document.querySelectorAll('#an-list .dash-list-item').length,
    };
  });
  ok('…landing in the Analyses section with that analysis open',
     routed.inAnalysesPanel && routed.analysisMode && routed.navActive === 'Analyses' &&
     routed.name === 'Smoke analysis',
     JSON.stringify(routed));
  ok('and it did NOT wrap a second analysis', routed.analyses === 1, String(routed.analyses));
  ok('a sheet can be added to the analysis', await win.evaluate(() => {
    const add = document.querySelector('#dash-pages .dash-page-add') as HTMLElement | null;
    if (!add) return false;
    add.click();
    return true;
  }));
  await win.waitForTimeout(3000); // debounced save
  const twoSheets = await win.evaluate(() => ({
    tabs: document.querySelectorAll('#dash-pages .dash-page-tab').length,
    pubstate: (document.getElementById('an-pubstate')?.textContent || '').trim(),
  }));
  ok('the analysis now has two sheets', twoSheets.tabs === 2, String(twoSheets.tabs));
  ok('and it reports unpublished changes', /Unpublished changes/.test(twoSheets.pubstate),
     twoSheets.pubstate.slice(0, 120));

  ok('back to Dashboards', await clickExact('Dashboards'));
  await win.waitForTimeout(1200);
  await win.evaluate(() => {
    const open = [...document.querySelectorAll('#dash-list .dash-list-open')].find((b) =>
      /Smoke analysis/.test(b.textContent || ''),
    ) as HTMLElement | undefined;
    if (open) open.click();
  });
  await win.waitForTimeout(2500);
  const stillOne = await win.evaluate(() =>
    document.querySelectorAll('#dash-pages .dash-page-tab').length,
  );
  ok('the PUBLISHED dashboard did not move when the analysis was edited', stillOne === 1,
     `${stillOne} page tab(s)`);

  ok('no unexpected alert during the analysis flow', dialogs.length === 0, dialogs.join(' | '));

  // The analyses LIST, with the unpublished-changes badge on it.
  ok('back to Analyses', await clickExact('Analyses'));
  await win.waitForTimeout(1200);
  const anRow = await win.evaluate(() => {
    const row = [...document.querySelectorAll('#an-list .dash-list-item')].find((r) =>
      /Smoke analysis/.test(r.textContent || ''),
    );
    return row
      ? {
          text: (row.textContent || '').trim().slice(0, 100),
          badge: (row.querySelector('.dash-list-badge') as HTMLElement | null)?.textContent || '',
        }
      : null;
  });
  ok('the analysis is listed with its sheet count and publish state', !!anRow,
     anRow ? anRow.text : 'not found');
  ok('and the list flags unpublished changes', anRow?.badge === 'Unpublished changes',
     anRow?.badge || '(none)');
  const listShot = path.join(shotDir, 'analyses-list.png');
  await win.screenshot({ path: listShot });
  ok('analyses list screenshot captured', fs.existsSync(listShot) && fs.statSync(listShot).size > 5000,
     `${Math.round(fs.statSync(listShot).size / 1024)} KB -> ${listShot}`);

  // Leave the app on the Datasets section, where the rest of this file expects
  // to find it.
  await clickExact('Datasets');
  await win.waitForTimeout(800);

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
  await win
    .evaluate(() => {
      const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
      if (s) s.remove();
    })
    .catch(() => {});

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

  const clickText = (re: string) =>
    win.evaluate((src: string) => {
      const rx = new RegExp(src, 'i');
      const el = [...document.querySelectorAll('button, a, [role=button], [class*=card], li')].find(
        (b) => rx.test(b.textContent || ''),
      ) as HTMLElement | undefined;
      if (el) el.click();
      return !!el;
    }, re);

  await clickText('smoke test');
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
      () => !!document.querySelector('svg[class*="plot-"], canvas'),
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
      canvases: document.querySelectorAll('canvas').length,
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

  await app.close();
  fs.rmSync(userData, { recursive: true, force: true });

  console.log('');
  if (failures) {
    console.error(`${failures} smoke check(s) FAILED.`);
    process.exit(1);
  }
  console.log('All app smoke checks passed.');
}

main().catch((err) => {
  console.error('SMOKE DRIVER ERROR:', err && err.message ? err.message : err);
  process.exit(1);
});
