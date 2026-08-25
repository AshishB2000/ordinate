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
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

// playwright is a devDependency; its Electron driver talks to the app over the
// DevTools protocol, so it needs no screen-capture or accessibility permission.
const { _electron }: typeof import('playwright') = require('playwright');

// A renderer script-global (chartRender.js). Classic-script `const`s live in the
// global LEXICAL scope, not on `window`, so a page-context callback reaches it by
// bare name — but this file's own program has never seen it. Declared, not
// eval'd: the hub CSP is `script-src 'self'`, which blocks eval outright.
declare const chartInstances: { get(el: unknown): any };
// dashboards.js's module-local `let dashCurrent` — same lexical-global trick,
// used below only to read the open dashboard record's own id (never mutated
// from here).
declare const dashCurrent: any;

const REPO = path.resolve(__dirname, '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-smoke-'));
const shotDir = process.env.SMOKE_ARTIFACT_DIR || userData;


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
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const visuals = req('./src/analysis/visuals.js');
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
    const residentQuery = req('./src/engine/residentQuery.js');
    const datasetPage = req('./src/engine/datasetPage.js');
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

    // ── An `in` filter, end to end, on a MILLION rows ───────────────────────
    //
    // The differential suites prove `in` is correct. What they cannot prove is
    // that the real CALL SITE still routes to SQL: an operator missing from a
    // resident module's vocabulary is SKIPPED, not failed — no WHERE is emitted
    // and the query happily answers over every row. So this asserts three
    // separate things, because any one of them alone can pass while broken:
    //   1. the chart returns only the 3 listed groups,
    //   2. the metric changes (a skipped predicate would return the full sum),
    //   3. residentTrace says 'resident', not 'skipped' or 'failed'.
    const trace = req('./src/engine/residentTrace.js');
    const ipcVisuals = req('./src/ipc/visuals.js');
    const inFilter = [
      { type: 'filter', column: 'region', op: 'in', values: ['region0', 'region2', 'region4'] },
    ];

    out.inChart = src && residentQuery.aggregateResident(src, 'region', [
      { column: 'amount', aggregation: 'sum' },
    ], inFilter);
    out.inLabels = out.inChart && out.inChart.labels;
    out.inMetric = src && residentQuery.computeMetricResident(
      src, { column: 'amount', aggregation: 'sum' }, inFilter,
    );
    out.notInMetric = src && residentQuery.computeMetricResident(
      src, { column: 'amount', aggregation: 'sum' },
      [{ type: 'filter', column: 'region', op: 'not in', values: ['region0', 'region2', 'region4'] }],
    );

    // Through the shipped IPC helper, which is what `visual:data` calls — and
    // therefore the thing that has to still choose the resident path.
    trace.reset();
    t = Date.now();
    const viaIpc = await ipcVisuals.residentVizData(proj.id, ds.id, {
      category: 'region', values: [{ column: 'amount', aggregation: 'sum' }],
    }, inFilter);
    out.inIpcMs = Date.now() - t;
    out.inIpcLabels = viaIpc && viaIpc.data && viaIpc.data.labels;
    out.inIpcWarnings = viaIpc && viaIpc.warnings ? viaIpc.warnings.length : -1;
    out.inTrace = trace.snapshot().vizAggregate || null;

    // An `in` with NO values must be REJECTED by that helper, because the JS
    // path would emit a warning there and the fast path may only run when it
    // provably would not have.
    trace.reset();
    out.emptyInViaIpc = await ipcVisuals.residentVizData(proj.id, ds.id, {
      category: 'region', values: [{ column: 'amount', aggregation: 'sum' }],
    }, [{ type: 'filter', column: 'region', op: 'in', values: [] }]);

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
    const nodeFs = req('fs');
    const nodePath = req('path');
    const userDataDir = req('electron').app.getPath('userData');

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

    // Backdate 'By state' so a sheet reading BOTH it and 'Sales' has a clearly
    // older input. Without this the oldest-vs-newest rule is untestable: every
    // fixture is stamped within the same second and either rule reads the same.
    const OLD_STAMP = '2020-03-04T05:06:07.000Z';
    const bsFile = nodePath.join(userDataDir, 'projects', proj.id, 'datasets', geoDs.id + '.json');
    const bsRaw = JSON.parse(nodeFs.readFileSync(bsFile, 'utf8'));
    bsRaw.lastRefreshedAt = OLD_STAMP;
    nodeFs.writeFileSync(bsFile, JSON.stringify(bsRaw, null, 2));
    out.oldStamp = OLD_STAMP;

    // A REAL csv on disk, imported through the real parser and stamped with a
    // file origin — the fixture for the refresh chain further down. Everything
    // else in this file is saved from in-memory rows; this one has to be a file,
    // because the whole point is re-reading it after it changes.
    const fileImport = req('./src/data/fileImport.js');
    const csvPath = nodePath.join(userDataDir, 'refreshable.csv');
    nodeFs.writeFileSync(csvPath, 'city,visits\nOslo,10\nBergen,20\n', 'utf8');
    const parsed = await fileImport.parseFile(csvPath, 'csv');
    const fileDs = await datasets.saveDataset(proj.id, {
      name: 'Refreshable',
      sourceKind: 'csv',
      columns: parsed.columns,
      rows: parsed.rows,
      origin: { kind: 'file', path: csvPath },
    });
    out.fileDatasetId = fileDs && fileDs.id;
    out.fileDatasetRows = fileDs && fileDs.rowCount;
    out.csvPath = csvPath;
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
  ok('a file-backed dataset was imported with a file origin',
     r.fileDatasetRows === 2 && typeof r.csvPath === 'string', `${r.fileDatasetRows} rows from ${r.csvPath}`);

  // ── The `in` operator, on the real app, over a million rows ───────────────
  ok('an `in` filter with 3 values narrows the chart to those 3 groups',
     Array.isArray(r.inLabels) && r.inLabels.length === 3 &&
       JSON.stringify(r.inLabels) === JSON.stringify(['region0', 'region2', 'region4']),
     JSON.stringify(r.inLabels));
  // The proof the predicate REACHED SQL: a skipped operator would answer over
  // all 7 regions and hand back the unfiltered total.
  ok('…and the metric card respects it, rather than returning the full total',
     typeof r.inMetric === 'number' && r.inMetric !== r.metric,
     `filtered=${r.inMetric} vs unfiltered=${r.metric}`);
  ok('`in` and `not in` partition the column exactly',
     typeof r.notInMetric === 'number' && Math.abs((r.inMetric + r.notInMetric) - r.metric) < 1e-6,
     `${r.inMetric} + ${r.notInMetric} vs ${r.metric}`);
  ok('the same filter through the shipped visual:data helper agrees',
     JSON.stringify(r.inIpcLabels) === JSON.stringify(r.inLabels) && r.inIpcWarnings === 0,
     `labels=${JSON.stringify(r.inIpcLabels)} warnings=${r.inIpcWarnings}`);
  // residentTrace is the runtime alarm for a fast path that quietly stopped
  // firing. 'resident' means the SQL path answered; 'skipped'/'failed' would
  // both still produce a CORRECT chart, ~600x slower, and ship green.
  ok('…on the RESIDENT path — not skipped, not failed',
     !!r.inTrace && r.inTrace.resident === 1 && r.inTrace.skipped === 0 && r.inTrace.failed === 0,
     JSON.stringify(r.inTrace));
  ok('an `in` with no values falls back instead of silently dropping its warning',
     r.emptyInViaIpc === null, JSON.stringify(r.emptyInViaIpc));
  ok('`in` over 1M rows is still fast', r.inIpcMs < 2000, `${r.inIpcMs} ms`);
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

  // ── The no-project dead end ───────────────────────────────────────────────
  // FIRST UI interaction in this file, deliberately. The renderer's
  // currentProjectId is a script-scope `let`, not a window property, so a test
  // cannot fake the null state — it can only run before anything fills it in.
  // Placed later, this assertion passes with the bug still present, because the
  // home-screen checks below adopt a project on the way past.
  //
  // Null currentProjectId is the state a fresh install is permanently in.
  // "+ New visual" used to alert "Open a project first" and stop — a dead end,
  // since projects are demoted by design and there is no picker in the nav to
  // send anyone to. It must resolve one implicitly and open the popup.
  await win.evaluate(() => {
    (window as any).__alerts = [];
    window.alert = (m?: any) => { (window as any).__alerts.push(String(m)); };
  });
  await win.evaluate(() => {
    const el = [...document.querySelectorAll('.as-nav-item')].find(
      (b) => (b.textContent || '').trim() === 'Visuals') as HTMLElement | undefined;
    el?.click();
  });
  await win.waitForTimeout(900);

  // The empty state is the SHARED .ws-empty treatment, not a bespoke dashed box
  // — the whole point of hoisting those classes. Asserted from a laid-out page:
  // a glyph cluster that renders zero <svg> children, or an AI door that is not
  // actually gated, both look fine to a DOM-presence check.
  const vizEmpty = await win.evaluate(() => {
    const box = document.getElementById('viz-empty');
    const art = document.getElementById('viz-empty-art');
    return {
      shared: !!box && box.classList.contains('ws-empty'),
      visible: !!box && box.offsetParent !== null,
      glyphs: art ? art.querySelectorAll('svg').length : 0,
      heading: (document.querySelector('#viz-empty .ws-empty-h')?.textContent || '').trim(),
      aiDisabled: (document.getElementById('viz-empty-ai') as HTMLButtonElement | null)?.disabled,
      hintShown: (document.getElementById('viz-empty-hint') as HTMLElement | null)?.hidden === false,
      countHidden: (document.getElementById('viz-count') as HTMLElement | null)?.hidden,
    };
  });
  ok('the Visuals empty state reuses the shared .ws-empty surface',
     vizEmpty.shared && vizEmpty.visible && vizEmpty.heading === 'No visuals yet',
     JSON.stringify(vizEmpty));
  ok('…with a real chart-glyph cluster, not an empty box',
     vizEmpty.glyphs >= 3, `${vizEmpty.glyphs} glyphs`);
  ok('…the AI door gated + explained with no model, and the count chip hidden at zero',
     vizEmpty.aiDisabled === true && vizEmpty.hintShown && vizEmpty.countHidden === true,
     JSON.stringify(vizEmpty));

  // An empty page that only DESCRIBES the next action is still a blank page.
  // The band offers the project's real datasets, and — the part worth pinning —
  // it must not claim "No data yet" to someone who has data. Arriving here via
  // the nav leaves no project adopted, so this also covers the read path that
  // resolves an existing project WITHOUT creating one.
  const startBand = await win.evaluate(() => {
    const band = document.getElementById('viz-start');
    const cards = [...document.querySelectorAll('.viz-ds-card')] as HTMLElement[];
    return {
      visible: !!band && band.offsetParent !== null,
      cards: cards.length,
      noDataCard: !!document.querySelector('.viz-ds-none'),
      first: (cards[0]?.textContent || '').replace(/\s+/g, ' ').trim(),
      // The card, the band and the grid must share one left and one right edge
      // whichever of them is on screen. A capped/centred card silently breaks
      // that against the full-width band beneath it, and the misalignment is
      // the kind of thing only a measurement catches.
      edges: (() => {
        const card = document.getElementById('viz-empty');
        const band = document.getElementById('viz-start');
        if (!card || !band) return null;
        const c = card.getBoundingClientRect();
        const b = band.getBoundingClientRect();
        return { dl: Math.round(Math.abs(c.left - b.left)), dr: Math.round(Math.abs(c.right - b.right)) };
      })(),
      cardH: Math.round(document.getElementById('viz-empty')?.getBoundingClientRect().height || 0),
    };
  });
  ok('…and a "Start from a dataset" band offering the project\'s real datasets',
     startBand.visible && startBand.cards > 0 && !startBand.noDataCard,
     JSON.stringify(startBand));
  ok('…listing rows and columns per dataset, not just a name',
     /rows · \d+ columns/.test(startBand.first), `"${startBand.first}"`);
  ok('…edge-aligned with the empty card above it, left and right',
     !!startBand.edges && startBand.edges.dl === 0 && startBand.edges.dr === 0,
     JSON.stringify(startBand.edges));
  ok('…and the card reads as a panel, not a strip',
     startBand.cardH >= 200, `${startBand.cardH}px tall`);

  await win.evaluate(() => (document.getElementById('viz-new-btn') as HTMLElement)?.click());
  await win.waitForTimeout(2000);
  const noProject = await win.evaluate(() => ({
    alerts: (window as any).__alerts as string[],
    modalOpen: !!document.querySelector('.vn-modal'),
  }));
  ok('+ New visual with no project adopted opens the popup instead of a dead end',
     noProject.modalOpen && noProject.alerts.length === 0, JSON.stringify(noProject));
  await win.evaluate(() => (document.querySelector('.js-vn-cancel') as HTMLElement)?.click());
  await win.waitForTimeout(400);

  await win.evaluate(async () => {
    // Connect is its own SECTION now, not an overlay over the capture surface, so
    // opening it IS the navigation. The old follow-up selectSection('sources')
    // revealed .main *underneath* the overlay; today it navigates straight back
    // off the page and every tile below this point is present but invisible.
    (window as any).selectSection('connect');
    await (window as any).refreshConnPanel();
  });
  await win.waitForTimeout(300);

  // The point of the change: Connect is the WHOLE page. Asserting the tiles
  // render is not enough — they rendered before too, framed by a Welcome header
  // and a captures column that had nothing to do with picking a data source.
  // offsetParent is null for a display:none subtree, so this catches the panel
  // being reparented back under .main as well as the CSS rule being dropped.
  const dataPageAlone = await win.evaluate(() => {
    const shown = (sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      return !!el && el.offsetParent !== null;
    };
    return {
      connect: shown('#conn-panel'),
      welcomeHeader: shown('.main-top'),
      capturesColumn: shown('.sidebar'),
      navActive: !!document.querySelector('.as-nav-item.active[data-section="datasets"]'),
    };
  });
  ok('the Data page renders Connect ALONE — no Welcome header, no captures column',
    dataPageAlone.connect && !dataPageAlone.welcomeHeader && !dataPageAlone.capturesColumn,
    JSON.stringify(dataPageAlone));
  // Connect is an ACTION inside the Data area, so the "Data" nav item (which
  // points at datasets) stays lit here via its data-section-alt="connect".
  ok('...with the Data nav item marked active', dataPageAlone.navActive);

  // Close must land somewhere real. Before, it just un-hid an overlay and left
  // whatever was underneath; now it is a navigation, and getting it wrong
  // strands the user on a hidden section with an empty stage.
  const closeReturns = await win.evaluate(() => {
    (window as any).selectSection('home');
    (window as any).selectSection('connect');
    (window as any).closeConnPanel();
    return (document.querySelector('.hub-body') as HTMLElement)?.dataset.section;
  });
  ok('Close returns to the previous view', closeReturns === 'home', `landed on ${closeReturns}`);
  await win.evaluate(async () => {
    (window as any).selectSection('connect');
    await (window as any).refreshConnPanel();
  });
  await win.waitForTimeout(200);

  const logoPicker = await win.evaluate(() => {
    const tiles = [...document.querySelectorAll<HTMLButtonElement>('.conn-tile')];
    const byId = (id: string) => document.querySelector<HTMLButtonElement>(`.conn-tile[data-connector-id="${id}"]`);
    const redshift = byId('amazon-redshift');
    const postgres = byId('postgres');
    const sqlserver = byId('sqlserver');
    const addedLocalIds = ['azure-sql', 'oracle', 'starrocks', 'csv-folder'];
    const fallbackIds = tiles
      .filter((tile) => tile.querySelector('.conn-logo-fallback'))
      .map((tile) => tile.dataset.connectorId || '');
    const undrawnIds = tiles
      .filter((tile) => !tile.querySelector('.conn-logo svg, .conn-logo img'))
      .map((tile) => tile.dataset.connectorId || '');
    return {
      count: tiles.length,
      everyTileHasLogo: tiles.every((tile) => !!tile.querySelector('.conn-logo')),
      redshiftIsImage: !!redshift?.querySelector('.conn-logo img[src^="data:image/png;base64,"]'),
      postgresIsSvg: !!postgres?.querySelector('.conn-logo svg path'),
      sqlserverIsImage: !!sqlserver?.querySelector('.conn-logo img[src^="data:image/svg+xml;base64,"]'),
      addedLocalImages: addedLocalIds.every((id) =>
        !!byId(id)?.querySelector('.conn-logo img[src^="data:image/"]')),
      fallbackIds,
      undrawnIds,
      logosDecorative: tiles.every((tile) => tile.querySelector('.conn-logo')?.getAttribute('aria-hidden') === 'true'),
    };
  });
  ok('all 35 connector tiles have a logo block', logoPicker.count === 35 && logoPicker.everyTileHasLogo, JSON.stringify(logoPicker));
  ok('Redshift uses the supplied image and PostgreSQL uses a bundled glyph',
    logoPicker.redshiftIsImage && logoPicker.postgresIsSvg, JSON.stringify(logoPicker));
  ok('all catalog sources use real marks instead of normal fallback badges',
    logoPicker.sqlserverIsImage && logoPicker.addedLocalImages &&
      logoPicker.fallbackIds.length === 0 &&
      logoPicker.undrawnIds.length === 0,
    JSON.stringify(logoPicker));
  ok('connector logos are decorative', logoPicker.logosDecorative);

  const originalTheme = await win.evaluate(() =>
    document.documentElement.getAttribute('data-theme'));
  const catalogShots: string[] = [];
  for (const theme of ['light', 'dark']) {
    await win.evaluate((nextTheme) =>
      document.documentElement.setAttribute('data-theme', nextTheme), theme);
    const shot = path.join(shotDir, `data-source-logos-${theme}.png`);
    await win.screenshot({ path: shot });
    catalogShots.push(shot);
  }
  await win.evaluate((theme) => {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }, originalTheme);
  ok('data-source logo screenshots captured in light and dark themes',
    catalogShots.every((shot) => fs.existsSync(shot) && fs.statSync(shot).size > 5000),
    catalogShots.join(' | '));

  const brokenImageFallback = await win.evaluate(() => {
    const redshiftLogo = document.querySelector<HTMLElement>(
      '.conn-tile[data-connector-id="amazon-redshift"] .conn-logo',
    );
    redshiftLogo?.querySelector('img')?.dispatchEvent(new Event('error'));
    return {
      isFallback: redshiftLogo?.classList.contains('conn-logo-fallback') || false,
      text: redshiftLogo?.textContent || '',
      hasImage: !!redshiftLogo?.querySelector('img'),
    };
  });
  ok('a malformed connector image falls back to deterministic initials',
    brokenImageFallback.isFallback && brokenImageFallback.text === 'AR' && !brokenImageFallback.hasImage,
    JSON.stringify(brokenImageFallback));

  await win.click('.conn-tile[data-connector-id="amazon-redshift"]');
  const chosenHasLogo = await win.evaluate(() =>
    !!document.querySelector('#conn-chosen-logo img[src^="data:image/png;base64,"]'));
  ok('the selected-source header repeats its logo', chosenHasLogo);
  const brokenChosenImageFallback = await win.evaluate(() => {
    const chosenLogo = document.querySelector<HTMLElement>('#conn-chosen-logo');
    chosenLogo?.querySelector('img')?.dispatchEvent(new Event('error'));
    return {
      isFallback: chosenLogo?.classList.contains('conn-logo-fallback') || false,
      text: chosenLogo?.textContent || '',
      hasImage: !!chosenLogo?.querySelector('img'),
    };
  });
  ok('a malformed selected-source image falls back to deterministic initials',
    brokenChosenImageFallback.isFallback && brokenChosenImageFallback.text === 'AR' &&
      !brokenChosenImageFallback.hasImage,
    JSON.stringify(brokenChosenImageFallback));
  await win.click('#conn-close-btn');
  await win.evaluate(() => { (window as any).selectSection('home'); });

  // ── Home view coverage (regression guard) ─────────────────────────────────
  // The persistent sidebar is the FIRST thing every user sees, yet nothing here
  // ever clicked it — the suite reloaded then drove the workspace via
  // openWorkspace(), so a home whose controls were all bound to stale selectors
  // would ship GREEN. A real inconsistent/stale build does exactly that, and
  // silently (no console error). So click REAL controls and assert each produces
  // its effect. A dead (unbound) or covered (overlay) button leaves the effect
  // absent, which fails loudly here.
  const homeSection = () =>
    win.evaluate(() => document.querySelector('.hub-body')?.getAttribute('data-section'));

  const homeLogos = await win.evaluate(() => {
    const hosts = [...document.querySelectorAll('.as-connect-item .as-source-logo')];
    return {
      count: hosts.length,
      allDrawn: hosts.every((el) => !!el.querySelector('svg, img')),
      oldDots: document.querySelectorAll('.as-connect-item .as-dot').length,
      postgresSvg: !!document.querySelector(
        '.as-source-logo[data-logo-id="postgres"] svg',
      ),
      mysqlSvg: !!document.querySelector(
        '.as-source-logo[data-logo-id="mysql"] svg',
      ),
      pasteSvg: !!document.querySelector(
        '.as-source-logo[data-logo-id="home-paste"] svg path[fill="currentColor"]',
      ),
      captureImg: document.querySelector(
        '.as-source-logo[data-logo-id="home-capture"] img',
      )?.getAttribute('src') === 'assets/connectors/screenchart.png',
    };
  });
  ok('home: Connect shortcuts use five real source or action marks',
    homeLogos.count === 5 && homeLogos.allDrawn && homeLogos.oldDots === 0 &&
      homeLogos.postgresSvg && homeLogos.mysqlSvg && homeLogos.pasteSvg &&
      homeLogos.captureImg,
    JSON.stringify(homeLogos));

  // The strapline under the Connect cards ("Press ⌘⌥S … No model configured …
  // Your data stays on this machine.") was removed. Asserting the TEXT is gone
  // rather than the element, because a future rewrite could reintroduce the
  // copy under a different class and the element check would not notice.
  //
  // The hotkey assertion is the load-bearing half. That strapline was the only
  // thing on Home printing the REAL configured shortcut — `fillDiscover()` wrote
  // it into `#home-disc-hotkey`. The "Grab it off your screen" card had a
  // HARDCODED ⌘⌥S, so deleting the line naively would have left a rebound
  // hotkey silently wrong on the front page. The id moved onto the card; this
  // proves it is still being filled and not just present in the markup.
  const homeStrapline = await win.evaluate(() => {
    const text = document.body.innerText || '';
    const kbd = document.getElementById('home-disc-hotkey');
    return {
      machineText: text.includes('stays on this machine'),
      noModelText: text.includes('No model configured'),
      staleClass: !!document.querySelector('.home-discover-line'),
      staleAiSpan: !!document.getElementById('home-disc-ai'),
      hotkey: kbd ? (kbd.textContent || '').trim() : null,
      // fillDiscover() is async; a still-default value on a machine whose hotkey
      // IS the default is indistinguishable from "never ran", so assert only
      // that something non-empty was rendered into it.
      hotkeyFilled: !!(kbd && (kbd.textContent || '').trim().length > 0),
    };
  });
  ok('home: the strapline under the Connect cards is gone',
    !homeStrapline.machineText && !homeStrapline.noModelText &&
      !homeStrapline.staleClass && !homeStrapline.staleAiSpan,
    JSON.stringify(homeStrapline));
  ok('home: …but the capture card still prints the REAL hotkey, not a hardcoded one',
    homeStrapline.hotkeyFilled, `hotkey=${homeStrapline.hotkey}`);

  const homeShots: string[] = [];
  for (const theme of ['light', 'dark']) {
    await win.evaluate((nextTheme) =>
      document.documentElement.setAttribute('data-theme', nextTheme), theme);
    const shot = path.join(shotDir, `home-source-logos-${theme}.png`);
    await win.screenshot({ path: shot });
    homeShots.push(shot);
  }
  await win.evaluate((theme) => {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }, originalTheme);
  ok('home source-logo screenshots captured in light and dark themes',
    homeShots.every((shot) => fs.existsSync(shot) && fs.statSync(shot).size > 5000),
    homeShots.join(' | '));

  // ── Capture workspace: full-screen, no nav ─────────────────────────────────
  await win.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.as-connect-item'))
      .find((e) => (e as HTMLElement).dataset.source === 'capture') as HTMLElement | undefined;
    if (b) b.click();
  });
  // The rail item resolves a project first (async), so focus mode arrives a beat
  // after the click. Wait for the class, not the clock — an earlier version of
  // this used a fixed sleep and was flaky about one run in three, and a flaky
  // assertion is worse than no assertion: it teaches you to re-run rather than
  // to read.
  await win.waitForFunction(() => document.body.classList.contains('cap-focus'),
    null, { timeout: 20000 }).catch(() => {});
  const capturePage = await win.evaluate(() => {
    const vis = (el: Element | null) => !!(el && (el as HTMLElement).offsetParent !== null);
    return {
      focus: document.body.classList.contains('cap-focus'),
      navVisible: vis(document.getElementById('app-sidebar')),
      capturesColumn: vis(document.querySelector('.sidebar')),
      title: (document.getElementById('main-title-h') || { textContent: '' }).textContent,
      subVisible: vis(document.getElementById('main-title-sub')),
      hotkeyChip: vis(document.querySelector('.hotkey-hint')),
      connectDataBtn: vis(document.getElementById('conn-connect-btn')),
      newCapture: vis(document.getElementById('new-capture')),
      back: vis(document.getElementById('cap-back')),
    };
  });
  ok('capture: the left nav is gone entirely — same focus mode an analysis uses',
    capturePage.focus && !capturePage.navVisible, JSON.stringify(capturePage));
  ok('capture: the captures column stays — it is part of this workspace',
    capturePage.capturesColumn);
  ok('capture: titled "Capture", with the Welcome strapline collapsed',
    capturePage.title === 'Capture' && !capturePage.subVisible);
  ok('capture: the ⌘⌥S chip and "Connect data" are gone, "New capture" stays',
    !capturePage.hotkeyChip && !capturePage.connectDataBtn && capturePage.newCapture);
  ok('capture: a Back control exists — with no nav it is the only way out',
    capturePage.back);
  const capShot = path.join(shotDir, 'capture-page.png');
  await win.screenshot({ path: capShot });
  ok('capture page screenshot captured',
    fs.existsSync(capShot) && fs.statSync(capShot).size > 5000, capShot);

  // Back restores the nav and drops focus mode.
  await win.evaluate(() => (document.getElementById('cap-back') as HTMLElement).click());
  await win.waitForFunction(() => !document.body.classList.contains('cap-focus'),
    null, { timeout: 15000 }).catch(() => {});
  const afterBack = await win.evaluate(() => ({
    focus: document.body.classList.contains('cap-focus'),
    navVisible: !!(document.getElementById('app-sidebar') as HTMLElement).offsetParent,
  }));
  ok('capture: Back leaves focus mode and restores the nav',
    !afterBack.focus && afterBack.navVisible, JSON.stringify(afterBack));

  // The chip is only a PICTURE of the hotkey; the shortcut is registered in
  // main. "Removed the chip" and "unregistered the shortcut" look identical on
  // screen, so assert the hotkey still resolves.
  const hotkeyAlive = await win.evaluate(() => (window as any).hub.getHotkeyLabel()
    .then((r: any) => !!(r && (typeof r === 'string' ? r : r.label))).catch(() => false));
  ok('capture: dropping the ⌘⌥S chip did not unregister the hotkey', hotkeyAlive);

  await win.evaluate(() => { (window as any).selectSection('home'); });
  await win.waitForTimeout(400);

  await win.click('#settings-gear', { timeout: 4000 }).catch(() => {});
  await win.waitForTimeout(300);
  const settingsOpened = await win.evaluate(() => {
    const m = document.getElementById('settings-menu');
    return !!m && m.hidden === false;
  });
  ok('home: the Settings gear opens its menu', settingsOpened);
  await win.keyboard.press('Escape').catch(() => {});
  await win.waitForTimeout(200);

  await win.click('.as-nav-item[data-section="visuals"]', { timeout: 4000 }).catch(() => {});
  await win.waitForTimeout(400);
  const navSection = await homeSection();
  ok('home: a sidebar nav item switches the section', navSection === 'visuals', `section=${navSection}`);

  await win.click('.as-nav-item[data-section="explore"]', { timeout: 4000 }).catch(() => {}); // #side-ai-btn was a duplicate door; it toggles the dock now (smoke-dock.ts)
  await win.waitForTimeout(400);
  const aiSection = await homeSection();
  ok('home: the Explore nav item opens the blank-page chat surface', aiSection === 'explore', `section=${aiSection}`);

  // Back to Home so the project-open flow below starts from a clean state.
  await win.click('.as-nav-item[data-section="home"]', { timeout: 4000 }).catch(() => {});
  await win.waitForTimeout(300);

  // Projects are no longer the front door — there is no card to click. Open the
  // project through openWorkspace(), the same renderer entry point the app uses
  // when a Recent item is opened, then navigate to Data via the sidebar nav.
  const opened: string | null = await win.evaluate((id) => {
    const ow = (window as any).openWorkspace;
    if (typeof ow !== 'function') return null;
    ow(id);
    return id;
  }, r.projectId);
  ok('project opens from the UI (openWorkspace)', opened !== null, opened || 'openWorkspace missing');
  await win.waitForTimeout(1500);

  // The "Data" nav item points at the dataset list now, so reach it the way a
  // user does — one click on the nav. What this proves (a stored Parquet dataset
  // renders with its real row count) is unchanged; only the route is more
  // faithful than the old direct selectSection() call.
  await win.click('.as-nav-item[data-section="datasets"]', { timeout: 8000 }).catch(() => {});
  await win.waitForTimeout(2000);

  // The dataset must be VISIBLE in the UI, with its real row count — this is
  // what proves the Parquet store reaches the screen, not just the API.
  // SCOPED to the list's own row-count cell. A document-wide text search also
  // matches the import hint ("CSV, JSON or Excel — up to 1,000,000 rows."),
  // which would pass this check with the dataset absent from the screen —
  // exactly the failure it exists to catch. The cell groups thousands now, so
  // the separator is whatever the runtime locale picks, or none.
  const listed: string | null = await win.evaluate(() => {
    const el = [...document.querySelectorAll('#ds-saved-list .ds-saved-item .ds-saved-meta')].find(
      (e) => /1[,.\u202f\u00a0\s]?000[,.\u202f\u00a0\s]?000 rows/.test(e.textContent || ''),
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
  // Click a visible control by its exact text.
  //
  // An OPEN ANALYSIS hides the project nav (focus mode), exactly as the
  // reference does — so the section buttons are genuinely unreachable until the
  // analysis is closed, and "‹ Back" is the way out. Model that rather than
  // reaching past it: if the target is not on screen and we are in focus mode,
  // leave the analysis first and try again. A test that could still click a
  // hidden nav item would be asserting a UI the user does not have.
  const clickExact = async (text: string): Promise<boolean> => {
    const hit = async (t: string): Promise<boolean> =>
      win.evaluate((x) => {
        const el = [...document.querySelectorAll('button, a, [role=button], li')].find(
          (b) => (b as HTMLElement).offsetParent !== null && (b.textContent || '').trim() === x,
        ) as HTMLElement | undefined;
        if (!el) return false;
        el.click();
        return true;
      }, t);
    if (await hit(text)) return true;
    const focused = await win.evaluate(() => document.body.classList.contains('an-focus'));
    if (!focused) return false;
    await win.evaluate(() => {
      const back = [...document.querySelectorAll('.dash-editor-head button')]
        .find((b) => /Back/.test(b.textContent || '')) as HTMLElement | undefined;
      back?.click();
    });
    await win.waitForTimeout(1200);
    return hit(text);
  };
  const clickId = async (id: string): Promise<boolean> =>
    win.evaluate((i) => {
      const el = document.getElementById(i) as HTMLElement | null;
      if (!el || el.hidden) return false;
      el.click();
      return true;
    }, id);
  // The OPEN overlay, not the first one in the document. Since the Data
  // section's import dialog is static markup (hidden until used), a bare
  // `.ws-modal-overlay` query now finds THAT rather than the modal under test.
  //
  // Visibility is getClientRects(), NOT offsetParent: an overlay is
  // position:fixed, whose offsetParent is null whether it is shown or not.
  const fillPrompt = async (value: string): Promise<boolean> =>
    win.evaluate((v) => {
      const box = [...document.querySelectorAll('.ws-modal-overlay')]
        .filter((o) => (o as HTMLElement).getClientRects().length > 0)
        .map((o) => o.querySelector('.ws-modal'))[0];
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
      const box = [...document.querySelectorAll('.ws-modal-overlay')]
        .filter((o) => (o as HTMLElement).getClientRects().length > 0)
        .map((o) => o.querySelector('.ws-modal'))[0];
      if (!box) return false;
      const sel = box.querySelector('select.ws-modal-input') as HTMLSelectElement | null;
      if (!sel || sel.options.length === 0) return false;
      sel.selectedIndex = 0;
      const okBtn = box.querySelector('.ws-modal-actions .btn-primary') as HTMLElement | null;
      if (!okBtn) return false;
      okBtn.click();
      return true;
    });

  ok('the Dashboards section is in the workspace nav', await clickExact('Dashboards'));
  await win.waitForTimeout(800);

  // A fresh project has no analyses, so the EMPTY STATE is the real first
  // screen. Asserted by what is painted, not by the hidden attribute: the
  // table's own Create button has no `hidden` of its own — only its container
  // does — so `clickId` would happily click it and report green while the user
  // saw an empty page. offsetParent is the check that can tell.
  const emptyState = await win.evaluate(() => {
    const vis = (id: string) => (document.getElementById(id) as HTMLElement | null)?.offsetParent != null;
    const empty = document.getElementById('an-list-empty');
    const r = empty?.getBoundingClientRect();
    return {
      emptyVisible: !!empty && empty.offsetParent !== null,
      h: Math.round(r?.height || 0),
      heading: (document.querySelector('.ws-empty-h')?.textContent || '').trim(),
      createVisible: vis('an-empty-new'),
      aiVisible: vis('an-empty-draft'),
      aiLabel: (document.getElementById('an-empty-draft')?.textContent || '').trim(),
      // The table belongs to the populated state only.
      tableVisible: vis('an-table'),
    };
  });
  ok('an empty Dashboards page shows the empty state, not a bare table',
     emptyState.emptyVisible && emptyState.h > 150 && !emptyState.tableVisible,
     JSON.stringify(emptyState));
  ok('the empty state offers both doors — blank and AI',
     emptyState.createVisible && emptyState.aiVisible && /AI/.test(emptyState.aiLabel),
     `"${emptyState.heading}" / "${emptyState.aiLabel}"`);

  const emptyShot = path.join(shotDir, 'analyses-empty.png');
  await win.screenshot({ path: emptyShot });
  ok('empty-state screenshot captured', fs.existsSync(emptyShot) && fs.statSync(emptyShot).size > 5000,
     `${Math.round(fs.statSync(emptyShot).size / 1024)} KB -> ${emptyShot}`);

  // ── The create wizard ─────────────────────────────────────────────────────
  // Two steps: pick a dataset, then optionally let the model draft it. This run
  // has NO model configured, which is the case that matters most here — the AI
  // half must be visibly unavailable while Skip still works, or "AI is optional"
  // is a claim rather than a behaviour.
  ok('Create dashboard opens the wizard', await clickId('an-empty-new'));
  await win.waitForTimeout(700);

  const wiz1 = await win.evaluate(() => {
    const box = document.querySelector('.an-wiz') as HTMLElement | null;
    const r = box?.getBoundingClientRect();
    const rows = [...document.querySelectorAll('.an-wiz-row')];
    const cols = [...document.querySelectorAll('.an-wiz-cols span')].map((s) => (s.textContent || '').trim());
    const cellLefts = rows[0] ? [...rows[0].children].map((c) => Math.round(c.getBoundingClientRect().left)) : [];
    const colLefts = [...document.querySelectorAll('.an-wiz-cols span')].map((c) => Math.round(c.getBoundingClientRect().left));
    return {
      open: !!box && box.offsetParent !== null,
      w: Math.round(r?.width || 0),
      h: Math.round(r?.height || 0),
      steps: [...document.querySelectorAll('.an-wiz-step-label')].map((s) => (s.textContent || '').trim()),
      step2Optional: !!document.querySelector('.an-wiz-optional'),
      cols,
      aligned: colLefts.length === cellLefts.length &&
               colLefts.every((x, i) => Math.abs(x - cellLefts[i]) <= 1),
      datasetRows: rows.length,
      rowText: rows.map((r2) => (r2.textContent || '').replace(/\s+/g, ' ').trim()).join(' | ').slice(0, 120),
      // Both fixture datasets are listed, and the single-dataset preselect does
      // NOT fire (there are two), so Next must start disabled... except one gets
      // clicked below.
      selected: document.querySelectorAll('.an-wiz-row.is-selected').length,
      createDatasetOffered: [...document.querySelectorAll('.an-wiz-bar .btn')]
        .some((b) => /Create dataset/.test(b.textContent || '')),
      searchPlaceholder: (document.querySelector('.an-wiz-search') as HTMLInputElement | null)?.placeholder || '',
    };
  });
  ok('the wizard paints at a real size', wiz1.open && wiz1.w > 500 && wiz1.h > 300,
     `${wiz1.w}x${wiz1.h}`);
  ok('…with three steps, the last marked optional',
     JSON.stringify(wiz1.steps) === JSON.stringify(['Choose data', 'Start from', 'Describe it']) &&
       wiz1.step2Optional,
     JSON.stringify(wiz1.steps));
  // Three fixture datasets now: Sales, By state, and the file-backed Refreshable.
  ok('…step 1 lists the project datasets with their columns',
     wiz1.datasetRows === 3 &&
       JSON.stringify(wiz1.cols) === JSON.stringify(['', 'Dataset name', 'Rows', 'Columns', 'Source', 'Last modified']),
     `${wiz1.datasetRows} rows / ${JSON.stringify(wiz1.cols)}`);
  ok('…and those cells line up under their labels', wiz1.aligned);
  ok('…the row shows the real row count', /1,000,000/.test(wiz1.rowText), wiz1.rowText);
  ok('…Create dataset and search are offered',
     wiz1.createDatasetOffered && /Search datasets/.test(wiz1.searchPlaceholder));

  // Next is gated on a selection — two datasets means no preselect.
  const gated = await win.evaluate(() => {
    const next = [...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLButtonElement | null;
    return { disabled: !!next?.disabled, label: (next?.textContent || '').trim() };
  });
  ok('Next is disabled until a dataset is chosen', gated.disabled, `"${gated.label}"`);

  // Search narrows the list, then picking prefills the name.
  const searched = await win.evaluate(() => {
    const s = document.querySelector('.an-wiz-search') as HTMLInputElement;
    s.value = 'Sales';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelectorAll('.an-wiz-row').length;
  });
  ok('search narrows the dataset list', searched === 1, `${searched} row(s) match "Sales"`);

  const picked = await win.evaluate(() => {
    (document.querySelector('.an-wiz-row') as HTMLElement).click();
    const next = [...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLButtonElement | null;
    const nameIn = document.querySelector('.an-wiz-name input') as HTMLInputElement | null;
    return {
      selected: document.querySelectorAll('.an-wiz-row.is-selected').length,
      nextEnabled: !next?.disabled,
      name: nameIn?.value || '',
    };
  });
  ok('picking a dataset selects it and frees Next',
     picked.selected === 1 && picked.nextEnabled, JSON.stringify(picked));
  ok('…and prefills the dashboard name from it', picked.name === 'Sales dashboard', `"${picked.name}"`);

  const wizShot = path.join(shotDir, 'wizard-step1.png');
  await win.screenshot({ path: wizShot });
  ok('wizard step 1 screenshot captured', fs.existsSync(wizShot) && fs.statSync(wizShot).size > 5000,
     `${Math.round(fs.statSync(wizShot).size / 1024)} KB -> ${wizShot}`);

  // Set the name this run asserts on everywhere below, then go to step 2.
  await win.evaluate(() => {
    const nameIn = document.querySelector('.an-wiz-name input') as HTMLInputElement;
    nameIn.value = 'Smoke analysis';
    nameIn.dispatchEvent(new Event('input', { bubbles: true }));
    ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLElement).click();
  });
  await win.waitForTimeout(600);

  // Step 2 — Start from. Layout and AI are ONE step: three real scaffolds plus
  // the AI route, and picking AI is what reveals step 3.
  const wiz2 = await win.evaluate(() => {
    const cards = [...document.querySelectorAll('.an-wiz-start')] as HTMLButtonElement[];
    const note = document.querySelector('.an-wiz-note') as HTMLElement | null;
    const next = [...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLButtonElement | null;
    const rail = [...document.querySelectorAll('.an-wiz-step')];
    return {
      count: cards.length,
      titles: [...document.querySelectorAll('.an-wiz-start-t')].map((t) => (t.textContent || '').trim()),
      doneTick: (document.querySelector('.an-wiz-step.is-done .an-wiz-dot')?.textContent || '').trim(),
      // Blank is the default, so the step is answerable by pressing Enter.
      selected: [...document.querySelectorAll('.an-wiz-start.is-selected .an-wiz-start-t')]
        .map((t) => (t.textContent || '').trim()),
      // No model in a smoke run: the AI CARD is the gate, and it says why.
      aiDisabled: !!cards.find((c) => c.dataset.kind === 'ai')?.disabled,
      othersEnabled: cards.filter((c) => c.dataset.kind !== 'ai').every((c) => !c.disabled),
      noteVisible: !!note && note.offsetParent !== null,
      noteText: (note?.textContent || '').trim().slice(0, 80),
      // Nothing left to ask on the three non-AI routes, so step 2 finishes.
      nextLabel: (next?.textContent || '').trim(),
      nextDisabled: !!next?.disabled,
      // Step 3 is dimmed, not hidden — the rail must not reflow on every choice.
      step3Skipped: rail.length === 3 && rail[2].classList.contains('is-skipped'),
      // Skip belongs to step 3 only; on step 2 the primary button IS the finish.
      skipVisible: !!([...document.querySelectorAll('.an-wiz-foot .btn')]
        .find((b) => /Skip/.test(b.textContent || '')) as HTMLElement | undefined)?.offsetParent,
      backVisible: !!([...document.querySelectorAll('.an-wiz-foot .btn')]
        .find((b) => /Back/.test(b.textContent || '')) as HTMLElement | undefined)?.offsetParent,
    };
  });
  ok('step 2 offers four ways to start',
     wiz2.count === 4 &&
       JSON.stringify(wiz2.titles) ===
         JSON.stringify(['Blank sheet', 'KPIs + chart', 'Two-up', '✨ Let AI design it']),
     JSON.stringify(wiz2.titles));
  ok('…step 1 is ticked off behind it', wiz2.doneTick === '✓', `"${wiz2.doneTick}"`);
  ok('…Blank is preselected, so the step answers itself',
     JSON.stringify(wiz2.selected) === JSON.stringify(['Blank sheet']), JSON.stringify(wiz2.selected));
  ok('…with no model, ONLY the AI card is disabled, and it says why',
     wiz2.aiDisabled && wiz2.othersEnabled && wiz2.noteVisible && /No model is configured/.test(wiz2.noteText),
     wiz2.noteText);
  ok('…and step 3 is dimmed rather than removed', wiz2.step3Skipped);
  ok('…a non-AI route finishes here, so the button says Create',
     wiz2.nextLabel === 'Create dashboard' && !wiz2.nextDisabled, `"${wiz2.nextLabel}"`);
  ok('…Skip is not offered on this step (the primary button is the finish)', !wiz2.skipVisible);
  ok('…and Back is offered', wiz2.backVisible);

  const wizShot2 = path.join(shotDir, 'wizard-step2.png');
  await win.screenshot({ path: wizShot2 });
  ok('wizard step 2 screenshot captured', fs.existsSync(wizShot2) && fs.statSync(wizShot2).size > 5000,
     `${Math.round(fs.statSync(wizShot2).size / 1024)} KB -> ${wizShot2}`);

  // ── The AI route, forced ──────────────────────────────────────────────────
  // With no model the AI card is disabled, so step 3 is unreachable and its
  // whole pane — textarea, example chips, the notReady recovery — would ship
  // never having rendered. Enabling the card drives the REAL handlers from
  // there on. This asserts layout and control flow only; it makes no claim
  // about a model being configured, and the notReady assertion below is exactly
  // the proof that none is.
  await win.evaluate(() => {
    const ai = [...document.querySelectorAll('.an-wiz-start')]
      .find((c) => (c as HTMLElement).dataset.kind === 'ai') as HTMLButtonElement;
    ai.disabled = false;
    ai.click();
  });
  await win.waitForTimeout(300);
  const aiPicked = await win.evaluate(() => ({
    label: ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0]?.textContent || '').trim(),
    step3Live: !document.querySelectorAll('.an-wiz-step')[2].classList.contains('is-skipped'),
  }));
  ok('picking the AI card turns step 3 on and the button back to Next',
     aiPicked.label === 'Next' && aiPicked.step3Live, JSON.stringify(aiPicked));

  await win.evaluate(() =>
    ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLElement).click());
  await win.waitForTimeout(400);

  const chips = await win.evaluate(() => {
    const row = document.querySelector('.an-wiz-chips') as HTMLElement | null;
    const ta = document.querySelector('.an-wiz-ta') as HTMLTextAreaElement | null;
    const card = document.querySelector('.an-wiz-ai') as HTMLElement | null;
    if (!row || !ta || !card) return null;
    const btns = [...row.querySelectorAll('.an-wiz-chip')] as HTMLElement[];
    const cr = card.getBoundingClientRect();
    btns[0].click();
    return {
      onStep3: card.offsetParent !== null,
      count: btns.length,
      // Each chip must sit inside the card it belongs to — a long example string
      // in a flex row is exactly what overflows a modal.
      inside: btns.every((b) => {
        const r = b.getBoundingClientRect();
        return r.left >= cr.left - 1 && r.right <= cr.right + 1 && r.height > 0;
      }),
      wrapped: new Set(btns.map((b) => Math.round(b.getBoundingClientRect().top))).size,
      filled: ta.value,
      skipVisible: !!([...document.querySelectorAll('.an-wiz-foot .btn')]
        .find((b) => /Skip/.test(b.textContent || '')) as HTMLElement | undefined)?.offsetParent,
    };
  });
  ok('step 3 is the AI step, and its chips lay out inside the card',
     !!chips && chips.onStep3 && chips.count === 3 && chips.inside, JSON.stringify(chips));
  ok('…clicking a chip fills the prompt box',
     !!chips && chips.filled.startsWith('Show revenue by region'), chips?.filled.slice(0, 44) || '');
  ok('…and Skip appears here, so the AI step is genuinely optional', !!chips?.skipVisible);

  const wizShot3 = path.join(shotDir, 'wizard-step3.png');
  await win.screenshot({ path: wizShot3 });
  ok('wizard step 3 screenshot captured', fs.existsSync(wizShot3) && fs.statSync(wizShot3).size > 5000,
     `${Math.round(fs.statSync(wizShot3).size / 1024)} KB -> ${wizShot3}`);

  // Pressing Draft with no model must not strand the user on a dead step.
  await win.evaluate(() =>
    ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLElement).click());
  await win.waitForTimeout(2500);
  const bounced = await win.evaluate(() => {
    const rail = [...document.querySelectorAll('.an-wiz-step')];
    const note = document.querySelector('.an-wiz-note') as HTMLElement | null;
    return {
      stillOpen: !!document.querySelector('.an-wiz'),
      backOnStep2: rail[1].classList.contains('is-active'),
      noteVisible: !!note && note.offsetParent !== null,
      selected: [...document.querySelectorAll('.an-wiz-start.is-selected .an-wiz-start-t')]
        .map((t) => (t.textContent || '').trim()),
    };
  });
  ok('drafting with no model returns to step 2 rather than stranding the user',
     bounced.stillOpen && bounced.backOnStep2 && bounced.noteVisible, JSON.stringify(bounced));
  ok('…and re-selects a route that can still finish',
     JSON.stringify(bounced.selected) === JSON.stringify(['Blank sheet']), JSON.stringify(bounced.selected));

  // Finish on Blank — the downstream assertions expect exactly one empty sheet.
  await win.evaluate(() =>
    ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLElement).click());
  await win.waitForTimeout(2000);
  ok('Create dashboard creates it and closes the wizard',
     await win.evaluate(() => !document.querySelector('.an-wiz')));

  // The editor must be INSIDE the Dashboards panel (id #ws-analyses internally),
  // in analysis mode, and — the check a DOM assertion cannot make — actually
  // have a box on screen.
  const anEditor = await win.evaluate(() => {
    const ed = document.getElementById('dash-editor');
    if (!ed) return null;
    const r = ed.getBoundingClientRect();
    return {
      inAnalysesPanel: !!ed.closest('#ws-analyses'),
      analysisMode: ed.classList.contains('dash-editor--analysis'),
      w: Math.round(r.width),
      h: Math.round(r.height),
      // The head strip is the ONE add path — the rail's + pane went away with the
      // Analyses-v2 dialogs, and removing it meant un-hiding these.
      addVisualVisible:
        (document.getElementById('dash-add-visual') as HTMLElement | null)?.offsetParent != null,
      addAllVisible: ['dash-add-visual', 'dash-add-metric', 'dash-add-text']
        .every((id) => (document.getElementById(id) as HTMLElement | null)?.offsetParent != null),
      // Rename stays off the strip: the dashboard NAME is the rename control.
      stripLean: (document.getElementById('dash-rename-btn') as HTMLElement | null)?.offsetParent == null,
      moreVisible: (document.getElementById('an-more-btn') as HTMLElement | null)?.offsetParent != null,
      sheetTabs: document.querySelectorAll('#dash-pages .dash-page-tab').length,
      // Clear-all is hidden until a filter exists (asserted by VISIBILITY, since
      // `hidden` on a .btn only wins with hub.css's `.btn[hidden]`).
      clearFiltersVisible: (document.getElementById('dash-clear-filters') as HTMLElement | null)?.offsetParent != null,
    };
  });
  ok('the dashboard editor opened inside the panel',
     !!anEditor && anEditor.inAnalysesPanel && anEditor.analysisMode,
     JSON.stringify(anEditor));
  ok('the dashboard editor has a real box (not zero-height)',
     !!anEditor && anEditor.w > 200 && anEditor.h > 200, `${anEditor?.w}x${anEditor?.h}`);
  ok('the three add buttons are offered on the dashboard',
     !!anEditor && anEditor.addVisualVisible && anEditor.addAllVisible);
  ok('…and the strip sheds Rename (the name is the rename control) but keeps ⋯',
     !!anEditor && anEditor.stripLean && anEditor.moreVisible,
     JSON.stringify({ lean: anEditor?.stripLean, more: anEditor?.moreVisible }));
  ok('the dashboard opens with one sheet', anEditor?.sheetTabs === 1, String(anEditor?.sheetTabs));
  ok('Clear-all stays hidden until there is a filter',
     !!anEditor && !anEditor.clearFiltersVisible, JSON.stringify({ clearFilters: anEditor?.clearFiltersVisible }));

  // Add the saved visual as a card, through the picker — a GALLERY of tiles
  // now, not a name list, with the two create actions above it.
  ok('+ Visual opens the picker', await clickId('dash-add-visual'));
  await win.waitForTimeout(500);
  ok('the picker is a gallery with the create actions above it',
     await win.evaluate(() => {
       const tiles = document.querySelectorAll('.vn-pick-modal .vn-pick-tile').length;
       const labels = [...document.querySelectorAll('.vn-pick-modal .vn-pick-actions .btn')]
         .map((b) => (b.textContent || '').trim());
       return tiles > 0 && labels.indexOf('+ New visual') >= 0
         && labels.some((l) => /Suggest with AI/.test(l));
     }));
  ok('the picker adds the saved visual', await win.evaluate(() => {
    const tile = document.querySelector('.vn-pick-modal .vn-pick-tile') as HTMLElement | null;
    if (!tile) return false;
    tile.click();
    return true;
  }));
  await win.waitForTimeout(3000); // render + the 600 ms debounced autosave

  const cardCount = await win.evaluate(() => document.querySelectorAll('#dash-grid .dash-card').length);
  ok('the card lands on the sheet grid', cardCount === 1, String(cardCount));

  // ── Freshness in the analysis header ─────────────────────────────────────
  // The sheet reads one dataset here, so the header must agree with it. The
  // OLDEST rule is what matters and it is asserted directly below, on the
  // dataset ids the sheet actually resolves rather than on wall-clock text.
  const sheetFresh = await win.evaluate(() => {
    const label = document.getElementById('dash-fresh') as HTMLElement | null;
    const btn = document.getElementById('dash-refresh-data') as HTMLElement | null;
    return {
      text: (label?.textContent || '').trim(),
      labelShown: !!label && !label.hidden,
      btnShown: !!btn && !btn.hidden,
    };
  });
  ok('the analysis header reports the freshness of the data it reads',
     sheetFresh.labelShown && /^Data as of /.test(sheetFresh.text), JSON.stringify(sheetFresh));
  // The one card reads the 'Sales' dataset, which was saved with no origin, so
  // there is nothing to refresh and the button must not pretend otherwise.
  ok('…and offers no Refresh data button when nothing on the sheet is refreshable',
     !sheetFresh.btnShown, JSON.stringify(sheetFresh));

  // THE rule: a sheet is only as fresh as its STALEST input. Add a second card
  // reading the backdated 'By state' dataset — the header must follow the 2020
  // stamp, not the one written seconds ago. "Newest" would read as today's time
  // here, which is wrong in the direction that matters: it would tell someone
  // their figures are current when half of them are years old.
  await win.evaluate((vid) => {
    (window as any).pushCard({
      id: window.crypto.randomUUID(),
      type: 'visual',
      visualId: vid,
      layout: { x: 0, y: 8, w: 6, h: 6 },
    });
  }, r.visualId);
  await win.waitForTimeout(3000);
  const twoFresh = await win.evaluate(() => ({
    text: (document.getElementById('dash-fresh')?.textContent || '').trim(),
    title: (document.getElementById('dash-fresh') as HTMLElement | null)?.title || '',
    cards: document.querySelectorAll('#dash-grid .dash-card').length,
  }));
  // The 2020 stamp renders through formatSidebarTime as "Mar 4 · <time>".
  ok('a sheet reading two datasets reports the OLDEST of them, not the newest',
     twoFresh.cards === 2 && /Mar 4/.test(twoFresh.text), JSON.stringify(twoFresh));
  ok('…and says why, so a header that disagrees with one row is explicable',
     /oldest of the 2 datasets/.test(twoFresh.title), `"${twoFresh.title}"`);

  // ── The authoring workbench ───────────────────────────────────────────────
  // At REST the user sees the top strip, the rail and the sheet — nothing else.
  // Asserted from a laid-out page: a panel that renders at zero width, a well
  // that never accepts a drop, and a CSP-blocked drag indicator all pass any
  // check made elsewhere.
  const openPane = async (pane: string): Promise<void> => {
    await win.evaluate((p) => {
      const btn = document.querySelector('#an-rail .an-rail-btn[data-pane="' + p + '"]') as HTMLElement | null;
      if (btn && !btn.classList.contains('is-on')) btn.click();
    }, pane);
    await win.waitForTimeout(120);
  };
  const openProps = async (): Promise<void> => {
    await win.evaluate(() => {
      const pane = document.getElementById('an-pane-props') as HTMLElement | null;
      if (!pane || !pane.hidden) return;
      (document.querySelector('#dash-grid .dash-card .an-card-props') as HTMLElement | null)?.click();
    });
    await win.waitForTimeout(200);
  };

  const bench = await win.evaluate(() => {
    const host = document.getElementById('an-editor-host') as HTMLElement | null;
    const left = document.getElementById('an-side-left') as HTMLElement | null;
    const right = document.getElementById('an-side-right') as HTMLElement | null;
    const rail = document.getElementById('an-rail') as HTMLElement | null;
    const ed = document.getElementById('dash-editor') as HTMLElement | null;
    const r = (el: HTMLElement | null) => (el ? el.getBoundingClientRect() : null);
    const N = r(rail), E = r(ed);
    return {
      active: !!host?.classList.contains('is-active'),
      // Closed at rest — and a closed panel must take NO width, or the rail
      // bought nothing.
      leftShut: !left || left.offsetParent === null,
      // The right-hand column was DELETED, not hidden — Properties is a rail
      // flyout now. Asserting absence, because a hidden-but-present panel still
      // binds to a card and still writes.
      rightGone: !right,
      railW: Math.round(N?.width || 0),
      // Source order is rail, flyouts, editor — `order` is what puts the sheet
      // after the rail, so this asserts the CSS actually applied.
      inOrder: !!(N && E) && N.left < E.left,
      // The sheet gets nearly the whole window minus the rail.
      sheetW: Math.round(E?.width || 0),
      winW: window.innerWidth,
    };
  });
  // Focus mode: an open analysis owns the window, so the project nav is gone —
  // the reference has no nav while you author, and four columns competing for
  // the width is what made this read as stuffed.
  const focus = await win.evaluate(() => {
    const nav = document.getElementById('workspace-nav') as HTMLElement | null;
    const head = document.querySelector('.dash-editor-head') as HTMLElement | null;
    const kids = head ? [...head.children] as HTMLElement[] : [];
    const tops = new Set(kids.filter((k) => k.offsetParent !== null)
      .map((k) => Math.round(k.getBoundingClientRect().top)));
    return {
      focusOn: document.body.classList.contains('an-focus'),
      navHidden: !nav || nav.offsetParent === null,
      // "One row" is the HEAD's height, not the children's top edges —
      // align-items:center gives items of different heights different tops
      // while they share a row, which is what this first (wrongly) measured.
      headH: Math.round(head?.getBoundingClientRect().height || 0),
      headRows: tops.size,
      backOffered: kids.some((k) => /Back/.test(k.textContent || '') && k.offsetParent !== null),
    };
  });
  ok('an open analysis takes the window, and the project nav steps aside',
     focus.focusOn && focus.navHidden, JSON.stringify(focus));
  ok('…its toolbar stays on one row', focus.headH > 0 && focus.headH <= 50,
     `head is ${focus.headH}px tall (one row of 26px buttons + padding)`);
  ok('…with Back as the way out, since the nav is gone', focus.backOffered);

  ok('the workbench is a rail beside the sheet, in the right order',
     bench.active && bench.inOrder && bench.railW > 30 && bench.railW < 70,
     JSON.stringify(bench));
  ok('…with the flyout shut at rest, so the sheet has the window',
     bench.leftShut && bench.rightGone && bench.sheetW > bench.winW - 90,
     JSON.stringify({ left: bench.leftShut, rightGone: bench.rightGone,
                      sheet: bench.sheetW, win: bench.winW }));

  // PROBLEM 1: the strip has to span the WINDOW, not just the canvas. It used to
  // live inside #dash-editor — the centre column — so it started to the right of
  // an open flyout and read as a third column header. Measured with a flyout
  // OPEN, because that is the only state where the bug is visible.
  await openPane('an-pane-data');
  const strip = await win.evaluate(() => {
    const head = document.querySelector('.dash-editor-head') as HTMLElement | null;
    const rail = document.getElementById('an-rail') as HTMLElement | null;
    const side = document.getElementById('an-side-left') as HTMLElement | null;
    const H = head?.getBoundingClientRect();
    const R = rail?.getBoundingClientRect();
    const S = side?.getBoundingClientRect();
    return {
      // Outside the editor, above the workbench.
      outsideEditor: !document.querySelector('#dash-editor .dash-editor-head'),
      w: Math.round(H?.width || 0),
      winW: window.innerWidth,
      // Starts at the window's left edge, not after the rail or the flyout…
      startsAtEdge: !!H && H.left <= 2,
      // …and sits ABOVE both of them.
      aboveRail: !!(H && R) && H.bottom <= R.top + 1,
      aboveFlyout: !!(H && S) && H.bottom <= S.top + 1,
    };
  });
  ok('the top strip spans the full window, above the rail and the flyout',
     strip.outsideEditor && strip.w > strip.winW - 4 && strip.startsAtEdge &&
       strip.aboveRail && strip.aboveFlyout, JSON.stringify(strip));
  // Leave it as we found it — the at-rest screenshot below wants nothing open.
  await win.evaluate(() =>
    (document.querySelector('#an-rail .an-rail-btn.is-on') as HTMLElement | null)?.click());
  await win.waitForTimeout(120);

  // The resting state is the claim this whole surface makes — top strip, rail,
  // sheet, nothing else — so photograph it before anything opens a flyout.
  const restShot = path.join(shotDir, 'analysis-at-rest.png');
  await win.screenshot({ path: restShot });
  ok('analysis at-rest screenshot captured',
     fs.existsSync(restShot) && fs.statSync(restShot).size > 5000,
     `${Math.round(fs.statSync(restShot).size / 1024)} KB -> ${restShot}`);

  // ── The tool rail ─────────────────────────────────────────────────────────
  // Icon-only chrome is where dead controls hide: nothing labels them, so a
  // button wired to nothing looks identical to one that works. Assert every
  // icon has an accessible name AND a hover title, and that each really opens
  // its panel.
  const rail = await win.evaluate(() => {
    const r = document.getElementById('an-rail') as HTMLElement | null;
    const btns = [...(r?.querySelectorAll('.an-rail-btn') || [])] as HTMLButtonElement[];
    return {
      visible: !!r && r.offsetParent !== null,
      panes: btns.map((b) => b.dataset.pane),
      allLabelled: btns.every((b) => !!b.getAttribute('aria-label') && !!b.getAttribute('title')),
      allSvg: btns.every((b) => !!b.querySelector('svg')),
    };
  });
  ok('the tool rail is on screen, every icon named, titled and drawn',
     rail.visible && rail.allLabelled && rail.allSvg &&
       JSON.stringify(rail.panes) ===
         JSON.stringify(['an-pane-data', 'an-pane-visuals', 'an-pane-filter', 'an-pane-props']),
     JSON.stringify(rail));

  // ONE flyout at a time, and clicking the lit icon closes it. That is the
  // whole point of the rail — two panels stacked is what it replaced.
  await openPane('an-pane-data');
  const flyout = await win.evaluate(() => {
    const shown = () => ['an-pane-data', 'an-pane-visuals', 'an-pane-filter', 'an-pane-props']
      .filter((id) => (document.getElementById(id) as HTMLElement | null)?.offsetParent != null);
    const afterData = shown();
    (document.querySelector('#an-rail .an-rail-btn[data-pane="an-pane-visuals"]') as HTMLElement).click();
    const afterVisuals = shown();
    (document.querySelector('#an-rail .an-rail-btn[data-pane="an-pane-visuals"]') as HTMLElement).click();
    const afterClose = shown();
    const sideShut = (document.getElementById('an-side-left') as HTMLElement | null)?.offsetParent == null;
    return { afterData, afterVisuals, afterClose, sideShut };
  });
  ok('the rail opens exactly one panel, and the next one replaces it',
     JSON.stringify(flyout.afterData) === JSON.stringify(['an-pane-data']) &&
       JSON.stringify(flyout.afterVisuals) === JSON.stringify(['an-pane-visuals']),
     JSON.stringify(flyout));
  ok('…and clicking the lit icon closes the flyout entirely',
     flyout.afterClose.length === 0 && flyout.sideShut, JSON.stringify(flyout.afterClose));

  // The one add path: the head strip's + Text opens its modal directly. (The
  // rail's + pane, which used to delegate to it, no longer exists.)
  const headAdd = await win.evaluate(() => {
    (document.getElementById('dash-add-text') as HTMLElement).click();
    const opened = [...document.querySelectorAll('.ws-modal-overlay')]
      .filter((o) => (o as HTMLElement).getClientRects().length > 0);
    const open = opened.length > 0;
    // Remove only what this click created. The import dialog is part of the
    // page and removing it would break every later import.
    opened.forEach((o) => o.remove());
    return open;
  });
  ok('…and the head strip\'s + Text opens its add-card modal', headAdd);

  // The analysis-wide filter bar really MOVED into the Filters flyout — it is
  // one element with two hosts, so a copy left behind would be a second, dead
  // filter row on the sheet.
  await openPane('an-pane-filter');
  const filterPane = await win.evaluate(() => ({
    inFlyout: !!document.querySelector('#an-filter-body .dash-toolbar'),
    onSheet: !!document.querySelector('#dash-editor > .dash-toolbar'),
    addFilterVisible:
      (document.getElementById('dash-add-filter') as HTMLElement | null)?.offsetParent != null,
  }));
  ok('the filter bar moved into the Filters flyout, leaving none on the sheet',
     filterPane.inFlyout && !filterPane.onSheet && filterPane.addFilterVisible,
     JSON.stringify(filterPane));

  // Nothing is selected yet, so the panels must say so rather than show a stale
  // or half-bound state.
  await openPane('an-pane-data');
  const unboundData = await win.evaluate(() =>
    (document.getElementById('an-data-hint') as HTMLElement)?.offsetParent !== null);
  await openPane('an-pane-props');
  const unboundViz = await win.evaluate(() =>
    (document.getElementById('an-props-inner') as HTMLElement)?.offsetParent == null);
  ok('with nothing selected, the panels say so', unboundData && unboundViz,
     JSON.stringify({ dataHint: unboundData, propsInnerHidden: unboundViz }));

  // SELECT the card. This is the whole binding.
  await win.evaluate(() => (document.querySelector('#dash-grid .dash-card') as HTMLElement).click());
  // Wait for the CHIP ROW as well as the field list. They arrive on separate
  // async paths — the fields as soon as the dataset's columns load, the chips
  // only once the visual's data has been computed in main — so waiting on the
  // fields alone left `bound.chips` a race. It read 0 on a CI runner while
  // passing on a dev machine, and because this single snapshot is asserted
  // again 150 and 480 lines below, the flake surfaced far from its cause.
  await win.waitForFunction(
    () => document.querySelectorAll('#an-fields .an-field').length > 0
      && document.querySelectorAll('#an-switcher .an-typerow').length > 0,
    undefined,
    { timeout: 30_000 },
  ).catch(() => {}); // fall through; the assertions below report what is there
  const bound = await win.evaluate(() => {
    const fields = [...document.querySelectorAll('#an-fields .an-field')] as HTMLElement[];
    const wells = [...document.querySelectorAll('#an-wells [data-well]')] as HTMLElement[];
    return {
      selectedCards: document.querySelectorAll('#dash-grid .dash-card.is-selected').length,
      fields: fields.map((f) => f.dataset.column),
      allDraggable: fields.every((f) => f.draggable),
      wells: wells.map((w) => w.dataset.well),
      wellsVisible: wells.every((w) => w.offsetParent !== null),
      chips: document.querySelectorAll('#an-switcher .an-typerow').length,
      propsRows: document.querySelectorAll('#an-props .an-sec').length,
      title: (document.querySelector('#an-props .an-prop-input') as HTMLInputElement)?.value || '',
    };
  });
  ok('clicking a card selects exactly one', bound.selectedCards === 1, String(bound.selectedCards));
  ok('…and the Data panel lists that visual\'s dataset columns, all draggable',
     JSON.stringify(bound.fields) === JSON.stringify(['state', 'revenue']) && bound.allDraggable,
     JSON.stringify(bound.fields));
  ok('…the wells are mounted and visible',
     JSON.stringify(bound.wells) === JSON.stringify(['category', 'values', 'series', 'filters']) &&
       bound.wellsVisible, JSON.stringify(bound.wells));

  // DRAG NEEDS BOTH ENDS. The field list is the drag source and the wells are
  // the drop target; only one flyout is open, so the list has to have MOVED into
  // the PROPERTIES pane, which is where the wells now live. Asserted by geometry,
  // not by parentage: a list in the right node but painting at zero height is
  // still undraggable.
  const dragReach = await win.evaluate(() => {
    const f = document.querySelector('#an-fields .an-field') as HTMLElement | null;
    const w = document.querySelector('#an-wells [data-well="values"]') as HTMLElement | null;
    return {
      inProps: !!document.querySelector('#an-props-fields #an-fields'),
      // Exactly one field list in the DOM — moved, not copied.
      lists: document.querySelectorAll('#an-fields').length,
      fieldBox: Math.round(f?.getBoundingClientRect().height || 0),
      wellBox: Math.round(w?.getBoundingClientRect().height || 0),
      // The fields sit above the wells, which is what makes the drag a short one.
      above: !!(f && w) && f.getBoundingClientRect().top < w.getBoundingClientRect().top,
      calcTravelled: !!document.querySelector('#an-props-fields #an-calc-btn'),
    };
  });
  ok('…and the field list moved in beside them, so a field can be dragged to a well',
     dragReach.inProps && dragReach.lists === 1 && dragReach.fieldBox > 0 &&
       dragReach.wellBox > 0 && dragReach.above && dragReach.calcTravelled,
     JSON.stringify(dragReach));

  // TABS: what it PLOTS (Build) and how it LOOKS (Format). Exactly one panel is
  // on screen at a time — a "tab" that leaves both mounted is just a heading.
  const tabs = await win.evaluate(() => {
    const has = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      return !!el && el.offsetParent !== null;
    };
    const strip = [...document.querySelectorAll('#an-tabs .an-tab')] as HTMLElement[];
    const before = {
      labels: strip.map((t) => (t.textContent || '').trim()),
      // Announceable without icons: role, aria-selected and aria-controls.
      roles: strip.every((t) => t.getAttribute('role') === 'tab' && !!t.getAttribute('aria-controls')),
      listRole: document.getElementById('an-tabs')?.getAttribute('role'),
      buildOn: has('#an-tabp-build .an-wells'),
      formatOff: !has('#an-tabp-format .an-props'),
      selBuild: strip[0]?.getAttribute('aria-selected'),
    };
    // Switch to Format.
    strip[1].click();
    return {
      ...before,
      afterBuildOff: !has('#an-tabp-build .an-wells'),
      afterFormatOn: has('#an-tabp-format .an-props'),
      selFormat: strip[1].getAttribute('aria-selected'),
      stored: localStorage.getItem('anPropsTab'),
    };
  });
  ok('Properties is a tab strip — Build / Format / Interactions, none named after its container',
     JSON.stringify(tabs.labels) === JSON.stringify(['Build', 'Format', 'Interactions']) &&
       tabs.listRole === 'tablist' && tabs.roles, JSON.stringify(tabs));
  ok('…and exactly one panel is mounted at a time, with aria following',
     tabs.buildOn && tabs.formatOff && tabs.afterBuildOff && tabs.afterFormatOn &&
       tabs.selBuild === 'true' && tabs.selFormat === 'true', JSON.stringify(tabs));

  // The active tab must survive re-binding — clicking a different card cannot
  // throw you back to Build mid-edit. Format is open from the switch above.
  await win.evaluate(() => (document.querySelector('#dash-grid .dash-card') as HTMLElement).click());
  await win.waitForTimeout(900);
  const tabKept = await win.evaluate(() => ({
    stillFormat: (document.getElementById('an-tabp-format') as HTMLElement)?.offsetParent !== null,
    lit: (document.querySelector('#an-tabs .an-tab.is-on') as HTMLElement | null)?.textContent?.trim(),
  }));
  ok('…and the active tab survives re-selecting a card', tabKept.stillFormat &&
     tabKept.lit === 'Format', JSON.stringify(tabKept));
  // Back to Build: everything below measures the wells.
  await win.evaluate(() => (document.getElementById('an-tab-build') as HTMLElement).click());
  await win.waitForTimeout(150);

  // Click-to-fill targets the next EMPTY well, so the feature never depends on
  // drag. Checked as a pure mapping against the live encoding (category filled,
  // Split by empty) rather than by clicking, which would mutate the shared visual
  // every later map assertion reads.
  const nextWell = await win.evaluate(() => ({
    enc: (window as any).anNextWell ? 'wired' : 'missing',
    text: (window as any).anNextWell('text'),
    number: (window as any).anNextWell('number'),
  }));
  ok('a clicked field targets the next empty well, by type',
     nextWell.text === 'series' && nextWell.number === 'values', JSON.stringify(nextWell));

  // ── The Visuals gallery ───────────────────────────────────────────────────
  // Built from the SAME vocabulary as the result-view picker, with the same
  // app-computed eligibility. Recommended tiles sort first and are marked.
  await openPane('an-pane-visuals');
  const gallery = await win.evaluate(() => {
    const tiles = [...document.querySelectorAll('#an-gallery .an-tile')] as HTMLElement[];
    const recIdx = tiles.map((t, i) => (t.classList.contains('is-rec') ? i : -1)).filter((i) => i >= 0);
    const plainIdx = tiles.map((t, i) => (t.classList.contains('is-rec') ? -1 : i)).filter((i) => i >= 0);
    return {
      count: tiles.length,
      allNamed: tiles.every((t) => !!t.querySelector('.an-tile-name')?.textContent),
      allDrawn: tiles.every((t) => !!t.querySelector('.an-tile-ic svg')),
      recommended: recIdx.length,
      // Recommended first: every recommended index below every plain one.
      recFirst: recIdx.length === 0 || plainIdx.length === 0 ||
        Math.max(...recIdx) < Math.min(...plainIdx),
      active: (document.querySelector('#an-gallery .an-tile.is-active .an-tile-name') as HTMLElement | null)
        ?.textContent || '',
    };
  });
  ok('the Visuals gallery is a grid of named, drawn type tiles',
     gallery.count > 20 && gallery.allNamed && gallery.allDrawn, JSON.stringify(gallery));
  ok('…with the app-recommended types marked and sorted first, and the current one active',
     gallery.recommended > 0 && gallery.recFirst && !!gallery.active, JSON.stringify(gallery));

  const galleryShot = path.join(shotDir, 'visuals-gallery.png');
  await win.screenshot({ path: galleryShot });
  ok('visuals gallery screenshot captured',
     fs.existsSync(galleryShot) && fs.statSync(galleryShot).size > 5000,
     `${Math.round(fs.statSync(galleryShot).size / 1024)} KB -> ${galleryShot}`);

  // Clicking a tile really retypes the selected card. Restored afterwards: the
  // map assertions 400 lines below read this same visual.
  const retyped = await win.evaluate(async () => {
    const was = (document.querySelector('#an-gallery .an-tile.is-active') as HTMLElement).dataset.type;
    const other = [...document.querySelectorAll('#an-gallery .an-tile')]
      .find((t) => (t as HTMLElement).dataset.type === 'table') as HTMLElement;
    other.click();
    return { was, now: (document.querySelector('#an-gallery .an-tile.is-active') as HTMLElement)?.dataset.type };
  });
  await win.waitForTimeout(1500);
  ok('…and clicking a tile retypes the selected card',
     retyped.was !== 'table' && retyped.now === 'table', JSON.stringify(retyped));
  await win.evaluate((t) => {
    const back = [...document.querySelectorAll('#an-gallery .an-tile')]
      .find((x) => (x as HTMLElement).dataset.type === t) as HTMLElement;
    back?.click();
  }, retyped.was);
  await win.waitForTimeout(1500);
  await openPane('an-pane-props');
  ok('…the chart-type chips render', bound.chips > 0, `${bound.chips} chips`);
  // Exactly ONE chip row. Selecting a card and writing a well edit both rebuild
  // it, and each clears the mount before its await — two in flight left two rows
  // stacked, which every count-based assertion happily passed.
  ok('…as exactly one row, not one per in-flight rebuild',
     await win.evaluate(() => document.querySelectorAll('#an-switcher .an-typerow').length) === 1,
     await win.evaluate(() =>
       String(document.querySelectorAll('#an-switcher .an-typerow').length) + ' row(s)'));
  // Icons, not text chips — this is what made the panel read as rough.
  const icons = await win.evaluate(() => {
    const row = document.querySelector('#an-switcher .an-typerow') as HTMLElement | null;
    return {
      svg: !!row?.querySelector('.an-typerow-ic svg'),
      name: (row?.querySelector('.an-typerow-name')?.textContent || '').trim(),
      labelled: !!row?.getAttribute('aria-label'),
      // The chip row is still in the DOM (it owns the + More panel) but must not
      // be on screen — two chart-type UIs would be the divergence this avoids.
      chipRowHidden: (document.querySelector('#an-switcher .cv-viz-switcher') as HTMLElement | null)
        ?.getBoundingClientRect().width! <= 2,
    };
  });
  ok('…as an icon + the CURRENT type name + a way into the full picker',
     icons.svg && !!icons.name && icons.labelled && icons.chipRowHidden, JSON.stringify(icons));

  // Search fields — a wide dataset is unusable without it. The Data flyout is
  // the BROWSE render now (its own list, its own search); the canonical,
  // draggable list lives in Properties. Both filter; each is asserted where it
  // lives.
  await openPane('an-pane-data');
  const search = await win.evaluate(() => {
    const box = document.getElementById('an-browse-search') as HTMLInputElement;
    const before = document.querySelectorAll('#an-browse .an-field').length;
    box.value = 'rev';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const after = document.querySelectorAll('#an-browse .an-field').length;
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return { visible: box.offsetParent !== null, before, after,
             restored: document.querySelectorAll('#an-browse .an-field').length,
             // Browse items assign on click but do NOT drag — the wells are in
             // the other flyout, so a drag from here reaches nothing.
             browseDraggable: [...document.querySelectorAll('#an-browse .an-field')]
               .some((f) => (f as HTMLElement).draggable) };
  });
  ok('the Data panel searches its fields',
     search.visible && search.after < search.before && search.restored === search.before,
     JSON.stringify(search));
  ok('…and its browse items are click-to-assign, not draggable', search.browseDraggable === false);

  const propsSearch = await win.evaluate(() => {
    (document.querySelector('#an-rail .an-rail-btn[data-pane="an-pane-props"]') as HTMLElement).click();
    const box = document.getElementById('an-field-search') as HTMLInputElement;
    const before = document.querySelectorAll('#an-fields .an-field').length;
    box.value = 'rev';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const after = document.querySelectorAll('#an-fields .an-field').length;
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return { visible: box.offsetParent !== null, before, after,
             restored: document.querySelectorAll('#an-fields .an-field').length };
  });
  ok('the Properties field list searches too',
     propsSearch.visible && propsSearch.after < propsSearch.before
       && propsSearch.restored === propsSearch.before,
     JSON.stringify(propsSearch));
  await openPane('an-pane-data');

  // Properties is closed until a card's ⚙ asks for it — the gear IS the only
  // way in, so opening it here also asserts that button is wired.
  await openProps();
  const propsOpened = await win.evaluate(() =>
    (document.getElementById('an-pane-props') as HTMLElement | null)?.offsetParent != null);
  ok('the ⚙ on a card opens the Properties panel', propsOpened);

  // The formatting controls live in the FORMAT tab, so open it — measuring a
  // panel that is in the DOM but not on screen proves nothing about it.
  await win.evaluate(() => (document.getElementById('an-tab-format') as HTMLElement).click());
  await win.waitForTimeout(150);
  const formatVisible = await win.evaluate(() =>
    (document.querySelector('#an-tabp-format .an-props') as HTMLElement | null)?.offsetParent != null);
  ok('…on the Format tab, which is where the formatting controls are', formatVisible);

  // Format is a list of disclosure sections, not a flat form.
  const secs = await win.evaluate(() => {
    const heads = [...document.querySelectorAll('#an-props .an-sec-head')] as HTMLElement[];
    const first = heads[0];
    const openBefore = !!first?.closest('.an-sec')?.classList.contains('is-open');
    first?.click();
    return {
      titles: heads.map((h) => (h.lastElementChild?.textContent || '').trim()),
      openBefore,
      openAfter: !!first?.closest('.an-sec')?.classList.contains('is-open'),
      aria: first?.getAttribute('aria-expanded'),
    };
  });
  // The sections must be backed by REAL overrides, not styled placeholders: a
  // control that writes nothing looks identical to one that works.
  const props = await win.evaluate(() => {
    const box = document.getElementById('an-props') as HTMLElement;
    const legend = [...box.querySelectorAll('.an-prop-check')]
      .find((l) => /Show legend/.test(l.textContent || ''))?.querySelector('input') as HTMLInputElement | null;
    const before = legend?.checked;
    legend?.click();
    return {
      titleBound: (box.querySelector('.an-prop-input') as HTMLInputElement)?.value || '',
      hadLegend: !!legend,
      toggled: legend?.checked !== before,
    };
  });
  ok('Display settings binds to the visual and to a real override',
     !!props.titleBound && props.hadLegend && props.toggled, JSON.stringify(props));
  await win.waitForTimeout(1800);
  // The write reaches the record the chart draws from — asserted through main,
  // not through the DOM that set it.
  // Read the SAVED record from main, not from the renderer that wrote it — and
  // via app.evaluate, because `currentProjectId` is a top-level `let` in a
  // classic script and therefore lives in the global lexical environment, not on
  // `window`. Reaching for window.currentProjectId silently yields undefined,
  // which is what made this first report "not saved" for a write that worked.
  const persisted = await app.evaluate(async (_electron, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const visuals = req('./src/analysis/visuals.js');
    const v = await visuals.getVisual(arg.projectId, arg.visualId);
    return { hasOverrides: !!v && !!v.overrides, showLegend: v && v.overrides && v.overrides.showLegend };
  }, { projectId: r.projectId, visualId: r.mapVisualId });
  ok('…and that override is saved on the visual',
     !!persisted && persisted.hasOverrides && persisted.showLegend === false,
     JSON.stringify(persisted));
  // Put it back so later assertions see the resting state.
  await win.evaluate(() => {
    const l = [...document.querySelectorAll('#an-props .an-prop-check')]
      .find((x) => /Show legend/.test(x.textContent || ''))?.querySelector('input') as HTMLInputElement | null;
    l?.click();
  });
  await win.waitForTimeout(1500);

  ok('Properties is a list of collapsible sections',
     secs.titles.length >= 2 && secs.titles[0] === 'Display settings' &&
       secs.openBefore && !secs.openAfter && secs.aria === 'false' &&
       secs.titles.includes('Axes'),
     JSON.stringify(secs));
  await win.evaluate(() =>
    (document.querySelector('#an-props .an-sec-head') as HTMLElement)?.click());

  // ── The Interactions tab ──────────────────────────────────────────────────
  // The tab has to hold REAL behaviour, not disabled placeholders — so assert
  // the controls exist, are enabled, and that toggling one reaches the SAVED
  // visual through main. A tab of dead switches is worse than no tab.
  await win.evaluate(() => (document.getElementById('an-tab-interact') as HTMLElement).click());
  await win.waitForTimeout(200);
  const interact = await win.evaluate(() => {
    const host = document.getElementById('an-interact') as HTMLElement;
    const boxes = [...host.querySelectorAll('.an-prop-check input')] as HTMLInputElement[];
    return {
      visible: host.offsetParent !== null,
      count: boxes.length,
      labels: [...host.querySelectorAll('.an-prop-check')].map((l) => (l.textContent || '').trim()),
      allEnabled: boxes.every((b) => !b.disabled),
      // Defaults: cross-filter OFF (a click that silently refilters every card is
      // a surprise), tooltips ON (every chart before this key had them).
      crossOff: boxes[0] && boxes[0].checked === false,
      tipsOn: boxes[1] && boxes[1].checked === true,
    };
  });
  ok('the Interactions tab holds real, enabled controls',
     interact.visible && interact.count === 2 && interact.allEnabled, JSON.stringify(interact));
  ok('…defaulting to cross-filter off and tooltips on',
     interact.crossOff && interact.tipsOn, JSON.stringify(interact));

  const interactShot = path.join(shotDir, 'interactions-tab.png');
  await win.screenshot({ path: interactShot });
  ok('interactions tab screenshot captured',
     fs.existsSync(interactShot) && fs.statSync(interactShot).size > 5000,
     `${Math.round(fs.statSync(interactShot).size / 1024)} KB -> ${interactShot}`);

  // Turn cross-filter ON and assert it reaches the record, read back through
  // main — not from the DOM that set it.
  await win.evaluate(() => {
    const b = document.querySelector('#an-interact .an-prop-check input') as HTMLInputElement;
    b.click();
  });
  await win.waitForTimeout(1800);
  const savedInteract = await app.evaluate(async (_electron, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const visuals = req('./src/analysis/visuals.js');
    const v = await visuals.getVisual(arg.projectId, arg.visualId);
    return { crossFilter: v && v.overrides && v.overrides.crossFilter };
  }, { projectId: r.projectId, visualId: r.mapVisualId });
  ok('…and the interaction setting survives sanitizeOverrides into the saved visual',
     savedInteract && savedInteract.crossFilter === true, JSON.stringify(savedInteract));

  // Put it back — later assertions read this same shared visual.
  await win.evaluate(() => {
    const b = document.querySelector('#an-interact .an-prop-check input') as HTMLInputElement;
    b.click();
  });
  await win.waitForTimeout(1800);

  // Back to the wells — everything below measures the encoding form, which now
  // lives in the Properties flyout's BUILD tab.
  await openPane('an-pane-props');
  await win.evaluate(() => (document.getElementById('an-tab-build') as HTMLElement).click());
  await win.waitForTimeout(150);

  // Empty wells must SAY what belongs in them, which is the QuickSight
  // affordance a bare dropdown does not give.
  const zones = await win.evaluate(() => ({
    placeholders: [...document.querySelectorAll('#an-wells .enc-empty')].map((e) => (e.textContent || '').trim()),
    pills: document.querySelectorAll('#an-wells .enc-pill').length,
  }));
  ok('…and an empty well says what belongs in it',
     zones.placeholders.some((t) => /Drop a field here to filter/.test(t)),
     JSON.stringify(zones));

  // The pill has to FIT its field name. At 232px the aggregation select's
  // intrinsic width was winning and clipping "revenue" to "reve" — a bug no
  // count-based assertion sees, so measure the rendered text box instead.
  const pill = await win.evaluate(() => {
    const sel = document.querySelector('#an-wells .enc-pill > .viz-select') as HTMLSelectElement | null;
    if (!sel) return null;
    const span = document.createElement('span');
    span.textContent = sel.options[sel.selectedIndex]?.text || '';
    const cs = getComputedStyle(sel);
    span.style.font = cs.font;
    span.style.position = 'absolute';
    span.style.visibility = 'hidden';
    document.body.appendChild(span);
    const textW = span.getBoundingClientRect().width;
    span.remove();
    return { name: sel.value, textW: Math.ceil(textW), boxW: Math.floor(sel.getBoundingClientRect().width) };
  });
  ok('…and a measure pill is wide enough for its field name',
     !!pill && pill.boxW >= pill.textW, JSON.stringify(pill));

  // EVERY filled well is a pill, not just the JS-rendered ones — Category and
  // Split by were dropdowns while Measures and Filters were pills, which is the
  // inconsistency the reference does not have.
  const singles = await win.evaluate(() => {
    const row = (well: string) =>
      document.querySelector('#an-wells [data-well="' + well + '"]') as HTMLElement | null;
    const cat = row('category');
    const ser = row('series');
    return {
      catPill: (cat?.querySelector('.enc-pill--one .enc-pill-name')?.textContent || '').trim(),
      catSelectHidden: !!(cat?.querySelector('select') as HTMLSelectElement | null)?.hidden,
      // Split by is empty by default, so it must show the placeholder instead.
      serEmpty: (ser?.querySelector('.enc-empty')?.textContent || '').trim(),
      // Category is NOT clearable: a chart with no dimension has nothing to plot.
      catClearable: !!cat?.querySelector('.enc-pill--one .viz-value-del'),
      serClearable: !!ser?.querySelector('.enc-pill--one .viz-value-del'),
    };
  });
  ok('a filled single-value well is a pill, with its select standing down',
     singles.catPill === 'state' && singles.catSelectHidden, JSON.stringify(singles));
  ok('…an empty one says what belongs in it',
     singles.serEmpty === 'Add a dimension', singles.serEmpty);
  ok('…and Category offers no clear, because a chart needs a dimension',
     !singles.catClearable);

  // EXACTLY ONE of {pill | placeholder | select} is visible per single well.
  // Leaving the select up alongside the placeholder painted "None" underneath
  // "Add a dimension" — two controls for one value.
  const doubled = await win.evaluate(() =>
    ['category', 'series'].map((w) => {
      const row = document.querySelector('#an-wells [data-well="' + w + '"]') as HTMLElement;
      const vis = (el: Element | null) => !!el && (el as HTMLElement).offsetParent !== null;
      return {
        well: w,
        showing: [
          vis(row.querySelector('.enc-pill--one')),
          vis(row.querySelector('.enc-empty')),
          vis(row.querySelector('select')),
        ].filter(Boolean).length,
      };
    }));
  ok('…and a single-value well shows exactly one control, never two',
     doubled.every((d) => d.showing === 1), JSON.stringify(doubled));

  // Clicking the pill name reveals the select it stands in for — the pill must
  // not be a dead end.
  const reveal = await win.evaluate(() => {
    const cat = document.querySelector('#an-wells [data-well="category"]') as HTMLElement;
    (cat.querySelector('.enc-pill-name') as HTMLElement).click();
    const sel = cat.querySelector('select') as HTMLSelectElement;
    return { hidden: sel.hidden, focused: document.activeElement === sel };
  });
  ok('…clicking the pill reveals the select behind it', !reveal.hidden && reveal.focused,
     JSON.stringify(reveal));
  // …and the pill steps aside when it does. Leaving both up showed the value
  // twice, which is what the screenshot caught.
  const afterReveal = await win.evaluate(() => {
    const cat = document.querySelector('#an-wells [data-well="category"]') as HTMLElement;
    const vis = (el: Element | null) => !!el && (el as HTMLElement).offsetParent !== null;
    return {
      pill: vis(cat.querySelector('.enc-pill--one')),
      select: vis(cat.querySelector('select')),
    };
  });
  ok('…and the pill steps aside rather than stacking with it',
     !afterReveal.pill && afterReveal.select, JSON.stringify(afterReveal));
  // Put the pill back so the screenshot below shows the resting state.
  await win.evaluate(() => (document.querySelector('#an-wells [data-well="category"] select') as HTMLElement)?.blur());
  await win.waitForTimeout(300);

  // ── AI in the Visuals panel (phase D) ─────────────────────────────────────
  // The point of this block is the SEPARATION. The ✨ button is a model call;
  // the chips' "Recommended" tier is app-computed shape eligibility. A smoke run
  // has no model, which is exactly the case that proves they are independent:
  // the button must be off and say why, while the chips still work.
  const ai = await win.evaluate(() => {
    const btn = document.getElementById('an-suggest-btn') as HTMLButtonElement | null;
    const note = document.getElementById('an-ai-note') as HTMLElement | null;
    const slot = document.getElementById('an-ai-slot') as HTMLElement | null;
    const switcher = document.getElementById('an-switcher') as HTMLElement | null;
    const sr = slot?.getBoundingClientRect();
    const wr = switcher?.getBoundingClientRect();
    return {
      present: !!btn,
      label: (btn?.textContent || '').trim(),
      disabled: !!btn?.disabled,
      noteVisible: !!note && note.offsetParent !== null,
      noteText: (note?.textContent || '').trim(),
      // Above the chips, and visually separate — nothing here may read as if a
      // model produced the Recommended marks.
      aboveChips: !!(sr && wr) && sr.bottom <= wr.top + 1,
      chips: switcher ? switcher.querySelectorAll('.cv-viz-chip').length : 0,
      activeChip: (switcher?.querySelector('.cv-viz-chip.active')?.textContent || '').trim(),
    };
  });
  ok('the ✨ Suggest a visual button is offered, above the chart types',
     ai.present && /Suggest a visual/.test(ai.label) && ai.aboveChips, JSON.stringify(ai));
  ok('…with no model it is DISABLED and says so',
     ai.disabled && ai.noteVisible && /needs? a model/i.test(ai.noteText), ai.noteText);
  ok('…while the app-computed chart types still work, and say they are the app\'s',
     ai.chips > 0 && /recommended by the app itself/i.test(ai.noteText) && !!ai.activeChip,
     `${ai.chips} chips, active="${ai.activeChip}"`);

  // The "+ More" panel is where the Recommended TIER is named. It must exist
  // with no model configured — it is shape eligibility, not a suggestion.
  const tiers = await win.evaluate(() => {
    const more = document.querySelector('#an-switcher .an-typerow') as HTMLElement | undefined;
    if (!more) return null;
    more.click();
    // The panel is appended to <body> (renderResult.ts openMorePanel), not into
    // the switcher — so scoping the query to #an-switcher finds nothing.
    const labels = [...document.querySelectorAll('.cv-more-panel .cv-more-group-label')]
      .map((l) => (l.textContent || '').trim());
    return { opened: true, hasRecommended: labels.some((l) => /^Recommended/.test(l)), labels: labels.slice(0, 6) };
  });
  ok('…and “Recommended” is a tier the app fills with no model involved',
     !!tiers && tiers.hasRecommended, JSON.stringify(tiers));
  await win.evaluate(() => document.body.click());
  await win.waitForTimeout(300);
  ok('…and Properties binds to the card', bound.propsRows >= 2 && !!bound.title,
     `${bound.propsRows} rows, title="${bound.title}"`);

  // Layout is DIRECT MANIPULATION: the nine-button cluster is off the card
  // header and was NOT replaced by steppers in Properties. Aiming at a target
  // four clicks away is arithmetic, not editing.
  const ctrls = await win.evaluate(() => ({
    onCards: [...document.querySelectorAll('#dash-grid .dash-card-ctrls')]
      .filter((c) => (c as HTMLElement).offsetParent !== null).length,
    steppers: document.querySelectorAll('#an-props .an-prop-btn').length,
    handles: [...document.querySelectorAll('#dash-grid .dash-card.is-selected .an-resize')]
      .map((h) => [...h.classList].find((c) => c.startsWith('an-resize--'))),
    remove: !!document.querySelector('#an-props .an-prop-del'),
  }));
  ok('…the per-card button cluster is gone, and no steppers replaced it',
     ctrls.onCards === 0 && ctrls.steppers === 0 && ctrls.remove, JSON.stringify(ctrls));
  ok('…the card carries right, bottom and corner resize handles instead',
     JSON.stringify(ctrls.handles) ===
       JSON.stringify(['an-resize--e', 'an-resize--s', 'an-resize--se']),
     JSON.stringify(ctrls.handles));

  // ── Drag to move, drag an edge to resize ──────────────────────────────────
  // A real pointer gesture: pointerdown on the header, pointermove across the
  // grid, pointerup. Asserted through the LAYOUT the card lands on, because that
  // is the thing being manipulated. The ghost must appear during the drag and
  // the card must NOT move until release — re-laying out mid-drag would
  // re-render the chart on every frame.
  const moved: any = await win.evaluate(() => {
    const el = document.querySelector('#dash-grid .dash-card.is-selected') as HTMLElement;
    const head = el.querySelector('.dash-card-head') as HTMLElement;
    const grid = document.getElementById('dash-grid') as HTMLElement;
    const before = el.style.gridColumn;
    const pitch = (grid.getBoundingClientRect().width + 12) / 12;
    const r = head.getBoundingClientRect();
    const opts = (x: number, y: number) =>
      ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1 });
    head.dispatchEvent(new PointerEvent('pointerdown', opts(r.left + 20, r.top + 8)));
    window.dispatchEvent(new PointerEvent('pointermove', opts(r.left + 20 + pitch * 2, r.top + 8)));
    const ghost = document.querySelector('.an-ghost') as HTMLElement | null;
    // Left HELD here on purpose: the screenshot below is taken mid-gesture, with
    // the ghost on screen and the card still in its old cell. Released after.
    (window as any).__endDrag = () =>
      window.dispatchEvent(new PointerEvent('pointerup', opts(r.left + 20 + pitch * 2, r.top + 8)));
    return {
      before,
      ghostShown: !!ghost && ghost.getBoundingClientRect().width > 0,
      ghostCol: ghost?.style.gridColumn || '',
      cardUnmoved: el.style.gridColumn === before,
    };
  });

  // What a drag actually looks like: ghost at the target cell, card dimmed in
  // place. Only a held gesture can show this, so it is captured before release.
  const dragShot = path.join(shotDir, 'card-drag.png');
  await win.screenshot({ path: dragShot });
  ok('mid-drag screenshot captured', fs.existsSync(dragShot) && fs.statSync(dragShot).size > 5000,
     `${Math.round(fs.statSync(dragShot).size / 1024)} KB -> ${dragShot}`);

  const landed = await win.evaluate(() => {
    (window as any).__endDrag();
    const el = document.querySelector('#dash-grid .dash-card.is-selected') as HTMLElement;
    return { after: el.style.gridColumn, ghostGone: !document.querySelector('.an-ghost') };
  });
  Object.assign(moved, landed);
  ok('dragging the card shows a ghost at the target cell',
     moved.ghostShown && !!moved.ghostCol, JSON.stringify({ ghost: moved.ghostCol }));
  ok('…and the card itself does not move until the pointer is released',
     moved.cardUnmoved, `${moved.before} throughout the drag`);
  ok('…on release it lands where the ghost was, and the ghost is gone',
     moved.after !== moved.before && moved.after === moved.ghostCol && moved.ghostGone,
     `${moved.before} -> ${moved.after}`);

  const resized = await win.evaluate(() => {
    const el = document.querySelector('#dash-grid .dash-card.is-selected') as HTMLElement;
    const handle = el.querySelector('.an-resize--s') as HTMLElement;
    const before = el.style.gridRow;
    const r = handle.getBoundingClientRect();
    const opts = (x: number, y: number) =>
      ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 2 });
    handle.dispatchEvent(new PointerEvent('pointerdown', opts(r.left + 2, r.top + 2)));
    window.dispatchEvent(new PointerEvent('pointermove', opts(r.left + 2, r.top + 2 + (48 + 12) * 2)));
    window.dispatchEvent(new PointerEvent('pointerup', opts(r.left + 2, r.top + 2 + (48 + 12) * 2)));
    return { before, after: el.style.gridRow };
  });
  ok('dragging the bottom edge makes the card taller',
     resized.after !== resized.before, `${resized.before} -> ${resized.after}`);

  // Dragging cannot be the ONLY way to lay out a sheet.
  const keyed = await win.evaluate(() => {
    const el = document.querySelector('#dash-grid .dash-card.is-selected') as HTMLElement;
    const before = el.style.gridColumn;
    el.focus();
    const focused = document.activeElement === el;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    const afterMove = el.style.gridColumn;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
    return { focused, before, afterMove, afterResize: el.style.gridColumn };
  });
  ok('a card is focusable, and arrow keys move it without a mouse',
     keyed.focused && keyed.afterMove !== keyed.before,
     `${keyed.before} -> ${keyed.afterMove}`);
  ok('…and shift+arrow resizes it', keyed.afterResize !== keyed.afterMove,
     `${keyed.afterMove} -> ${keyed.afterResize}`);

  const benchShot = path.join(shotDir, 'authoring-workbench.png');
  await win.screenshot({ path: benchShot });
  ok('workbench screenshot captured', fs.existsSync(benchShot) && fs.statSync(benchShot).size > 5000,
     `${Math.round(fs.statSync(benchShot).size / 1024)} KB -> ${benchShot}`);

  // A REAL drag: dragstart on a field, dragover + drop on a well, carrying a
  // DataTransfer. Playwright cannot synthesise a native HTML5 drag, so the
  // events are dispatched — but they are the same events the browser fires, and
  // they run the same listeners, including the dataTransfer round trip.
  const dropped = await win.evaluate(() => {
    const field = [...document.querySelectorAll('#an-fields .an-field')]
      .find((f) => (f as HTMLElement).dataset.column === 'state') as HTMLElement;
    const well = document.querySelector('#an-wells [data-well="filters"]') as HTMLElement;
    const dt = new DataTransfer();
    field.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const dragging = document.body.classList.contains('an-dragging');
    well.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const highlighted = well.classList.contains('is-drop');
    well.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    field.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return {
      carried: dt.getData('text/plain'),
      dragging,
      highlighted,
      cleared: !well.classList.contains('is-drop'),
      filterRows: document.querySelectorAll('#an-wells .viz-filter-row').length,
      droppedCol: (document.querySelector('#an-wells .viz-filter-row select') as HTMLSelectElement)?.value,
    };
  });
  ok('dragstart carries the column name and marks the drag',
     dropped.carried === 'state' && dropped.dragging, JSON.stringify(dropped));
  ok('…dragover highlights the well, and the highlight clears on drop',
     dropped.highlighted && dropped.cleared);
  ok('…and the drop lands the field in that well',
     dropped.filterRows === 1 && dropped.droppedCol === 'state',
     `${dropped.filterRows} row(s), column=${dropped.droppedCol}`);

  // Click-to-add is the keyboard path; a drag-only well is unreachable.
  await win.evaluate(() => {
    const f = [...document.querySelectorAll('#an-fields .an-field')]
      .find((x) => (x as HTMLElement).dataset.column === 'revenue') as HTMLElement;
    f.click();
  });
  await win.waitForTimeout(1500);
  ok('clicking a numeric field adds it as a measure, no mouse drag needed',
     await win.evaluate(() => document.querySelectorAll('#an-wells .viz-value-row').length >= 1));

  // UNDO both edits. They were written through to the SAVED visual — which is
  // the designed behaviour (a card references a project-level Visual, and
  // publishing denormalises so readers are unaffected) — and the first run of
  // this block proved it the hard way: it left an always-false filter on the map
  // visual and broke every map assertion 400 lines below. A test that mutates
  // shared state has to put it back.
  await win.evaluate(() => {
    document.querySelectorAll('#an-wells .viz-filter-row .viz-value-del')
      .forEach((b) => (b as HTMLElement).click());
  });
  await win.waitForTimeout(1200);
  // A measure is removed through its ⋮ menu now, which is the real user path.
  // The form refuses to go below one measure, so only the extras have a Remove.
  for (let i = 0; i < 3; i++) {
    const removed = await win.evaluate(() => {
      const menus = [...document.querySelectorAll('#an-wells .viz-value-row .enc-pill-menu')] as HTMLElement[];
      if (menus.length <= 1) return false;
      menus[menus.length - 1].click();
      const item = [...document.querySelectorAll('.project-card-popup .project-card-popup-item')]
        .find((b) => /Remove/.test(b.textContent || '')) as HTMLElement | undefined;
      if (!item) return false;
      item.click();
      return true;
    });
    if (!removed) break;
    await win.waitForTimeout(1200);
  }
  await win.waitForTimeout(2000);
  const reverted = await win.evaluate(() => ({
    filters: document.querySelectorAll('#an-wells .viz-filter-row').length,
    measures: document.querySelectorAll('#an-wells .viz-value-row').length,
  }));
  ok('the well edits undo from the same panel, restoring the shared visual',
     reverted.filters === 0 && reverted.measures === 1, JSON.stringify(reverted));

  // Properties closes the way every other flyout does — clicking its lit rail
  // icon. There is no bespoke × any more, because it is no longer a bespoke panel.
  const closedProps = await win.evaluate(() => {
    (document.querySelector('#an-rail .an-rail-btn[data-pane="an-pane-props"]') as HTMLElement).click();
    return {
      shut: (document.getElementById('an-pane-props') as HTMLElement | null)?.offsetParent == null,
      sideShut: (document.getElementById('an-side-left') as HTMLElement | null)?.offsetParent == null,
      flyout: localStorage.getItem('anFlyout'),
      lit: (document.querySelector('#an-rail .an-rail-btn.is-on') as HTMLElement | null)?.dataset.pane,
    };
  });
  ok('Properties closes from its own rail icon, like every other flyout',
     closedProps.shut && closedProps.sideShut, JSON.stringify(closedProps));
  ok('…and the closed state is remembered, with no icon left lit',
     closedProps.flyout === '' && !closedProps.lit, JSON.stringify(closedProps));

  const anShot = path.join(shotDir, 'analysis-editor.png');
  await win.screenshot({ path: anShot });
  ok('analysis editor screenshot captured', fs.existsSync(anShot) && fs.statSync(anShot).size > 5000,
     `${Math.round(fs.statSync(anShot).size / 1024)} KB -> ${anShot}`);

  // ── + Control: the author adds a control card, all three kinds touched ─────
  // Task 4's single dialog: three kind tiles, dataset, column, label, and a
  // live preview that becomes the default. One kind (dropdown, on 'region' —
  // the same column the 'Sales by region' visual card is grouped by) gets a
  // REAL card, which the safety-guarantee and drill-chip checks right after
  // publish depend on. Multi and date_range get a lighter DOM-presence check
  // of their preview shape, per the task-6 brief — this dialog is the only
  // place all three kinds are on screen at once.
  ok('+ Control opens the add-control dialog', await clickId('dash-add-control'));
  await win.waitForTimeout(500);
  const dcOpen = await win.evaluate(() => {
    const box = document.querySelector('.dash-control-modal');
    return {
      open: !!box,
      tiles: box ? [...box.querySelectorAll('.dc-kind-tile')].map((t) => (t as HTMLElement).dataset.kind) : [],
      dropdownOn: !!box?.querySelector('.dc-kind-tile[data-kind="dropdown"].is-on'),
    };
  });
  ok('the dialog offers all three kinds, dropdown selected by default',
     dcOpen.open && JSON.stringify(dcOpen.tiles) === JSON.stringify(['dropdown', 'multi', 'date_range'])
       && dcOpen.dropdownOn, JSON.stringify(dcOpen));

  // Pick the 'Sales' dataset — every kind's preview reads its columns.
  await win.evaluate(() => {
    const box = document.querySelector('.dash-control-modal') as HTMLElement;
    const dsSel = box.querySelector('.dm-field select') as HTMLSelectElement;
    const opt = [...dsSel.options].find((o) => o.textContent === 'Sales');
    if (opt) dsSel.value = opt.value;
    dsSel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await win.waitForTimeout(700); // column list load (getDatasetMeta)

  // multi kind → preview is a checkbox list (fd-list, reused from the filter dialog).
  await win.evaluate(() => {
    (document.querySelector('.dash-control-modal .dc-kind-tile[data-kind="multi"]') as HTMLElement).click();
  });
  await win.waitForTimeout(400);
  ok('the multi kind previews as a checkbox list',
     await win.evaluate(() => !!document.querySelector('.dash-control-modal .dc-preview .fd-list')));

  // date_range kind → preview is two native date inputs.
  await win.evaluate(() => {
    (document.querySelector('.dash-control-modal .dc-kind-tile[data-kind="date_range"]') as HTMLElement).click();
  });
  await win.waitForTimeout(400);
  ok('the date_range kind previews as two date inputs',
     await win.evaluate(() =>
       document.querySelectorAll('.dash-control-modal .dc-preview input[type=date]').length === 2));

  // Back to dropdown — the kind actually added.
  await win.evaluate(() => {
    (document.querySelector('.dash-control-modal .dc-kind-tile[data-kind="dropdown"]') as HTMLElement).click();
  });
  await win.waitForTimeout(400);
  ok('the dropdown kind previews as a native select',
     await win.evaluate(() => !!document.querySelector('.dash-control-modal .dc-preview select')));

  const dcColumn = await win.evaluate(() => {
    const box = document.querySelector('.dash-control-modal') as HTMLElement;
    const colSel = box.querySelectorAll('.dm-field select')[1] as HTMLSelectElement;
    const opt = [...colSel.options].find((o) => o.value === 'region');
    if (!opt) return { ok: false, options: [...colSel.options].map((o) => o.value) };
    colSel.value = 'region';
    colSel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  });
  ok('the region column is selectable for the dropdown control', dcColumn.ok === true, JSON.stringify(dcColumn));
  await win.waitForTimeout(500); // preview options load, label auto-fills to "Filter by region"

  const dcAdded = await win.evaluate(() => {
    const box = document.querySelector('.dash-control-modal') as HTMLElement;
    const label = (box.querySelector('.dm-field input[type=text]') as HTMLInputElement | null)?.value || '';
    const btn = [...box.querySelectorAll('.ws-modal-actions .btn')]
      .find((b) => (b.textContent || '').trim() === 'Add') as HTMLButtonElement | undefined;
    if (!btn || btn.disabled) return { ok: false, label };
    btn.click();
    return { ok: true, label };
  });
  ok('Add creates the control card, auto-labelled from the column',
     dcAdded.ok === true && dcAdded.label === 'Filter by region', JSON.stringify(dcAdded));
  await win.waitForTimeout(2500); // render + debounced autosave

  const withControlCard = await win.evaluate(() => ({
    cards: document.querySelectorAll('#dash-grid .dash-card').length,
    controlCards: document.querySelectorAll('#dash-grid .dash-card--control').length,
    select: !!document.querySelector('#dash-grid .dash-card--control .dash-ctrl-select'),
  }));
  ok('the dropdown control card lands on the sheet, alongside the two visual cards',
     withControlCard.cards === 3 && withControlCard.controlCards === 1 && withControlCard.select,
     JSON.stringify(withControlCard));

  // multi and date_range each get a REAL card too, not just a dialog preview —
  // the dropdown above already proved the dialog mechanics (three tiles,
  // dataset/column pick, auto-label, Add), so these two just reopen it and
  // submit; a chart/drill walk this thorough for all three would be
  // redundant with controlSteps' per-kind node coverage, but a real card is
  // what proves the multi popover and the date-range widget actually render
  // and can be interacted with as a READER (below, on the published
  // dashboard) — a bug unique to either widget's DOM (a CSP violation, a
  // rendering crash) is exactly what a dialog-preview-only check would miss.
  const addControlCard = async (
    kind: 'multi' | 'date_range', column: string,
  ): Promise<{ ok: boolean; label?: string }> => {
    if (!(await clickId('dash-add-control'))) return { ok: false };
    await win.waitForTimeout(400);
    await win.evaluate(() => {
      const box = document.querySelector('.dash-control-modal') as HTMLElement;
      const dsSel = box.querySelector('.dm-field select') as HTMLSelectElement;
      const opt = [...dsSel.options].find((o) => o.textContent === 'Sales');
      if (opt) dsSel.value = opt.value;
      dsSel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await win.waitForTimeout(600); // column list load
    await win.evaluate((k: string) => {
      (document.querySelector(`.dash-control-modal .dc-kind-tile[data-kind="${k}"]`) as HTMLElement).click();
    }, kind);
    await win.waitForTimeout(300);
    const picked = await win.evaluate((col: string) => {
      const box = document.querySelector('.dash-control-modal') as HTMLElement;
      const colSel = box.querySelectorAll('.dm-field select')[1] as HTMLSelectElement;
      const opt = [...colSel.options].find((o) => o.value === col);
      if (!opt) return false;
      colSel.value = col;
      colSel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, column);
    if (!picked) return { ok: false };
    await win.waitForTimeout(400); // label auto-fills
    const result = await win.evaluate(() => {
      const box = document.querySelector('.dash-control-modal') as HTMLElement;
      const label = (box.querySelector('.dm-field input[type=text]') as HTMLInputElement | null)?.value || '';
      const btn = [...box.querySelectorAll('.ws-modal-actions .btn')]
        .find((b) => (b.textContent || '').trim() === 'Add') as HTMLButtonElement | undefined;
      if (!btn || btn.disabled) return { ok: false, label };
      btn.click();
      return { ok: true, label };
    });
    await win.waitForTimeout(2000);
    return result;
  };

  const multiAdded = await addControlCard('multi', 'region');
  ok('a real multi control card is added too', multiAdded.ok === true, JSON.stringify(multiAdded));
  const dateAdded = await addControlCard('date_range', 'sku');
  ok('a real date_range control card is added too', dateAdded.ok === true, JSON.stringify(dateAdded));

  const withAllControlCards = await win.evaluate(() => ({
    cards: document.querySelectorAll('#dash-grid .dash-card').length,
    controlCards: document.querySelectorAll('#dash-grid .dash-card--control').length,
    dropdown: !!document.querySelector('#dash-grid .dash-card--control .dash-ctrl-select'),
    multiChip: !!document.querySelector('#dash-grid .dash-card--control .dash-ctrl-chip'),
    dateInputs: document.querySelectorAll('#dash-grid .dash-card--control .dash-ctrl-date').length,
  }));
  ok('all three control kinds now sit on the sheet as real cards',
     withAllControlCards.cards === 5 && withAllControlCards.controlCards === 3 &&
       withAllControlCards.dropdown && withAllControlCards.multiChip && withAllControlCards.dateInputs === 2,
     JSON.stringify(withAllControlCards));

  // Snapshot the first live chart's labels+values, to prove a control redraws it.
  const chartSnapshot = async () => {
    await win
      .waitForFunction(() => {
        const areas = [...document.querySelectorAll('#dash-grid .dash-viz-area')] as HTMLElement[];
        return areas.some((a) => !!a.querySelector('canvas') && !!chartInstances.get(a));
      }, undefined, { timeout: 30_000 })
      .catch(() => {});
    return win.evaluate(() => {
      const areas = [...document.querySelectorAll('#dash-grid .dash-viz-area')] as HTMLElement[];
      const area = areas.find((a) => !!chartInstances.get(a));
      const chart: any = area && chartInstances.get(area);
      if (!chart) return null;
      return {
        labels: (chart.data.labels || []).slice(),
        values: ((chart.data.datasets[0] && chart.data.datasets[0].data) || []).slice(),
      };
    });
  };

  // ── THE SAME INVARIANT, on the AUTHORING side ───────────────────────────────
  // The path a future regression would break: the dashboard is open for
  // authoring, where markDashDirty()/anScheduleWrite() DO reach disk on a real
  // edit. dashControls.ts's own contract (see its file banner) is that a
  // control's live value is `controlState`, a renderer-only Map that must
  // never itself trigger a write — even here, even though other edits on this
  // same screen do. Prove a chart redraws (real effect), then prove the record
  // file didn't move.
  const analysisId: string | null = await win.evaluate(() => (dashCurrent && dashCurrent.id) || null);
  ok('the open analysis record has an id to stat on disk',
     typeof analysisId === 'string' && analysisId.length > 0, String(analysisId));
  const anRecordPath = path.join(userData, 'projects', r.projectId, 'analyses', analysisId + '.json');
  ok('the analysis record exists on disk before the interaction', fs.existsSync(anRecordPath), anRecordPath);
  const anStatBefore = fs.statSync(anRecordPath);
  const anBytesBefore = fs.readFileSync(anRecordPath);

  const anChartBefore = await chartSnapshot();
  ok('a chart on the open analysis sheet has rendered data to compare',
     !!anChartBefore && Array.isArray((anChartBefore as any).labels) && (anChartBefore as any).labels.length > 1,
     JSON.stringify(anChartBefore));

  // Load the dropdown's real option list the way an author would — on first
  // focus (dashControls.ts's renderDropdownControl loads lazily).
  await win.evaluate(() => {
    const sel = document.querySelector('#dash-grid .dash-card--control .dash-ctrl-select') as HTMLSelectElement | null;
    sel?.dispatchEvent(new Event('mousedown', { bubbles: true }));
    sel?.dispatchEvent(new Event('focus', { bubbles: true }));
  });
  await win.waitForTimeout(1000);
  const pickedRegion3 = await win.evaluate(() => {
    const sel = document.querySelector('#dash-grid .dash-card--control .dash-ctrl-select') as HTMLSelectElement | null;
    if (!sel) return { ok: false };
    const opt = [...sel.options].find((o) => o.value === 'region3');
    if (!opt) return { ok: false, options: [...sel.options].map((o) => o.value) };
    sel.value = 'region3';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  });
  ok('a control can still be worked while the analysis is open for authoring',
     pickedRegion3.ok === true, JSON.stringify(pickedRegion3));
  await win.waitForTimeout(1800); // renderDashGrid + computeVisualData round trip

  const anChartAfter = await chartSnapshot();
  ok('…and it has a real effect: the chart redraws with different data',
     !!anChartAfter && JSON.stringify(anChartAfter) !== JSON.stringify(anChartBefore),
     `before=${JSON.stringify(anChartBefore)} after=${JSON.stringify(anChartAfter)}`);

  const anStatAfter = fs.statSync(anRecordPath);
  const anBytesAfter = fs.readFileSync(anRecordPath);
  ok('THE INVARIANT, authoring side: the analysis record file did not move on disk (same mtime)',
     anStatAfter.mtimeMs === anStatBefore.mtimeMs,
     `before=${anStatBefore.mtimeMs} after=${anStatAfter.mtimeMs}`);
  ok('…and its bytes are byte-for-byte identical (same size, same content)',
     anBytesBefore.equals(anBytesAfter),
     `${anBytesBefore.length}B -> ${anBytesAfter.length}B`);

  // Back to default, so nothing carries into the "add a sheet" edit right below
  // (which SHOULD dirty and write the record — this just keeps that write's
  // diff free of an incidental control pick).
  ok('Reset controls clears the pick made while authoring', await clickId('dash-reset-controls'));
  await win.waitForTimeout(1200);

  ok('a sheet can be added to the analysis', await win.evaluate(() => {
    const add = document.querySelector('#dash-pages .dash-page-add') as HTMLElement | null;
    if (!add) return false;
    add.click();
    return true;
  }));
  await win.waitForTimeout(3000); // debounced save
  const twoSheets = await win.evaluate(() => ({
    tabs: document.querySelectorAll('#dash-pages .dash-page-tab').length,
  }));
  ok('the dashboard now has two sheets', twoSheets.tabs === 2, String(twoSheets.tabs));

  ok('no unexpected alert during the analysis flow', dialogs.length === 0, dialogs.join(' | '));

  // The dashboards LIST.
  ok('back to Dashboards', await clickExact('Dashboards'));
  await win.waitForTimeout(1200);
  const anRow = await win.evaluate(() => {
    const row = [...document.querySelectorAll('#an-list .dash-list-item')].find((r) =>
      /Smoke analysis/.test(r.textContent || ''),
    );
    const vis = (id: string) => (document.getElementById(id) as HTMLElement | null)?.offsetParent != null;
    const cols = [...document.querySelectorAll('.an-table-cols span')];
    // The header labels and the row cells are two separate grids that share one
    // `grid-template-columns`. Nothing but a laid-out page can prove they line
    // up — so compare the actual left edges rather than trusting the CSS.
    const colLefts = cols.map((c) => Math.round(c.getBoundingClientRect().left));
    const cellLefts = row
      ? [...row.children].map((c) => Math.round(c.getBoundingClientRect().left))
      : [];
    return {
      found: !!row,
      text: row ? (row.textContent || '').trim().slice(0, 100) : '',
      headers: cols.map((c) => (c.textContent || '').trim()),
      colLefts,
      cellLefts,
      aligned: colLefts.length === cellLefts.length &&
               colLefts.every((x, i) => Math.abs(x - cellLefts[i]) <= 1),
      tableVisible: vis('an-table'),
      emptyVisible: vis('an-list-empty'),
    };
  });
  ok('the dashboard is listed with its sheet count', !!anRow?.found,
     anRow ? anRow.text : 'not found');
  ok('a populated page shows the table and hides the empty state',
     !!anRow && anRow.tableVisible && !anRow.emptyVisible, JSON.stringify({
       table: anRow?.tableVisible, empty: anRow?.emptyVisible }));
  ok('the table declares its columns',
     JSON.stringify(anRow?.headers) ===
       JSON.stringify(['Name', 'Sheets', 'Last updated', 'Action']),
     JSON.stringify(anRow?.headers));
  ok('and every row cell lines up under its column label', !!anRow && anRow.aligned,
     `cols=${JSON.stringify(anRow?.colLefts)} cells=${JSON.stringify(anRow?.cellLefts)}`);

  // The ⋯ row menu. Rename and Delete used to be two bare glyphs in the row; now
  // they live behind this. A popup is appended to <body> and positioned with
  // fixed coordinates, so "does it exist" is not the question — "is it on screen,
  // next to the button that opened it" is, and only a laid-out page can answer.
  const rowMenu = await win.evaluate(() => {
    const btn = document.querySelector('#an-list .an-row-menu') as HTMLElement | null;
    if (!btn) return { opened: false };
    btn.click();
    const pop = document.querySelector('.project-card-popup') as HTMLElement | null;
    if (!pop) return { opened: false };
    const pr = pop.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    return {
      opened: true,
      items: [...pop.querySelectorAll('.project-card-popup-item')].map((b) => (b.textContent || '').trim()),
      danger: !!pop.querySelector('.project-card-popup-danger'),
      onScreen: pr.width > 0 && pr.height > 0 && pr.top >= 0 && pr.left >= 0 &&
                pr.bottom <= window.innerHeight && pr.right <= window.innerWidth,
      // Right-aligned to the trigger, directly under it.
      anchored: Math.abs(pr.right - br.right) <= 2 && pr.top >= br.bottom - 1,
      inlineGlyphs: document.querySelectorAll('#an-list .dash-list-btn').length,
    };
  });
  ok('the ⋯ row menu opens', rowMenu.opened);
  ok('…with Open / Rename / Delete inside it',
     JSON.stringify(rowMenu.items) === JSON.stringify(['Open', 'Rename', 'Delete']),
     JSON.stringify(rowMenu.items));
  ok('…Delete marked as the destructive one', !!rowMenu.danger);
  ok('…painted fully on screen and anchored to its button',
     !!rowMenu.onScreen && !!rowMenu.anchored,
     `onScreen=${rowMenu.onScreen} anchored=${rowMenu.anchored}`);
  // The row's only control is the trigger — the ✎/🗑 pair is gone, not just hidden.
  ok('and the row carries exactly one control, the trigger', rowMenu.inlineGlyphs === 1,
     `${rowMenu.inlineGlyphs} inline buttons`);

  const menuShot = path.join(shotDir, 'analyses-row-menu.png');
  await win.screenshot({ path: menuShot });
  ok('row-menu screenshot captured', fs.existsSync(menuShot) && fs.statSync(menuShot).size > 5000,
     `${Math.round(fs.statSync(menuShot).size / 1024)} KB -> ${menuShot}`);

  // Dismiss it, so the screenshot below and the draft dialog are not taken with
  // a popup floating over them.
  await win.evaluate(() => (document.body as HTMLElement).click());
  await win.waitForTimeout(300);
  ok('an outside click closes the ⋯ menu',
     await win.evaluate(() => !document.querySelector('.project-card-popup')));
  const listShot = path.join(shotDir, 'analyses-list.png');
  await win.screenshot({ path: listShot });
  ok('analyses list screenshot captured', fs.existsSync(listShot) && fs.statSync(listShot).size > 5000,
     `${Math.round(fs.statSync(listShot).size / 1024)} KB -> ${listShot}`);

  // ── Re-open the dashboard ───────────────────────────────────────────────────
  // Re-open the dashboard from the list so Present mode and Export below have an
  // open sheet to act on — and prove the second sheet and all three control
  // cards persisted through the edit and reload.
  ok('open the dashboard from the list', await win.evaluate(() => {
    const row = [...document.querySelectorAll('#an-list .dash-list-item')]
      .find((r) => /Smoke analysis/.test(r.textContent || '')) as HTMLElement | undefined;
    const openBtn = row?.querySelector('.dash-list-open') as HTMLElement | undefined;
    if (!openBtn) return false;
    openBtn.click();
    return true;
  }));
  await win.waitForTimeout(2500);
  const reopened = await win.evaluate(() => ({
    pages: document.querySelectorAll('#dash-pages .dash-page-tab').length,
    cards: document.querySelectorAll('#dash-grid .dash-card').length,
    controlCards: document.querySelectorAll('#dash-grid .dash-card--control').length,
  }));
  ok('it reopens with the second sheet and all three control cards intact',
     reopened.pages === 2 && reopened.cards === 5 && reopened.controlCards === 3,
     JSON.stringify(reopened));

  // ── Present mode keeps controls usable ──────────────────────────────────────
  // Renderer-only, no window, no IPC (dashShare.ts) — a reader presenting a
  // dashboard must still be able to filter it.
  const presentBefore = await win.evaluate(() => ({
    presenting: document.documentElement.classList.contains('dash-presenting'),
  }));
  ok('Present mode is off at rest', !presentBefore.presenting);
  ok('Present is clickable', await clickId('dash-present-btn'));
  await win.waitForTimeout(800);
  const presenting = await win.evaluate(() => ({
    presenting: document.documentElement.classList.contains('dash-presenting'),
    exitVisible: (document.getElementById('dash-present-exit') as HTMLElement | null)?.hidden === false,
    controlUsable: !!document.querySelector('#dash-grid .dash-card--control .dash-ctrl-select'),
  }));
  ok('Present mode is on, with an Exit affordance', presenting.presenting && presenting.exitVisible,
     JSON.stringify(presenting));
  ok('…and the control widget is STILL a real, interactive select in Present mode',
     presenting.controlUsable, JSON.stringify(presenting));
  const presentShot = path.join(shotDir, 'dashboard-present.png');
  await win.screenshot({ path: presentShot });
  ok('present-mode screenshot captured', fs.existsSync(presentShot) && fs.statSync(presentShot).size > 5000,
     `${Math.round(fs.statSync(presentShot).size / 1024)} KB -> ${presentShot}`);
  await win.keyboard.press('Escape');
  await win.waitForTimeout(500);
  ok('Escape exits Present mode',
     await win.evaluate(() => !document.documentElement.classList.contains('dash-presenting')));

  // ── Export: no broken-card placeholder for the control, summary text shown ──
  // assembleExportBundle (dashShare.ts) deliberately gives a control card NO
  // grid-cell entry — it folds into `controlsSummary` instead, and is never
  // "broken" by design. Playwright cannot drive the native save panel, so the
  // main-process `dialog.showSaveDialog` is stubbed (this run's own tmp dir
  // only) to a real path — the export then writes an ACTUAL file, which is
  // read back and inspected. Stronger than the node-level unit test (Task 5),
  // which calls buildSelfContainedHtml directly and never exercises
  // assembleExportBundle or the dashboard:exportHtml IPC round trip.
  const exportPath = path.join(shotDir, 'dashboard-export.html');
  // ElectronApplication#evaluate hands the `electron` module itself as the
  // FIRST argument (unlike win.evaluate/app.evaluate calls elsewhere in this
  // file that ignore it and `process.mainModule.require('electron')` instead)
  // — using it directly here is what makes passing a second, real argument work.
  await app.evaluate((electron, dest: string) => {
    (globalThis as any).__smokeOrigShowSaveDialog = electron.dialog.showSaveDialog;
    electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: dest });
  }, exportPath);

  // Give the control an active value first, so the export actually has a
  // summary to show (an unset control contributes nothing, by design).
  await win.evaluate(() => {
    const sel = document.querySelector('#dash-grid .dash-card--control .dash-ctrl-select') as HTMLSelectElement | null;
    sel?.dispatchEvent(new Event('mousedown', { bubbles: true }));
    sel?.dispatchEvent(new Event('focus', { bubbles: true }));
  });
  await win.waitForTimeout(1000);
  await win.evaluate(() => {
    const sel = document.querySelector('#dash-grid .dash-card--control .dash-ctrl-select') as HTMLSelectElement;
    const opt = [...sel.options].find((o) => o.value === 'region3');
    if (opt) { sel.value = 'region3'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  });
  await win.waitForTimeout(1000);

  ok('Export… is clickable', await clickId('dash-export-btn'));
  await win.waitForTimeout(600);
  ok('the export dialog offers HTML / PDF / PNG, HTML first', await win.evaluate(() => {
    const box = [...document.querySelectorAll('.ws-modal-overlay')]
      .filter((o) => (o as HTMLElement).getClientRects().length > 0)
      .map((o) => o.querySelector('.ws-modal'))[0] as HTMLElement | undefined;
    const sel = box?.querySelector('select') as HTMLSelectElement | undefined;
    return !!sel && [...sel.options].map((o) => o.value).join(',') === 'html,pdf,png';
  }));
  ok('choosing Export (HTML, the default) triggers the save', await win.evaluate(() => {
    const box = [...document.querySelectorAll('.ws-modal-overlay')]
      .filter((o) => (o as HTMLElement).getClientRects().length > 0)
      .map((o) => o.querySelector('.ws-modal'))[0] as HTMLElement | undefined;
    const btn = box?.querySelector('.ws-modal-actions .btn-primary') as HTMLElement | undefined;
    if (!btn) return false;
    btn.click();
    return true;
  }));
  await win.waitForTimeout(2500);

  // Restore the real dialog immediately — nothing later in this run should
  // ever have its save panel silently redirected.
  await app.evaluate((electron) => {
    if ((globalThis as any).__smokeOrigShowSaveDialog) {
      electron.dialog.showSaveDialog = (globalThis as any).__smokeOrigShowSaveDialog;
      delete (globalThis as any).__smokeOrigShowSaveDialog;
    }
  });

  ok('the export actually wrote a file', fs.existsSync(exportPath), exportPath);
  const exportHtml = fs.existsSync(exportPath) ? fs.readFileSync(exportPath, 'utf8') : '';
  ok('…with the control summary rendered as plain text',
     /dash-controls-summary/.test(exportHtml) && /Filter by region/.test(exportHtml),
     `has-class=${/dash-controls-summary/.test(exportHtml)} has-text=${/Filter by region/.test(exportHtml)}`);
  ok('…no broken-card placeholder for the control (it has no grid cell, by design)',
     !/Unknown card/.test(exportHtml));
  ok('…and no live control widget leaked into the export (never a real <select> for it)',
     !/dash-ctrl-select/.test(exportHtml));

  ok('back to Dashboards', await clickExact('Dashboards'));
  await win.waitForTimeout(1200);

  // ── A starter route actually scaffolds ────────────────────────────────────
  // The whole argument for step 2 is that every card does something. A layout
  // picker whose options all produce the same empty sheet is the thing this was
  // built to avoid, so assert the cards land. Runs LAST in this section and
  // makes a SECOND analysis, which is why it sits below the list-count
  // assertions rather than above them.
  ok('a second Create dashboard opens the wizard', await clickId('an-new-btn'));
  await win.waitForTimeout(700);
  await win.evaluate(() => {
    (document.querySelector('.an-wiz-row') as HTMLElement).click();   // any dataset
    const nameIn = document.querySelector('.an-wiz-name input') as HTMLInputElement;
    nameIn.value = 'Starter analysis';
    nameIn.dispatchEvent(new Event('input', { bubbles: true }));
    ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLElement).click();
  });
  await win.waitForTimeout(500);
  ok('…and KPIs + chart can be chosen', await win.evaluate(() => {
    const c = [...document.querySelectorAll('.an-wiz-start')]
      .find((x) => (x as HTMLElement).dataset.kind === 'kpis') as HTMLElement | undefined;
    if (!c) return false;
    c.click();
    return true;
  }));
  await win.waitForTimeout(300);
  await win.evaluate(() =>
    ([...document.querySelectorAll('.an-wiz-foot .btn-primary')][0] as HTMLElement).click());
  await win.waitForTimeout(1800);
  // applyStarter asks which saved visual belongs in the wide slot.
  ok('the starter asks which visual fills its slot', await pickFirstOption());
  await win.waitForTimeout(2500);

  const scaffold = await win.evaluate(() => ({
    cards: document.querySelectorAll('#dash-grid .dash-card').length,
    kinds: [...document.querySelectorAll('#dash-grid .dash-card')]
      .map((c) => [...c.classList].find((k) => k.startsWith('dash-card--')) || '?'),
    name: (document.getElementById('dash-name')?.textContent || '').trim(),
  }));
  ok('KPIs + chart scaffolds a real layout, not an empty sheet',
     scaffold.cards === 2 && scaffold.kinds.includes('dash-card--text') &&
       scaffold.kinds.includes('dash-card--visual'),
     JSON.stringify(scaffold));
  ok('…into the analysis the wizard just named', scaffold.name === 'Starter analysis', scaffold.name);

  const starterShot = path.join(shotDir, 'starter-scaffold.png');
  await win.screenshot({ path: starterShot });
  ok('starter scaffold screenshot captured',
     fs.existsSync(starterShot) && fs.statSync(starterShot).size > 5000,
     `${Math.round(fs.statSync(starterShot).size / 1024)} KB -> ${starterShot}`);

  ok('back to Analyses after the starter', await clickExact('Dashboards'));
  await win.waitForTimeout(1200);

  // ── The AI draft review dialog, on a synthetic Phase E envelope ───────────
  // `analysis:draft` needs a configured model, which a smoke run has not got, so
  // the review dialog would otherwise ship never having been rendered once. It
  // is pure DOM, so it can be opened directly with the exact envelope shape
  // Phase E returns — { rationale, sheets[].visuals[], calculatedFields,
  // dropped[] } — and asserted the way everything else here is: by what paints.
  await win.evaluate(() => {
    (window as any).__draftResult = 'pending';
    (window as any)
      .anDraftReviewModal({
        ok: true,
        name: 'Regional performance',
        rationale: 'Revenue is concentrated in a few regions, so the first sheet leads with the split.',
        calculatedFields: [{ name: 'margin', formula: 'revenue - cost' }],
        sheets: [
          {
            name: 'Overview',
            visuals: [
              {
                name: 'Revenue by region',
                chartType: 'column',
                data: {
                  labels: ['North', 'South', 'East'],
                  series: [{ name: 'sum of amount', values: [3, 1, 2] }],
                },
              },
              {
                name: 'Margin trend',
                chartType: 'line',
                data: null,
                note: 'Needs the calculated field “margin”, which does not exist yet.',
              },
            ],
          },
        ],
        dropped: [
          { kind: 'chart_type', where: 'sheets[0].visuals[2]', message: '“spiral” is not a chart type Ordinate has.' },
          { kind: 'formula', where: 'calculatedFields[1]', message: 'The formula does not compile.' },
        ],
      })
      .then((v: boolean) => { (window as any).__draftResult = v; });
  });
  await win.waitForTimeout(1500);
  const review = await win.evaluate(() => {
    const modal = document.querySelector('.an-draft-modal') as HTMLElement | null;
    const viz = document.querySelector('.an-draft-viz') as HTMLElement | null;
    const note = document.querySelector('.an-draft-note--why') as HTMLElement | null;
    const dropped = [...document.querySelectorAll('.an-draft-dropped')].filter(
      (e) => (e as HTMLElement).offsetParent !== null,
    );
    const mr = modal?.getBoundingClientRect();
    const vr = viz?.getBoundingClientRect();
    // Where the drop list sits RELATIVE to the first preview chart. At its
    // natural height a chart pushes the drop list below the fold, and a list of
    // the model's mistakes the user must scroll to find defeats the point:
    // they approve having seen only the parts that worked.
    const firstDropTop = dropped.length
      ? Math.round((dropped[0] as HTMLElement).getBoundingClientRect().top) : -1;
    return {
      firstDropTop,
      firstVizTop: Math.round(vr?.top ?? 1e9),
      modalW: Math.round(mr?.width || 0),
      modalH: Math.round(mr?.height || 0),
      vizH: Math.round(vr?.height || 0),
      vizDrew: !!viz?.querySelector('canvas'),
      // The preview chart must stay INSIDE its box. `.cv-viz-area` sizes its
      // canvas wrapper against the viewport, so unclipped it printed through
      // the card below — a bug every DOM assertion passed and the screenshot
      // caught in one look.
      vizOverflow: (() => {
        const cv = viz?.querySelector('canvas') as HTMLElement | null;
        if (!cv || !vr) return 0;
        const cr = cv.getBoundingClientRect();
        return Math.round(Math.max(0, cr.bottom - vr.bottom));
      })(),
      noteText: (note?.textContent || '').trim(),
      noteVisible: !!note && note.offsetParent !== null,
      droppedCount: dropped.length,
      droppedText: dropped.map((d) => (d.textContent || '').trim()).join(' | ').slice(0, 160),
      rationale: (document.querySelector('.an-draft-rationale .ai-interp-body')?.textContent || '').trim().slice(0, 40),
      calc: (document.querySelector('.an-draft-calc-formula')?.textContent || '').trim(),
      createVisible: [...document.querySelectorAll('.an-draft-modal .ws-modal-actions .btn')]
        .some((b) => /Create dashboard/.test(b.textContent || '') && (b as HTMLElement).offsetParent !== null),
      // Nothing may stand in for a figure the app did not compute.
      fakeFigure: /(^|\s)(0|—|N\/A)(\s|$)/.test(note?.textContent || ''),
    };
  });
  // Order, not just presence: dropped entries must come BEFORE the previews.
  ok('what was dropped is shown above the preview charts, not below them',
     review.firstDropTop >= 0 && review.firstDropTop < review.firstVizTop,
     `dropTop=${review.firstDropTop} vizTop=${review.firstVizTop}`);
  ok('the draft review dialog paints at a real size', review.modalW > 400 && review.modalH > 200,
     `${review.modalW}x${review.modalH}`);
  ok('a previewed visual renders its app-computed data as a chart',
     review.vizDrew && review.vizH > 100, `canvas=${review.vizDrew} height=${review.vizH}`);
  ok('and the preview chart stays inside its box (no printing through the next card)',
     review.vizOverflow === 0, `${review.vizOverflow}px past the bottom`);
  ok('a null-data visual shows its note instead, and no substituted figure',
     review.noteVisible && /Needs the calculated field/.test(review.noteText) && !review.fakeFigure,
     review.noteText.slice(0, 80));
  ok('everything the app DROPPED is shown, with its envelope path',
     review.droppedCount === 2 && /sheets\[0\]\.visuals\[2\]/.test(review.droppedText),
     review.droppedText);
  ok('the rationale and calculated fields are shown',
     !!review.rationale && review.calc === 'revenue - cost',
     `${review.rationale} / ${review.calc}`);
  ok('the dialog offers Create', review.createVisible);

  const draftShot = path.join(shotDir, 'draft-review.png');
  await win.screenshot({ path: draftShot });
  ok('draft review screenshot captured', fs.existsSync(draftShot) && fs.statSync(draftShot).size > 5000,
     `${Math.round(fs.statSync(draftShot).size / 1024)} KB -> ${draftShot}`);

  await win.evaluate(() => {
    const b = [...document.querySelectorAll('.an-draft-modal .ws-modal-actions .btn')].find((x) =>
      /Discard/.test(x.textContent || ''),
    ) as HTMLElement | undefined;
    if (b) b.click();
  });
  await win.waitForTimeout(600);
  const discarded = await win.evaluate(() => ({
    result: (window as any).__draftResult,
    gone: !document.querySelector('.an-draft-modal'),
  }));
  ok('Discard resolves false and tears the dialog down',
     discarded.result === false && discarded.gone, JSON.stringify(discarded));

  // ── The Visuals builder, end to end ───────────────────────────────────────
  // The encoding form is now a mounted <template> clone (encodingForm.ts) rather
  // than markup addressed by id. That refactor is invisible when it works and
  // total when it does not — a mis-scoped querySelector yields a builder whose
  // controls are simply inert, which nothing outside a running window can see.
  // So: open it, read the controls, CHANGE one, and save.
  ok('the Visuals section opens', await clickExact('Visuals'));
  await win.waitForTimeout(1200);
  // "+ New visual" opens the create popup first (step 1 dataset, step 2 how),
  // and only "Build it myself" reaches the builder. A popup that renders but
  // whose rows are inert looks identical from outside — so pick a REAL row.
  ok('+ New visual opens the create popup', await clickId('viz-new-btn'));
  await win.waitForTimeout(1200);
  const popup = await win.evaluate(() => {
    const modal = document.querySelector('.vn-modal') as HTMLElement | null;
    const rows = [...document.querySelectorAll('.vn-row')] as HTMLElement[];
    return {
      open: !!modal,
      rows: rows.length,
      // Step 2 must still be hidden: nothing is chosen yet.
      step2Hidden: (document.querySelector('.js-vn-step2') as HTMLElement)?.hidden === true,
      meta: rows[0]?.textContent || '',
    };
  });
  ok('…listing the project datasets with rows × columns', popup.open && popup.rows > 0
     && /rows ×/.test(popup.meta) && popup.step2Hidden, JSON.stringify(popup));

  // The focus trap must only ever offer VISIBLE controls. Steps 2 and 3 are in
  // the DOM but display:none, and focus() on a display:none element is a no-op
  // that strands focus outside the dialog.
  const trap = await win.evaluate(() => {
    const box = document.querySelector('.vn-modal') as HTMLElement;
    const insideDialog = box.contains(document.activeElement);
    const hiddenFocusable = [...box.querySelectorAll('button, input, select, textarea')]
      .filter((el) => (el as HTMLElement).getClientRects().length === 0).length;
    return {
      role: box.getAttribute('role'),
      modal: box.getAttribute('aria-modal'),
      labelled: !!box.getAttribute('aria-label'),
      insideDialog,
      hiddenFocusable,
    };
  });
  ok('…as a labelled aria-modal dialog with focus landing inside it',
     trap.role === 'dialog' && trap.modal === 'true' && trap.labelled && trap.insideDialog,
     JSON.stringify(trap));
  ok('…and the later steps really are display:none, so the trap has to skip them',
     trap.hiddenFocusable > 0, `${trap.hiddenFocusable} offscreen controls`);

  ok('…picking a dataset advances to step 2', await win.evaluate(() => {
    const row = [...document.querySelectorAll('.vn-row')].find(
      (r) => /Sales/i.test(r.textContent || ''),
    ) as HTMLElement | undefined;
    if (!row) return false;
    row.click();
    return (document.querySelector('.js-vn-step2') as HTMLElement)?.hidden === false;
  }));

  ok('…and "Build it myself" closes the popup and opens the builder', await win.evaluate(() => {
    (document.querySelector('.js-vn-manual') as HTMLElement).click();
    return true;
  }));
  await win.waitForTimeout(2500);
  ok('…with the popup gone and the gallery swapped out for the builder',
     await win.evaluate(() => !document.querySelector('.vn-modal')
       && (document.getElementById('viz-builder') as HTMLElement).hidden === false
       && (document.getElementById('viz-gallery') as HTMLElement).hidden === true));

  // Pick a KNOWN dataset rather than whichever the select defaulted to, so the
  // column assertions below mean something.
  await win.evaluate(() => {
    const sel = document.getElementById('viz-dataset-select') as HTMLSelectElement;
    const sales = [...sel.options].find((o) => /Sales/.test(o.textContent || ''));
    if (sales) {
      sel.value = sales.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await win.waitForTimeout(2500);

  const form = await win.evaluate(() => {
    // Scoped to the Visuals section: since phase C the analysis workbench mounts
    // a SECOND encoding form, which is exactly what phase B made possible. A
    // bare document.querySelector here would read whichever mounted first.
    const box = document.getElementById('ws-visuals') as HTMLElement;
    const enc = box.querySelector('.viz-encoding') as HTMLElement | null;
    const cat = box.querySelector('.js-enc-cat') as HTMLSelectElement | null;
    const ser = box.querySelector('.js-enc-series') as HTMLSelectElement | null;
    const geo = box.querySelector('.js-enc-geo') as HTMLSelectElement | null;
    const label = box.querySelector('.viz-encoding label[for]') as HTMLLabelElement | null;
    const agg = box.querySelector('.viz-value-agg') as HTMLSelectElement | null;
    return {
      mounted: !!enc && enc.offsetParent !== null,
      // Exactly ONE form is mounted. <template> content is inert and must not
      // be counted by a querySelectorAll, which is itself worth pinning.
      instances: box.querySelectorAll('.viz-encoding').length,
      catOptions: cat ? [...cat.options].map((o) => o.value) : [],
      seriesFirst: ser && ser.options[0] ? ser.options[0].textContent : '',
      geoOptions: geo ? geo.options.length : 0,
      measures: box.querySelectorAll('.viz-value-row').length,
      aggOptions: agg ? [...agg.options].map((o) => o.textContent) : [],
      // The per-instance id rewrite: a label must still point at a control that
      // EXISTS, or clicking it focuses nothing.
      labelFor: label?.htmlFor || '',
      labelResolves: !!(label && document.getElementById(label.htmlFor)),
      labelSuffixed: /-ef\d+$/.test(label?.htmlFor || ''),
    };
  });
  ok('the encoding form mounts, exactly once', form.mounted && form.instances === 1,
     JSON.stringify({ mounted: form.mounted, instances: form.instances }));
  ok("…with the dataset's columns, text before numbers",
     JSON.stringify(form.catOptions) === JSON.stringify(['region', 'sku', 'note', 'amount']),
     JSON.stringify(form.catOptions));
  ok('…one default measure, and the full aggregation list',
     form.measures === 1 &&
       JSON.stringify(form.aggOptions) ===
         JSON.stringify(['Sum', 'Average', 'Count', 'Min', 'Max', 'Raw (no aggregation)']),
     JSON.stringify(form.aggOptions));
  ok('…Split by defaulting to None, and all six geo levels',
     form.seriesFirst === 'None' && form.geoOptions === 6,
     `series="${form.seriesFirst}" geo=${form.geoOptions}`);
  ok('…and every label still resolves to its own control after the id rewrite',
     form.labelResolves && form.labelSuffixed, form.labelFor);

  // Drive it: add a measure, switch an aggregation. This is what proves the
  // form's single onChange is actually wired to the recompute.
  await win.evaluate(() =>
    (document.querySelector('#ws-visuals .js-enc-add-value') as HTMLElement).click());
  await win.waitForTimeout(1800);
  const added = await win.evaluate(() => ({
    measures: document.querySelectorAll('#ws-visuals .viz-value-row').length,
    // At two measures the delete buttons un-disable; at one they are disabled,
    // because the form keeps at least one measure.
    firstDelEnabled: !(document.querySelector('#ws-visuals .viz-value-del') as HTMLButtonElement)?.disabled,
  }));
  ok('+ Add measure adds a row and frees the delete buttons',
     added.measures === 2 && added.firstDelEnabled, JSON.stringify(added));

  await win.evaluate(() => {
    const agg = document.querySelector('#ws-visuals .viz-value-agg') as HTMLSelectElement;
    agg.value = 'avg';
    agg.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await win
    .waitForFunction(() => !!document.querySelector('#viz-area canvas, #viz-area svg'), undefined,
                     { timeout: 30_000 })
    .catch(() => {});
  ok('changing an aggregation recomputes and redraws the preview',
     await win.evaluate(() => !!document.querySelector('#viz-area canvas, #viz-area svg')));

  const filterAdded = await win.evaluate(() => {
    (document.querySelector('#ws-visuals .js-enc-add-filter') as HTMLElement).click();
    return document.querySelectorAll('#ws-visuals .viz-filter-row').length;
  });
  ok('+ Add filter adds a filter row', filterAdded === 1, String(filterAdded));

  // ── The type-aware filter dialog ─────────────────────────────────────────
  // A dialog nobody drives is untested UI, and untested UI is how a blocked
  // inline style once shipped past 2,400 green assertions. This opens it on a
  // TEXT column and checks the thing that makes it type-aware: a real checkbox
  // list of that column's distinct values, fetched through main.
  //
  // The fresh row is also asserted INERT. It used to be `{op:'=', value:''}`,
  // which matches EMPTY cells — so adding a filter blanked the chart before you
  // had typed anything, while a comment here claimed it "changes nothing".
  ok('…and that row is inert until a condition is set',
     await win.evaluate(() => {
       const b = document.querySelector('#ws-visuals .viz-filter-cond') as HTMLButtonElement;
       return !!b && /set a condition/.test(b.textContent || '');
     }));

  await win.evaluate(() =>
    (document.querySelector('#ws-visuals .viz-filter-cond') as HTMLElement).click());
  // The value list is an IPC round trip against a 1M-row Parquet.
  await win
    .waitForFunction(() => document.querySelectorAll('.fd-list .fd-opt').length > 0, undefined,
                     { timeout: 30_000 })
    .catch(() => {});
  const dlg = await win.evaluate(() => {
    const opts = [...document.querySelectorAll('.fd-list .fd-opt')];
    return {
      open: !!document.querySelector('.fd-modal'),
      // A text column gets Values + Condition; a number column would get Range.
      tabs: [...document.querySelectorAll('.fd-tab')].map((t) => (t.textContent || '').trim()),
      sub: (document.querySelector('.fd-sub')?.textContent || '').trim(),
      options: opts.length,
      // The smoke dataset has exactly 7 regions, so this is the column's REAL
      // distinct values rather than a placeholder.
      first: (opts[0]?.textContent || '').trim(),
      applyDisabled: (document.querySelector('.fd-modal .btn-primary') as HTMLButtonElement)?.disabled,
    };
  });
  ok('the filter dialog opens with a real value list for a text column',
     dlg.open && dlg.options === 7 && /^region/.test(dlg.first), JSON.stringify(dlg));
  ok('…adapting to the column type (Values + Condition, not a range)',
     dlg.sub === 'Text column' && JSON.stringify(dlg.tabs) === JSON.stringify(['Values', 'Condition']),
     JSON.stringify(dlg.tabs));
  ok('…with Apply disabled until something is actually selected', dlg.applyDisabled === true);

  // The search must narrow the list through MAIN, not by filtering an
  // already-fetched array in the renderer.
  await win.evaluate(() => {
    const s = document.querySelector('.fd-search') as HTMLInputElement;
    s.value = 'region3';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await win
    .waitForFunction(() => document.querySelectorAll('.fd-list .fd-opt').length === 1, undefined,
                     { timeout: 30_000 })
    .catch(() => {});
  ok('searching narrows the list (server-side, over 1M rows)',
     await win.evaluate(() => document.querySelectorAll('.fd-list .fd-opt').length === 1));

  const dialogShot = path.join(shotDir, 'filter-dialog.png');
  await win.screenshot({ path: dialogShot });
  ok('filter dialog screenshot captured',
     fs.existsSync(dialogShot) && fs.statSync(dialogShot).size > 5000,
     `${Math.round(fs.statSync(dialogShot).size / 1024)} KB -> ${dialogShot}`);

  // Tick three values and apply → ONE `in` step carrying all three.
  await win.evaluate(() => {
    const s = document.querySelector('.fd-search') as HTMLInputElement;
    s.value = '';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await win
    .waitForFunction(() => document.querySelectorAll('.fd-list .fd-opt').length === 7, undefined,
                     { timeout: 30_000 })
    .catch(() => {});
  await win.evaluate(() => {
    [...document.querySelectorAll('.fd-list .fd-opt input')].slice(0, 3)
      .forEach((el) => (el as HTMLInputElement).click());
  });
  ok('selecting values enables Apply and counts them',
     await win.evaluate(() => {
       const note = document.querySelector('.fd-note')?.textContent || '';
       const btn = document.querySelector('.fd-modal .btn-primary') as HTMLButtonElement;
       return !btn.disabled && /3 selected/.test(note);
     }));
  await win.evaluate(() =>
    (document.querySelector('.fd-modal .btn-primary') as HTMLElement).click());
  await win.waitForTimeout(1200);
  ok('Apply closes the dialog and writes ONE `in` step onto the row',
     await win.evaluate(() => {
       const open = !!document.querySelector('.fd-modal');
       const b = document.querySelector('#ws-visuals .viz-filter-cond') as HTMLElement;
       return !open && /is any of/.test(b?.textContent || '');
     }));

  const builderShot = path.join(shotDir, 'visual-builder.png');
  await win.screenshot({ path: builderShot });
  ok('visual builder screenshot captured',
     fs.existsSync(builderShot) && fs.statSync(builderShot).size > 5000,
     `${Math.round(fs.statSync(builderShot).size / 1024)} KB -> ${builderShot}`);

  // Save prompts for a name — answer it, or the write never happens and the
  // list silently stays as it was.
  ok('Save asks for a name', await clickId('viz-save-btn'));
  await win.waitForTimeout(600);
  ok('…and takes one', await fillPrompt('Encoding form check'));
  await win.waitForTimeout(2500);
  const saved = await win.evaluate(() => ({
    count: document.querySelectorAll('#viz-grid > *').length,
    names: [...document.querySelectorAll('#viz-grid')]
      .map((l) => (l.textContent || '').replace(/\s+/g, ' ').trim()).join('').slice(0, 120),
    builderClosed: (document.getElementById('viz-builder') as HTMLElement)?.hidden === true,
  }));
  ok('…the visual is written and appears in the saved list',
     saved.count >= 3 && /Encoding form check/.test(saved.names), JSON.stringify(saved));
  ok('…and saving closes the builder', saved.builderClosed);

  // Reopen it. The restore path runs the SAME setColumns(cols, preset) call as a
  // fresh build, so a preset that silently fails to apply shows up right here —
  // as the two measures we just saved coming back as one.
  // The card's own actions. Favourite writes and re-sorts (favourites first), so
  // the starred card must come back at the front — a star that only repaints
  // itself would pass a "did it toggle" check and lose the state on refresh.
  const starred = await win.evaluate(async () => {
    const cards = [...document.querySelectorAll('.viz-card')] as HTMLElement[];
    const target = cards.find((c) => /Encoding form check/.test(c.textContent || ''));
    if (!target) return { found: false };
    (target.querySelector('.viz-card-star') as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 1500));
    const first = document.querySelector('.viz-card') as HTMLElement;
    return {
      found: true,
      firstIsStarred: /Encoding form check/.test(first?.textContent || ''),
      pressed: first?.querySelector('.viz-card-star')?.getAttribute('aria-pressed'),
    };
  });
  ok('the star favourites a visual and sorts it to the front',
     starred.found === true && starred.firstIsStarred === true && starred.pressed === 'true',
     JSON.stringify(starred));

  // The ⋯ menu is a real button with honest aria-expanded, and every row is
  // enabled — "Add to analysis" and "Export" shipped disabled in Phase 1.
  // Scoped to .viz-card-pop: hub.ts keeps ONE permanent .chart-menu[role=menu]
  // element in the document for the per-graph ⋯ cluster, so a bare `.chart-menu`
  // here reads that static one and its rows instead of this popover's.
  const menu = await win.evaluate(() => {
    const btn = document.querySelector('.viz-card-menu') as HTMLButtonElement;
    btn.click();
    const items = [...document.querySelectorAll('.viz-card-pop button')] as HTMLButtonElement[];
    return {
      expanded: btn.getAttribute('aria-expanded'),
      labels: items.map((i) => (i.textContent || '').trim()),
      disabled: items.filter((i) => i.disabled).map((i) => i.textContent || ''),
    };
  });
  ok('the ⋯ menu opens with every action enabled',
     menu.expanded === 'true' && menu.labels.length === 6 && menu.disabled.length === 0
     && menu.labels.indexOf('Add to dashboard') >= 0 && menu.labels.indexOf('Export') >= 0,
     JSON.stringify(menu));
  await win.keyboard.press('Escape');
  await win.waitForTimeout(400);
  ok('…and Escape closes it, resetting aria-expanded',
     await win.evaluate(() => !document.querySelector('.viz-card-pop')
       && document.querySelector('.viz-card-menu')?.getAttribute('aria-expanded') === 'false'));

  // ── A saved MAP round-trips through the card menu ────────────────────────
  // A map is the type most likely to be quietly unreachable from a new surface:
  // it needs geo on the computed data, WebGL, and the VISIBLE window. Drive it
  // through the card's own Export and Add-to-analysis rather than the builder.
  const openCardMenu = (nameRe: string) =>
    win.evaluate((src: string) => {
      const rx = new RegExp(src, 'i');
      const card = [...document.querySelectorAll('.viz-card')].find(
        (c) => rx.test(c.textContent || ''),
      ) as HTMLElement | undefined;
      if (!card) return false;
      (card.querySelector('.viz-card-menu') as HTMLElement).click();
      return true;
    }, nameRe);
  const clickMenuRow = (label: string) =>
    win.evaluate((l: string) => {
      const row = [...document.querySelectorAll('.viz-card-pop button')].find(
        (b) => (b.textContent || '').trim() === l,
      ) as HTMLElement | undefined;
      if (!row) return false;
      row.click();
      return true;
    }, label);

  ok('the map visual has a card in the gallery', await openCardMenu('Revenue by state'));
  ok('…whose menu offers Export', await clickMenuRow('Export'));
  await win.waitForTimeout(3000);
  const mapExport = await win.evaluate(() => {
    const overlay = document.getElementById('export-overlay');
    const chips = [...document.querySelectorAll('#export-overlay .viz-chip, #export-overlay [class*=chip]')]
      .map((c) => (c.textContent || '').trim()).filter(Boolean);
    return { open: !!overlay, chips: chips.slice(0, 8) };
  });
  ok('…and Export opens the dialog for a saved map, offering the region map first',
     mapExport.open && mapExport.chips.some((c) => /Region map/i.test(c)),
     JSON.stringify(mapExport));
  await win.keyboard.press('Escape');
  await win.waitForTimeout(600);
  ok('…and the export dialog closes again',
     await win.evaluate(() => !document.getElementById('export-overlay')));

  // Add to analysis: a real write to a real analysis record, from the gallery.
  ok('the map card menu offers Add to dashboard', await openCardMenu('Revenue by state'));
  ok('…and it opens the dashboard picker', await clickMenuRow('Add to dashboard'));
  await win.waitForTimeout(900);
  ok('…listing the existing dashboards plus a New dashboard… entry',
     await win.evaluate(() => {
       const sel = [...document.querySelectorAll('.ws-modal-overlay')]
         .filter((o) => (o as HTMLElement).getClientRects().length > 0)
         .map((o) => o.querySelector('select.ws-modal-input'))[0] as HTMLSelectElement;
       return !!sel && [...sel.options].some((o) => /New dashboard/.test(o.textContent || ''));
     }));
  ok('…and picking one confirms', await pickFirstOption());
  await win.waitForTimeout(2500);
  ok('…the visual is filed away with a toast, and the gallery stays put',
     await win.evaluate(() => {
       const toast = document.getElementById('hub-toast');
       return !!toast && toast.hidden === false && /Added to/.test(toast.textContent || '')
         && (document.getElementById('viz-gallery') as HTMLElement).hidden === false;
     }));

  // Unstar again so the ordering the reopen check below relies on is restored.
  await win.evaluate(() => (document.querySelector('.viz-card-star') as HTMLElement).click());
  await win.waitForTimeout(1500);

  ok('the saved visual reopens', await win.evaluate(() => {
    const el = [...document.querySelectorAll('#viz-grid button, #viz-grid [role=button]')]
      .find((b) => /Encoding form check/.test(b.textContent || '')) as HTMLElement | undefined;
    if (!el) return false;
    el.click();
    return true;
  }));
  await win.waitForTimeout(3000);
  const restored = await win.evaluate(() => {
    const box = document.getElementById('ws-visuals') as HTMLElement;
    return {
      instances: box.querySelectorAll('.viz-encoding').length,
      measures: box.querySelectorAll('.viz-value-row').length,
      firstAgg: (box.querySelector('.viz-value-agg') as HTMLSelectElement)?.value || '',
    };
  });
  ok('…into the same single form, with both measures and the aggregation restored',
     restored.instances === 1 && restored.measures === 2 && restored.firstAgg === 'avg',
     JSON.stringify(restored));

  // ── Drill-down: the rows behind a bar, on the real app ────────────────────
  //
  // THE assertion this feature stands on. Reopen the saved visual (which carries
  // an `in` filter on region), click a real bar, and check the panel's row total
  // against a count derived from the FIXTURE'S OWN DEFINITION rather than from
  // any code path the app uses: the generator writes region = 'region' + (i % 7)
  // over 1,000,000 rows, so region0 has 142,858 rows and every other region has
  // 142,857. Nothing but a faithful filter chain produces that number over a
  // million rows — an off-by-one in the mark filter, a dropped visual filter or
  // a lost `in` step all land somewhere else.
  //
  // This rides on the reopen just above rather than doing its own: the builder
  // is already showing that visual's chart, and an extra navigation here
  // perturbed the gallery assertions that follow.
  //
  // Wait for the CHART INSTANCE, not for a canvas. Closing the builder leaves
  // the previous chart's canvas in #viz-area, so `querySelector('canvas')` is
  // satisfied instantly by a canvas that is about to be cleared — and the click
  // below then lands on an emptied area.
  await win
    .waitForFunction(() => {
      const area = document.getElementById('viz-area');
      return !!area && !!area.querySelector('canvas') && !!chartInstances.get(area);
    }, undefined, { timeout: 60_000 })
    .catch(() => {});

  // Click a bar the way a user does — a real MouseEvent at that bar's own
  // coordinates, hit-tested by Chart.js. Calling the handler directly would skip
  // `chartMarkAt`, which is the part that decides which bar was clicked.
  //
  // Pick the TALLEST bar across every dataset, not data[0]. This visual carries
  // two measures on one axis — avg(amount) ≈ 38 beside sum(amount) ≈ 5.5M — so
  // the avg series draws as a half-pixel sliver on the baseline, and a click at
  // its centre lands outside the hit region. The tallest bar is a real target
  // whichever measure happens to be first.
  const clicked = await win.evaluate(() => {
    const area = document.getElementById('viz-area') as HTMLElement;
    const canvas = area.querySelector('canvas') as HTMLCanvasElement;
    const chart: any = chartInstances.get(area);
    if (!chart || !canvas) return { ok: false };

    // FINAL positions, not current ones. Bars animate up from the baseline and
    // `chartMarkAt` hit-tests with useFinalPosition=true, so a click aimed at a
    // mid-animation bar misses the region it is tested against — which made this
    // step pass or fail depending on how fast the machine drew.
    const bars: { x: number; cy: number; i: number; h: number }[] = [];
    chart.data.datasets.forEach((_: unknown, d: number) => {
      chart.getDatasetMeta(d).data.forEach((el: any, i: number) => {
        const p = el.getProps(['x', 'y', 'base'], true);
        if (typeof p.base !== 'number') return;
        bars.push({ x: p.x, cy: (p.y + p.base) / 2, i, h: Math.abs(p.base - p.y) });
      });
    });
    bars.sort((a, b) => b.h - a.h);
    const best = bars[0];
    if (!best || best.h < 2) return { ok: false, h: best ? best.h : -1 };

    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new MouseEvent('click', {
      clientX: rect.left + best.x,
      clientY: rect.top + best.cy,
      bubbles: true,
    }));
    return {
      ok: true,
      label: String(chart.data.labels[best.i]),
      bars: chart.data.labels.length,
      barPx: Math.round(best.h),
      // openDrillPanel is synchronous up to its first fetch, so the panel is
      // already visible here if the hit-test found the bar.
      opened: !!document.querySelector('.drill-backdrop:not([hidden])'),
    };
  });
  ok('clicking a bar opens the drill panel', clicked.ok === true && clicked.opened === true,
     JSON.stringify(clicked));

  await win
    .waitForFunction(() => {
      const n = document.querySelector('.js-drill-count');
      return !!n && /\d/.test(n.textContent || '');
    }, undefined, { timeout: 30_000 })
    .catch(() => {});

  const drill = await win.evaluate(() => {
    const panel = document.querySelector('.drill-panel') as HTMLElement | null;
    const back = document.querySelector('.drill-backdrop') as HTMLElement | null;
    return {
      open: !!panel && back?.hidden === false,
      count: (document.querySelector('.js-drill-count')?.textContent || '').trim(),
      chips: [...document.querySelectorAll('.drill-chip')].map((c) => (c.textContent || '').trim()),
      rows: document.querySelectorAll('.drill-scroll tbody tr').length,
      headers: [...document.querySelectorAll('.drill-scroll thead th')].map((t) => (t.textContent || '').trim()),
      noteShown: (document.querySelector('.js-drill-note') as HTMLElement)?.hidden === false,
      modal: panel?.getAttribute('aria-modal'),
      focusInside: !!panel && panel.contains(document.activeElement),
    };
  });
  // region0 → 142,858; every other region → 142,857 (1,000,000 = 7 × 142,857 + 1).
  const expected = clicked.label === 'region0' ? 142_858 : 142_857;
  ok('the panel is a focused, labelled dialog over the chart',
     drill.open && drill.modal === 'true' && drill.focusInside && !drill.noteShown,
     JSON.stringify({ open: drill.open, modal: drill.modal, focusInside: drill.focusInside }));
  ok(`…and its row total is the independently derived count for ${clicked.label}`,
     drill.count === expected.toLocaleString() + ' rows',
     `panel="${drill.count}" expected="${expected.toLocaleString()} rows"`);
  // Two chips: the visual's own filter, then the clicked mark. The mark chip is
  // the exact one asserted — it is what turns a bar into a row set. (The
  // reopened visual's `in` step comes back without its value list, so it selects
  // nothing and the count above is unchanged either way: `region in (…)` is a
  // superset of `region = region0`. That restore is a pre-existing bug in
  // openSavedVisual, not this panel's, so it is not encoded as an expectation.)
  ok('…with the visual\'s own filter AND the clicked mark shown as chips',
     drill.chips.length === 2 && /^region in/.test(drill.chips[0])
       && drill.chips[1] === `region = ${clicked.label}`,
     JSON.stringify(drill.chips));
  ok('…and it draws one page of that dataset\'s columns, not the whole set',
     drill.rows === 100 && JSON.stringify(drill.headers) === JSON.stringify(['region', 'sku', 'amount', 'note']),
     JSON.stringify({ rows: drill.rows, headers: drill.headers }));

  const drillShot = path.join(shotDir, 'drill-panel.png');
  await win.screenshot({ path: drillShot });
  ok('drill panel screenshot captured',
     fs.existsSync(drillShot) && fs.statSync(drillShot).size > 5000,
     `${Math.round(fs.statSync(drillShot).size / 1024)} KB -> ${drillShot}`);

  await win.keyboard.press('Escape');
  await win.waitForTimeout(500);
  ok('Escape closes the panel and returns focus to the chart',
     await win.evaluate(() => {
       const back = document.querySelector('.drill-backdrop') as HTMLElement | null;
       return !!back && back.hidden === true
         && document.getElementById('viz-area')?.getAttribute('aria-expanded') === 'false';
     }));


  await clickId('viz-cancel-btn');
  await win.waitForTimeout(600);

  // Leave the app on the Data section, where the rest of this file expects
  // to find it. (The Datasets nav item is labelled "Data" now.)
  await clickExact('Data');
  await win.waitForTimeout(800);

  // ── Refresh, end to end ───────────────────────────────────────────────────
  // The one check that proves the whole chain: a file on disk changes, the user
  // clicks ↻ Refresh, and the RENDERED row count follows. Every layer is real —
  // the stored origin, the re-read through the shared parser, updateDatasetData,
  // and the repaint. Nothing here is stubbed.
  const beforeRefresh = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')] as HTMLElement[];
    const row = rows.find((el) => /Refreshable/.test(el.textContent || ''));
    return {
      found: !!row,
      text: (row?.querySelector('.ds-saved-meta')?.textContent || ''),
      fresh: (row?.querySelector('.ds-fresh')?.textContent || ''),
      hasButton: !!row?.querySelector('.ds-saved-refresh'),
    };
  });
  ok('the file-backed dataset shows 2 rows and a ↻ Refresh button',
     beforeRefresh.found && /^2 rows/.test(beforeRefresh.text) && beforeRefresh.hasButton,
     JSON.stringify(beforeRefresh));
  ok('…with a "Data as of" freshness line rather than a bare timestamp',
     /Data as of/.test(beforeRefresh.fresh), `"${beforeRefresh.fresh}"`);

  // A dataset with no origin must NOT offer the button, and must say "Imported".
  const notRefreshable = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')] as HTMLElement[];
    const row = rows.find((el) => /By state/.test(el.textContent || ''));
    return {
      found: !!row,
      hasButton: !!row?.querySelector('.ds-saved-refresh'),
      fresh: row?.querySelector('.ds-fresh')?.textContent || '',
      titled: !!(row?.querySelector('.ds-fresh') as HTMLElement)?.title,
    };
  });
  ok('a dataset with no origin offers no Refresh button and reads "Imported"',
     notRefreshable.found && !notRefreshable.hasButton && /Imported/.test(notRefreshable.fresh)
     && notRefreshable.titled, JSON.stringify(notRefreshable));

  // Rewrite the CSV from OUTSIDE the app, exactly as an upstream export would.
  fs.writeFileSync(r.csvPath, 'city,visits\nOslo,10\nBergen,20\nTromso,30\nStavanger,40\n', 'utf8');

  ok('↻ Refresh is clickable on that row', await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')] as HTMLElement[];
    const row = rows.find((el) => /Refreshable/.test(el.textContent || ''));
    const btn = row?.querySelector('.ds-saved-refresh') as HTMLElement | undefined;
    if (!btn) return false;
    btn.click();
    return true;
  }));

  // Wait for the COUNT to change rather than sleeping a fixed amount: this is a
  // real file read plus a Parquet rewrite, and its latency tracks the host.
  await win
    .waitForFunction(
      () => {
        const rows = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')] as HTMLElement[];
        const row = rows.find((el) => /Refreshable/.test(el.textContent || ''));
        return /^4 rows/.test(row?.querySelector('.ds-saved-meta')?.textContent || '');
      },
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => {}); // fall through to the assertion, which reports what is there

  const afterRefresh = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')] as HTMLElement[];
    const row = rows.find((el) => /Refreshable/.test(el.textContent || ''));
    return {
      text: row?.querySelector('.ds-saved-meta')?.textContent || '',
      status: row?.querySelector('.ds-refresh-status')?.textContent || '',
      errored: !!row?.querySelector('.ds-fresh-dot'),
    };
  });
  ok('refreshing re-reads the changed file and the rendered row count follows',
     /^4 rows/.test(afterRefresh.text), JSON.stringify(afterRefresh));
  ok('…with no error state left on the row',
     !afterRefresh.errored && afterRefresh.status === '', JSON.stringify(afterRefresh));

  // And the failure half of the contract: delete the file, refresh, and the
  // stored rows must survive.
  fs.rmSync(r.csvPath);
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')] as HTMLElement[];
    const row = rows.find((el) => /Refreshable/.test(el.textContent || ''));
    (row?.querySelector('.ds-saved-refresh') as HTMLElement | undefined)?.click();
  });
  await win
    .waitForFunction(
      () => {
        const rows = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')] as HTMLElement[];
        const row = rows.find((el) => /Refreshable/.test(el.textContent || ''));
        return !!row?.querySelector('.ds-refresh-status.is-error');
      },
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => {});
  const afterFailure = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')] as HTMLElement[];
    const row = rows.find((el) => /Refreshable/.test(el.textContent || ''));
    return {
      text: row?.querySelector('.ds-saved-meta')?.textContent || '',
      status: row?.querySelector('.ds-refresh-status')?.textContent || '',
      isError: !!row?.querySelector('.ds-refresh-status.is-error'),
    };
  });
  ok('a refresh whose file has vanished reports inline, never in an alert',
     afterFailure.isError && /no longer at/.test(afterFailure.status), JSON.stringify(afterFailure));
  ok('…and the 4 rows it already had are still there',
     /^4 rows/.test(afterFailure.text), JSON.stringify(afterFailure));

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

  // Prefer a REAL control. A presentational wrapper can both match [class*=card]
  // and sit earlier in document order than the button inside it — clicking the
  // wrapper then does nothing, and every downstream assertion reports "nothing
  // rendered" rather than "the test clicked the wrong element".
  const clickText = (re: string) =>
    win.evaluate((src: string) => {
      const rx = new RegExp(src, 'i');
      const match = (sel: string) =>
        [...document.querySelectorAll(sel)].find((b) => rx.test(b.textContent || '')) as
          | HTMLElement
          | undefined;
      const el = match('button, a, [role=button]') || match('[class*=card], li');
      if (el) el.click();
      return !!el;
    }, re);

  // Re-open the project (no card to click) and jump to Visuals via the nav.
  await win.evaluate((id) => (window as any).openWorkspace?.(id), r.projectId);
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
      () => !!document.querySelector('svg[class*="plot-"], #viz-area canvas'), // #viz-area: gallery thumbs are canvases too
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
      canvases: document.querySelectorAll('#viz-area canvas').length, // scoped: gallery thumbs are canvases too
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

  // ── The deferred export bundles ────────────────────────────────────────────
  // The map assertions above already prove the 'map' bundle loads on demand
  // under the real hub CSP — a map rendered, and this run fails on any renderer
  // console error, which a refused <script src> would be. The three EXPORT
  // bundles have no such witness: nothing in this run opens a PDF/PPT/Word
  // export, so without this block they would be deferred and unverified, and a
  // broken one would surface as "PDF engine not loaded" on a user's machine.
  //
  // Asserted in both directions. Absent-at-startup is the half that would rot
  // silently: if someone re-adds a static <script> tag, every ensureBundle()
  // still resolves and every export still works, so only the ABSENCE check
  // notices that the saving was quietly given back.
  const lazyExports = await win.evaluate(async () => {
    const w = window as any;
    const before = { pdf: !!w.pdfMake, pptx: !!w.PptxGenJS, docx: !!w.docx };
    const loaded = {
      pdf: await w.ensureBundle('pdf'),
      pptx: await w.ensureBundle('pptx'),
      docx: await w.ensureBundle('docx'),
    };
    return {
      before,
      loaded,
      after: { pdf: !!w.pdfMake, pptx: !!w.PptxGenJS, docx: !!w.docx },
      // Order proof, done the only way that cannot be faked: actually build a
      // PDF. vfs_fonts.js does not set a property to check — it CALLS
      // pdfMake.addVirtualFileSystem(), guarded on pdfMake already existing. So
      // if the two ever loaded concurrently (a dynamically inserted <script> is
      // async by default, which is why lazyScript sets async = false) the fonts
      // would silently never register, every property check would still pass,
      // and the failure would appear only when a user exported a PDF.
      pdfBuilds: await w.pdfMake
        .createPdf({ content: 'smoke' })
        .getBase64()
        .then((b: string) => typeof b === 'string' && b.length > 100)
        .catch(() => false),
      docxUsable: !!(w.docx && w.docx.Packer),
    };
  });
  ok('the export engines are ABSENT at startup — the 3,411K is genuinely not parsed',
     !lazyExports.before.pdf && !lazyExports.before.pptx && !lazyExports.before.docx,
     JSON.stringify(lazyExports.before));
  ok('...and each loads on demand under the real hub CSP (script-src \'self\')',
     lazyExports.loaded.pdf && lazyExports.loaded.pptx && lazyExports.loaded.docx,
     JSON.stringify(lazyExports.loaded));
  ok('...defining the globals the export paths guard on',
     lazyExports.after.pdf && lazyExports.after.pptx && lazyExports.after.docx,
     JSON.stringify(lazyExports.after));
  ok('...with intra-bundle order preserved — a real PDF builds, so the fonts registered',
     lazyExports.pdfBuilds);
  ok('...and docx exposing Packer, which exportDocx checks before building',
     lazyExports.docxUsable);

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
  if (failureCount()) {
    console.error(`${failureCount()} smoke check(s) FAILED.`);
    process.exit(1);
  }
  console.log('All app smoke checks passed.');
}

main().catch((err) => {
  console.error('SMOKE DRIVER ERROR:', err && err.message ? err.message : err);
  process.exit(1);
});
