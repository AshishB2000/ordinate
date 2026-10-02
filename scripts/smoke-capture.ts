// A CAPTURE, end to end, in the real app — and the proof that it is no longer
// a second application bolted to the side of this one.
//
// The capture surface used to be its own shell: its own sidebar, its own
// search, its own settings gear, its own conversation thread and its own
// follow-up box, all living in a section the workspace nav could not reach. A
// capture is a project record now. So this file walks the whole path a user
// walks — Screenshot → the capture page → Save as dataset → the composer →
// Save → Ask — and asserts at every step that it happened INSIDE the
// workspace, with the one nav and the one top bar still on screen.
//
// TWO THINGS ARE STUBBED, both at their real boundary and nowhere else:
//
//   main.ingestCapture  ← the `hub:capture` listener is swapped for one that
//                         calls it with a fixture PNG. Grabbing pixels off a
//                         real screen is the one thing a test cannot do; every
//                         line after the image is the shipped path.
//   analyze.analyze     ← returns a fixed result carrying an extractedTable,
//                         the same seam smoke-assistant stubs. Nothing reaches
//                         the network: electron.net.request throws and is
//                         asserted at zero.
//
// Everything between them is real: the history record and its projectId, the
// crop on disk, captureDataset:draft, the composer, composeSave, the dataset
// record's origin, and the dock conversation main seeded with the analysis.
//
//   node scripts/smoke-capture.js

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { closeApp } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { _electron }: typeof import('playwright') = require('playwright');

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-capture-'));
const shotDir = process.env.SMOKE_ARTIFACT_DIR || userData;

/** A 2×2 PNG. The image only has to be a real image — nothing reads its pixels. */
const FIXTURE_PNG = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR42mNk'
  + 'YPhfz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC';

/**
 * What the stubbed model "reads" off that screenshot, in the OBJECT-KEYED shape
 * parseReply() actually produces (src/ai/analyze.ts): columns carry an id and a
 * label, and each row is keyed by column id. Getting this shape wrong is how a
 * test passes against an empty draft — `captureDataset.toBody` projects by id,
 * so an array-of-arrays fixture yields three blank rows under "col1"/"col2",
 * which every count assertion below would still be happy with. The cell-VALUE
 * assertions are what make that impossible.
 */
const EXTRACTED = {
  columns: [
    { id: 'region', label: 'Region', type: 'text' },
    { id: 'revenue', label: 'Revenue', type: 'number' },
  ],
  rows: [
    { region: 'North', revenue: '1200' },
    { region: 'South', revenue: '900' },
    { region: 'East', revenue: '1500' },
  ],
};

async function main(): Promise<void> {
  const app = await _electron.launch({
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData, '--enable-unsafe-swiftshader'],
    cwd: REPO,
    timeout: 120_000,
  });
  const win = await app.firstWindow({ timeout: 120_000 });
  await win.waitForLoadState('domcontentloaded');

  const errors: string[] = [];
  win.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  win.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // ── Readiness + the two stubs, installed in MAIN ──────────────────────────
  const ready = await app.evaluate(async (electron, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const config = req('./src/app/config.js');
    const execConfig = req('./src/app/execConfig.js');
    const analyze = req('./src/ai/analyze.js');
    const main = req('./src/main.js');
    const g = globalThis as any;
    g.__smoke = { net: 0, analyzed: 0 };

    // Nothing may reach the network. A counter AND a throw: a silent count
    // would let a real call succeed and only fail the assertion at the end.
    const realRequest = electron.net.request;
    electron.net.request = (...a: unknown[]) => {
      g.__smoke.net += 1;
      void realRequest; void a;
      throw new Error('smoke: a model call escaped the stubs and tried the network');
    };

    // The model boundary. `_messages` is what makes main persist the thread —
    // the same field a real provider reply carries.
    analyze.analyze = async () => {
      g.__smoke.analyzed += 1;
      return {
        ok: true,
        title: 'Revenue by region',
        analysis: 'North leads on revenue, with East close behind.',
        extractedTable: arg.extracted,
        data: { labels: [], series: [] },
        followups: [],
        _messages: [{ role: 'user', content: 'image' }],
      };
    };

    // The IMAGE boundary: the button and the hotkey both send `hub:capture`,
    // and main answers it by opening the screen-capture overlay. Swap that one
    // listener for the fixture; ingestCapture below it is shipped code.
    electron.ipcMain.removeAllListeners('hub:capture');
    electron.ipcMain.on('hub:capture', () => { main.ingestCapture(arg.png); });

    execConfig.setByokProvider('anthropic', { apiKey: 'sk-smoke-fake' });
    execConfig.setByokVerified('anthropic', true);
    config.save({ executionMode: 'byok', byok: { activeProvider: 'anthropic' } });
    return { ready: execConfig.executionReady() };
  }, { png: FIXTURE_PNG, extracted: EXTRACTED });
  ok('a fake BYOK key makes executionReady() true, with no network', ready.ready === true);

  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('#splash[hidden]', { timeout: 30_000 }).catch(() => {});
  await win.waitForTimeout(1500);

  // ── The old shell is GONE, not merely unwired ─────────────────────────────
  const shell = await win.evaluate(() => ({
    capturesColumn: document.querySelectorAll('.cap-history').length,
    captureSidebar: document.querySelectorAll('aside.sidebar').length,
    search: document.querySelectorAll('#cap-search').length,
    secondGear: document.querySelectorAll('#settings-gear-cap').length,
    followup: document.querySelectorAll('#cv-followup-input').length,
    oldView: document.querySelectorAll('#capture-view').length,
  }));
  ok('no captures column, no second sidebar, no capture search, no second gear',
    shell.capturesColumn === 0 && shell.captureSidebar === 0 && shell.search === 0 && shell.secondGear === 0,
    JSON.stringify(shell));
  ok('…and no per-capture follow-up box — a follow-up is a dock ask now',
    shell.followup === 0 && shell.oldView === 0, JSON.stringify(shell));

  // ── Screenshot in the sidebar takes a capture, in place ───────────────────
  await win.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.as-connect-item'))
      .find((e) => (e as HTMLElement).dataset.source === 'capture') as HTMLElement | undefined;
    if (b) b.click();
  });
  // The rail item resolves a project first (async), then main analyses. Wait
  // for the page's own state, not the clock.
  await win.waitForFunction(
    () => (document.querySelector('.hub-body') as HTMLElement)?.dataset.section === 'capture',
    null, { timeout: 30_000 },
  ).catch(() => {});
  await win.waitForFunction(
    () => !!document.querySelector('#cap-result .cap-extracted'),
    null, { timeout: 30_000 },
  ).catch(() => {});

  const page = await win.evaluate(() => {
    const vis = (el: Element | null) => !!(el && (el as HTMLElement).offsetParent !== null);
    return {
      section: (document.querySelector('.hub-body') as HTMLElement)?.dataset.section,
      navVisible: vis(document.getElementById('app-sidebar')),
      navItems: document.querySelectorAll('.as-nav-item').length,
      agentToggle: vis(document.getElementById('side-ai-btn')),
      title: (document.getElementById('cap-title') || { textContent: '' }).textContent,
      img: !!(document.getElementById('cap-view-img') as HTMLImageElement | null)?.src,
      capHistory: document.querySelectorAll('.cap-history').length,
      focusMode: document.body.classList.contains('cap-focus'),
      saveEnabled: !(document.getElementById('cap-act-dataset') as HTMLButtonElement)?.disabled,
      visualDisabled: !!(document.getElementById('cap-act-visual') as HTMLButtonElement)?.disabled,
    };
  });
  ok('clicking Screenshot opens the capture PAGE inside the workspace', page.section === 'capture',
    JSON.stringify(page));
  ok('…with the same sidebar nav still on screen', page.navVisible && page.navItems >= 4);
  ok('…and the same top bar (the Agent toggle is still there)', page.agentToggle);
  ok('…and no focus mode and no .cap-history anywhere', !page.focusMode && page.capHistory === 0);
  ok('…titled from the analysis, with the screenshot rendered',
    page.title === 'Revenue by region' && page.img, String(page.title));
  ok('"Save as dataset" is live because the capture carries a table', page.saveEnabled);

  // The page's subject: what the model read, next to the image it read it off.
  const extracted = await win.evaluate(() => {
    const box = document.querySelector('#cap-result .cap-extracted');
    return {
      present: !!box,
      headers: Array.from(box?.querySelectorAll('.ds-th') || []).map((h) => h.textContent).join('|'),
      rows: box?.querySelectorAll('tbody tr').length || 0,
      firstRow: Array.from(box?.querySelectorAll('tbody tr:first-child .ds-td') || [])
        .map((c) => c.textContent).join('|'),
      note: (box?.querySelector('.cap-sec-p')?.textContent || '').trim(),
      prose: document.querySelectorAll('#cap-result .cv-analysis-text').length,
    };
  });
  ok('the extracted table is ON the page, beside the screenshot it came from',
    extracted.present && extracted.headers === 'Region|Revenue' && extracted.rows === 3,
    JSON.stringify(extracted));
  ok('…with its cells intact — the values, not an empty grid of the right size',
    extracted.firstRow === 'North|1200', extracted.firstRow);
  ok('…and an app-computed shape line', /^3 rows × 2 columns/.test(extracted.note), extracted.note);
  ok('…and the narration is NOT here — it is the dock conversation now',
    extracted.prose === 0, String(extracted.prose));
  ok('…and "New visual" is not, because no dataset exists yet', page.visualDisabled);

  const capShot = path.join(shotDir, 'capture-page.png');
  await win.screenshot({ path: capShot });
  ok('capture page screenshot captured',
    fs.existsSync(capShot) && fs.statSync(capShot).size > 5000, capShot);

  // The record on disk carries the project it landed in.
  const record = await app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const history = req('./src/app/history.js');
    const fsp = req('fs');
    const all = await projects.listProjects();
    for (const p of all) {
      const caps = await history.loadAllSummaries(p.id);
      if (caps.length) {
        const full = await history.loadThread(caps[0].id);
        return {
          projectId: p.id,
          id: caps[0].id,
          title: caps[0].title,
          cropExists: !!full.cropPath && fsp.existsSync(full.cropPath),
          copilotThreadId: full.copilotThreadId || '',
        };
      }
    }
    return null;
  });
  ok('the capture is a PROJECT record — scoped, with its crop on disk',
    !!record && !!record.projectId && record.cropExists, JSON.stringify(record));
  ok('…and main seeded a dock conversation with the analysis',
    !!record && !!record.copilotThreadId, JSON.stringify(record));

  // ── Save as dataset → the ORDINARY composer ───────────────────────────────
  await win.click('#cap-act-dataset', { timeout: 8000 });
  await win.waitForSelector('#ds-composer:not([hidden])', { timeout: 20_000 });
  await win.waitForTimeout(1200); // the first preview is a debounced IPC round-trip

  const composer = await win.evaluate(() => ({
    section: (document.querySelector('.hub-body') as HTMLElement)?.dataset.section,
    chips: document.querySelectorAll('#dc-canvas .dc-chip').length,
    rows: document.querySelectorAll('#dc-grid tbody tr').length,
    headerCount: document.querySelectorAll('#dc-grid .dc-th').length,
    editable: document.querySelectorAll('#dc-grid .dc-cell').length,
    count: (document.getElementById('dc-count') || { textContent: '' }).textContent,
    name: (document.getElementById('dc-name') as HTMLInputElement | null)?.value,
    headers: Array.from(document.querySelectorAll('#dc-grid .dc-th-name'))
      .map((h) => h.textContent).join('|'),
    cells: Array.from(document.querySelectorAll('#dc-grid .dc-cell'))
      .map((i) => (i as HTMLInputElement).value).join('|'),
  }));
  ok('Save as dataset opens the composer — the same surface Paste and Import use',
    composer.section === 'datasets' && composer.chips === 1, JSON.stringify(composer));
  ok('…showing the extracted table', composer.rows === 3 && composer.headerCount === 2,
    JSON.stringify(composer));
  ok('…with app-computed counts', /3 rows · 2 columns/.test(composer.count || ''),
    composer.count || '');
  ok('…named from the analysis', composer.name === 'Revenue by region', composer.name);
  ok('…under the model\'s own column labels', composer.headers === 'Region|Revenue',
    composer.headers);
  ok('…and its cells EDITABLE, because a capture is a model reading an image',
    composer.editable === 6, String(composer.editable));
  ok('…carrying the real values, not an empty grid of the right shape',
    composer.cells === 'North|1200|South|900|East|1500', composer.cells);

  const composerShot = path.join(shotDir, 'capture-composer.png');
  await win.screenshot({ path: composerShot });
  ok('composer-from-capture screenshot captured',
    fs.existsSync(composerShot) && fs.statSync(composerShot).size > 5000, composerShot);

  await win.click('#dc-save', { timeout: 8000 });
  await win.waitForFunction(
    () => !!(document.getElementById('ds-composer') as HTMLElement | null)?.hidden,
    null, { timeout: 20_000 },
  );
  await win.waitForTimeout(1200);

  // ── The saved dataset says where it came from ─────────────────────────────
  const saved = await app.evaluate(async (_e, pid: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const history = req('./src/app/history.js');
    const list = await datasets.listDatasets(pid);
    const summary = list.find((d: any) => d.sourceKind === 'capture');
    if (!summary) return { found: false };
    const ds = await datasets.getDataset(pid, summary.id);
    const caps = await history.loadAllSummaries(pid);
    return {
      found: true,
      rows: ds.rowCount,
      columns: ds.columns.map((c: any) => c.name).join('|'),
      firstRow: (ds.rows[0] || []).join('|'),
      origin: ds.origin || null,
      cropPath: (ds.capture && ds.capture.cropPath) || '',
      refreshable: !!summary.originKind,
      captureDatasetId: caps[0] && caps[0].datasetId,
      datasetId: ds.id,
    };
  }, record!.projectId);
  ok('the save produced a capture-sourced dataset with every row',
    saved.found && saved.rows === 3, JSON.stringify(saved));
  ok('…with the model\'s columns and the app\'s own coercion applied',
    saved.columns === 'Region|Revenue' && saved.firstRow === 'North|1200',
    `${saved.columns} / ${saved.firstRow}`);
  ok('…carrying origin.captureId on disk',
    !!saved.origin && saved.origin.captureId === String(record!.id), JSON.stringify(saved.origin));
  ok('…and the crop path main resolved from its own record, never the renderer',
    !!saved.cropPath, saved.cropPath);
  ok('…but NOT offered a refresh: a screenshot has nothing to re-fetch',
    saved.refreshable === false);
  ok('the capture now points back at the dataset it produced',
    saved.captureDatasetId === saved.datasetId, String(saved.captureDatasetId));

  // ── The row shows where it came from ──────────────────────────────────────
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(1200);
  const row = await win.evaluate(() => {
    const cell = document.querySelector('.ds-saved-item .ds-source-cell');
    return {
      glyph: !!cell?.querySelector('.ds-cam-glyph'),
      text: (cell?.textContent || '').trim(),
    };
  });
  ok('the dataset row wears a camera glyph', row.glyph, row.text);
  ok('…and reads "From screenshot · <time>"', /^From screenshot · \S/.test(row.text), row.text);

  // ── The Captures tab, beside Datasets ─────────────────────────────────────
  await win.click('#ds-tab-captures', { timeout: 8000 });
  await win.waitForTimeout(1200);
  const tab = await win.evaluate(() => {
    const card = document.querySelector('#cap-grid .cap-card');
    return {
      section: (document.querySelector('.hub-body') as HTMLElement)?.dataset.section,
      cards: document.querySelectorAll('#cap-grid .cap-card').length,
      thumb: !!card?.querySelector('.cap-card-img'),
      name: (card?.querySelector('.viz-card-name')?.textContent || '').trim(),
      meta: (card?.querySelector('.viz-card-meta')?.textContent || '').trim(),
      badge: (card?.querySelector('.cap-card-badge')?.textContent || '').trim(),
      actions: Array.from(card?.querySelectorAll('.cap-card-acts .btn') || [])
        .map((b) => (b.textContent || '').trim()).join('|'),
      datasetsHidden: !!(document.getElementById('ds-saved') as HTMLElement | null)?.hidden,
      selected: document.getElementById('ds-tab-captures')?.getAttribute('aria-selected'),
    };
  });
  ok('Captures is a TAB on the Data page, not a section of its own',
    tab.section === 'datasets' && tab.selected === 'true' && tab.datasetsHidden,
    JSON.stringify(tab));
  ok('…showing one card, with the screenshot as its tile',
    tab.cards === 1 && tab.thumb, JSON.stringify(tab));
  ok('…titled from the analysis, with a time', tab.name === 'Revenue by region' && !!tab.meta,
    `${tab.name} / ${tab.meta}`);
  ok('…badged "Dataset", because one was saved from it', tab.badge === 'Dataset', tab.badge);
  ok('…with Open / Save as dataset / Delete on hover',
    tab.actions === 'Open|Save as dataset|Delete', tab.actions);

  const tabShot = path.join(shotDir, 'captures-tab.png');
  await win.screenshot({ path: tabShot });
  ok('Captures tab screenshot captured',
    fs.existsSync(tabShot) && fs.statSync(tabShot).size > 5000, tabShot);

  // Clicking a card opens the capture page — the same page the capture landed on.
  // Reload first: this is the path a NEW session takes, where the only thing
  // the page knows about the capture is what it reads back off disk.
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await win.waitForSelector('#splash[hidden]', { timeout: 30_000 }).catch(() => {});
  await win.waitForTimeout(1500);
  await win.evaluate(async (pid: string) => {
    await (window as any).adoptProject(pid);
    (window as any).selectSection('datasets');
  }, record!.projectId);
  await win.waitForTimeout(1000);
  await win.click('#ds-tab-captures', { timeout: 8000 });
  await win.waitForTimeout(1200);

  await win.click('#cap-grid .cap-card .viz-card-body', { timeout: 8000 });
  await win.waitForFunction(
    () => (document.querySelector('.hub-body') as HTMLElement)?.dataset.section === 'capture',
    null, { timeout: 15_000 },
  );
  await win.waitForTimeout(800);
  await win.waitForFunction(
    () => !!document.querySelector('#cap-result .cap-extracted'),
    null, { timeout: 20_000 },
  ).catch(() => {});
  const reopened = await win.evaluate(() => ({
    title: (document.getElementById('cap-title') || { textContent: '' }).textContent,
    badge: !(document.getElementById('cap-badge') as HTMLElement | null)?.hidden,
    visualEnabled: !(document.getElementById('cap-act-visual') as HTMLButtonElement)?.disabled,
    rows: document.querySelectorAll('#cap-result .cap-extracted tbody tr').length,
  }));
  ok('a card opens the capture page, loading its stored result from disk',
    reopened.title === 'Revenue by region' && reopened.rows === 3, JSON.stringify(reopened));
  ok('…now badged "Dataset" and offering "New visual"',
    reopened.badge && reopened.visualEnabled, JSON.stringify(reopened));

  // "‹ Back" returns to the list it came from, not to some other section.
  await win.click('#cap-back', { timeout: 8000 });
  await win.waitForTimeout(900);
  const back = await win.evaluate(() => ({
    section: (document.querySelector('.hub-body') as HTMLElement)?.dataset.section,
    tab: document.getElementById('ds-tab-captures')?.getAttribute('aria-selected'),
  }));
  ok('Back returns to the Captures tab', back.section === 'datasets' && back.tab === 'true',
    JSON.stringify(back));

  // ── Ask opens the dock on THIS capture ────────────────────────────────────
  // Note this runs on the capture the reload above re-read off disk, not on
  // the one this session captured: finding its conversation again is the whole
  // point of storing the thread id on the record.
  await win.evaluate(() => { (window as any).selectSection('capture'); });
  await win.waitForTimeout(600);
  await win.click('#cap-act-ask', { timeout: 8000 });
  await win.waitForSelector('#dk-panel:not([hidden])', { timeout: 15_000 });
  await win.waitForTimeout(1200);
  const dock = await win.evaluate(() => ({
    open: !!(document.getElementById('dk-panel') as HTMLElement | null)?.offsetParent,
    context: (document.getElementById('dk-context') || { textContent: '' }).textContent,
    firstTurn: (document.querySelector('#dk-messages .xp-bubble') || { textContent: '' }).textContent,
    ref: (window as any).dkContextRef(),
  }));
  ok('Ask opens the dock', dock.open, JSON.stringify(dock).slice(0, 200));
  ok('…scoped to the capture', dock.ref && dock.ref.kind === 'capture' && !!dock.ref.id,
    JSON.stringify(dock.ref));
  ok('…and its context line says so', /capture · Revenue by region/.test(dock.context || ''),
    dock.context || '');
  ok('…on the conversation main seeded with the analysis',
    /North leads on revenue/.test(dock.firstTurn || ''), (dock.firstTurn || '').slice(0, 120));

  // ── Home counts captures only when there are any ──────────────────────────
  await win.evaluate(() => { (window as any).selectSection('home'); });
  await win.waitForTimeout(1500);
  const withCaptures = await win.evaluate(
    () => (document.getElementById('home-greet-sub') || { textContent: '' }).textContent || '');
  ok('Home counts captures when the project has them', /1 capture\b/.test(withCaptures), withCaptures);
  ok('…without pluralising one', !/1 captures/.test(withCaptures), withCaptures);

  const recent = await win.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('#home-recent-rows [data-type="capture"]'));
    return { count: rows.length, hasGlyph: rows.some((r) => !!r.querySelector('svg')) };
  });
  ok('…and lists it in Recent with a glyph', recent.count === 1 && recent.hasGlyph,
    JSON.stringify(recent));

  // A project with none must not be told it has none. (The name deliberately
  // avoids the word — the assertion below reads the whole subtitle.)
  const bare = await win.evaluate(async () => {
    const proj = await (window as any).hub.createProject('Empty workspace');
    await (window as any).adoptProject(proj.id);
    await (window as any).refreshHome();
    return (document.getElementById('home-greet-sub') || { textContent: '' }).textContent || '';
  });
  await win.waitForTimeout(800);
  const bareNow = await win.evaluate(
    () => (document.getElementById('home-greet-sub') || { textContent: '' }).textContent || '');
  ok('a project with no captures says nothing about captures',
    !/capture/i.test(bareNow), bareNow || bare);

  const netCalls = await app.evaluate(() => (globalThis as any).__smoke.net);
  ok('nothing reached the network', netCalls === 0, String(netCalls));
  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 3).join(' | '));

  await closeApp(app);
}

main()
  .then(() => {
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    console.log('');
    if (failureCount()) {
      console.error(`${failureCount()} capture smoke check(s) FAILED.`);
      process.exit(1);
    }
    console.log('All capture smoke checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
