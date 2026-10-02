// The shared launch + fixture the smoke files built out of smoke-app.ts use.
//
// smoke-app.ts was one 3,725-line run: one Electron launch, one fixture, and
// every surface asserted in sequence off the state the previous surface left
// behind. Splitting it by surface means each file launches its own app, so the
// ~230 lines of launch-and-seed would have been copied nine times — and nine
// copies of a fixture is nine chances for one to drift and quietly stop
// describing what the assertions above it claim.
//
// So the parts that are IDENTICAL in every file live here, and nothing else
// does. Assertions never do: this module imports no `ok`, makes no claim, and
// returns plain values for the caller to assert on. A helper that asserted
// would move coverage out of the file that reports it.
//
// Three groups:
//   launchSmoke()  — the Electron launch, the console/pageerror capture, and
//                    the SPLASH wait, which is load-bearing (see below).
//   seedProject()  — the fixture, through the same main-process modules
//                    main.js registered its IPC handlers against.
//   seedAnalysis() / domDriver() — for the files that need an analysis already
//                    on disk, or the little click-by-text driver.

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

// playwright is a devDependency; its Electron driver talks to the app over the
// DevTools protocol, so it needs no screen-capture or accessibility permission.
const { _electron }: typeof import('playwright') = require('playwright');

type Playwright = typeof import('playwright');
type ElectronApp = Awaited<ReturnType<Playwright['_electron']['launch']>>;
type Win = Awaited<ReturnType<ElectronApp['firstWindow']>>;

export const REPO = path.resolve(__dirname, '..');

export interface Smoke {
  app: ElectronApp;
  win: Win;
  /** Every renderer console error and pageerror seen since the launch. */
  errors: string[];
  /** Re-run after any reload — the splash comes back with the page. */
  killSplash: () => Promise<void>;
  userData: string;
  shotDir: string;
  /** Close the app and remove the throwaway userData dir. */
  close: () => Promise<void>;
}

/**
 * Launch the real app against a throwaway userData dir, so a developer's own
 * projects are untouched, and wait the splash out.
 *
 * THE SPLASH IS THE TRAP. The first paint is a loading screen: a screenshot or
 * a DOM check taken there passes every size and presence assertion while
 * proving nothing, and that cost a false pass once already. Every caller gets
 * the wait whether it remembers to ask for one or not.
 */
export async function launchSmoke(tag: string): Promise<Smoke> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-smoke-' + tag + '-'));
  const shotDir = process.env.SMOKE_ARTIFACT_DIR || userData;

  const app = await _electron.launch({
    args: [
      '.',
      '--password-store=basic',
      '--user-data-dir=' + userData,
      // MapLibre needs a real WebGL context. Under xvfb there is no GPU, and
      // modern Chromium refuses to fall back to its software rasteriser for
      // WebGL unless explicitly told it may — so without this a map renders the
      // app's honest "This map needs WebGL" fallback and the map assertions
      // fail on CI while passing on any developer machine.
      //
      // SwiftShader is slower but it is a REAL GL implementation: the same
      // MapLibre code path, the same shaders, the same tile requests.
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

  const killSplash = async (): Promise<void> => {
    await win.evaluate(() => {
      const s = document.querySelector('#splash, .splash, [class*=splash], [id*=splash]');
      if (s) s.remove();
    }).catch(() => { /* the splash is already gone */ });
  };

  await win.waitForTimeout(3000);
  await killSplash();

  const close = async (): Promise<void> => {
    await closeApp(app);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
  };

  return { app, win, errors, killSplash, userData, shotDir, close };
}

/**
 * Close the app, but never wait on it for more than 15 seconds.
 *
 * Playwright's close() resolves only once the Electron process has exited AND
 * its stdio pipes have closed. Anything the app spawned inherits those pipes —
 * on Linux a reveal runs xdg-open, which can start a browser that outlives the
 * app — and then close() never resolves: smoke-reports hung CI for six hours
 * after its last passing assertion. Past the deadline the process is killed and
 * the smoke goes on to its own exit, which the runner then sees.
 */
export async function closeApp(app: ElectronApp, ms = 15_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((r) => { timer = setTimeout(() => r('late'), ms); });
  const res = await Promise.race([app.close().then(() => 'closed' as const, () => 'closed' as const), late]);
  clearTimeout(timer);
  if (res === 'late') {
    console.warn(`[smoke] app.close() did not finish in ${ms / 1000}s — killing the app`);
    try { app.process().kill('SIGKILL'); } catch (_) { /* already gone */ }
  }
}

/** Reload the renderer and wait the splash out again. */
export async function reloadSmoke(s: Smoke): Promise<void> {
  await s.win.reload();
  await s.win.waitForLoadState('domcontentloaded');
  await s.win.waitForTimeout(3000);
  await s.killSplash();
}

export interface Fixture {
  bareProjectId: string;
  projectId: string;
  datasetId: string;
  rowCount: number;
  resident: boolean;
  geoDatasetId: string;
  visualId: string;
  mapVisualId: string;
  fileDatasetId: string;
  fileDatasetRows: number;
  csvPath: string;
  oldStamp: string;
}

/**
 * The fixture, written through the same module instances main.js registered
 * its IPC handlers against — `process.mainModule.require` returns those, not
 * fresh copies, so this is the shipped code path.
 *
 * `rows` is a knob because it is the run's whole cost. Only the files that
 * ASSERT on a million rows (the engine's own timings, the wizard's rendered
 * "1,000,000", the drill panel's independently derived 142,857) pay for one;
 * every other surface reads the same shapes off a few thousand.
 */
export async function seedProject(
  app: ElectronApp,
  opts: { rows?: number } = {},
): Promise<Fixture> {
  const rows = opts.rows ?? 1_000_000;
  return app.evaluate(async (_electron, n: number) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const datasets = req('./src/data/datasets.js');
    const visuals = req('./src/analysis/visuals.js');
    const out: any = {};

    await projects.init();
    // Datasets but no visuals — the state the Visuals empty page describes and
    // the main project never can. Created FIRST so 'Smoke test' stays newest.
    const bare = await projects.createProject('Empty gallery');
    await datasets.saveDataset(bare.id, { name: 'Signups', sourceKind: 'csv',
      columns: [{ name: 'city', type: 'text' }, { name: 'n', type: 'number' }],
      rows: [['Austin', 12], ['Denver', 7], ['Reno', 3]] });
    out.bareProjectId = bare.id;

    const proj = await projects.createProject('Smoke test');
    out.projectId = proj && proj.id;

    // The correctness-sensitive shapes: leading zeros, '', negatives. Seven
    // regions whatever `n` is, because several surfaces count them.
    const data: any[][] = [];
    for (let i = 0; i < n; i++) {
      data.push([
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
      rows: data,
    });
    out.datasetId = ds && ds.id;
    out.rowCount = ds && ds.rowCount;

    const meta = await datasets.getDatasetMeta(proj.id, ds.id);
    out.resident = !!(meta && meta.resident);

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
    out.geoDatasetId = geoDs && geoDs.id;
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
    // file origin — the fixture the refresh chain needs. Everything else here
    // is saved from in-memory rows; this one has to be a file, because the
    // whole point is re-reading it after it changes.
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
  }, rows);
}

export interface SeedCard {
  type: 'visual' | 'control' | 'metric';
  visualId?: string;
  control?: { kind: string; label: string; datasetId: string; column: string };
  metric?: { datasetId: string; column: string; aggregation: string; label?: string };
  layout: { x: number; y: number; w: number; h: number };
}

/**
 * Write an analysis record straight through main, for the files whose subject
 * is what happens ON an open dashboard rather than how one gets created. The
 * wizard that creates one for real is asserted in smoke-analysis-create.ts;
 * repeating that click-path in five more files would make every one of them a
 * second, weaker test of the wizard.
 */
export async function seedAnalysis(
  app: ElectronApp,
  projectId: string,
  spec: { name: string; sheets: { name: string; cards: SeedCard[] }[] },
): Promise<string> {
  return app.evaluate(async (_electron, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const analysis = req('./src/analysis/analysis.js');
    const { randomUUID } = req('crypto');
    const rec = await analysis.saveAnalysis(arg.projectId, {
      name: arg.spec.name,
      sheets: arg.spec.sheets.map((s: any) => ({
        id: randomUUID(),
        name: s.name,
        cards: s.cards.map((c: any) => ({ ...c, id: randomUUID() })),
      })),
    });
    return rec ? rec.id : '';
  }, { projectId, spec });
}

/**
 * Open a seeded analysis the way a user does — the Dashboards list, then the
 * card body. Returns false if the card is not on screen, which the caller
 * asserts on: everything downstream reads an open sheet.
 */
export async function openSeededAnalysis(win: Win, name: string): Promise<boolean> {
  const found = await win.evaluate((n: string) => {
    const row = [...document.querySelectorAll('#an-list .an-card')]
      .find((c) => (c.textContent || '').includes(n)) as HTMLElement | undefined;
    const openBtn = row?.querySelector('.an-card-body') as HTMLElement | undefined;
    if (!openBtn) return false;
    openBtn.click();
    return true;
  }, name);
  if (found) await win.waitForTimeout(3000);
  return found;
}

/** Open a project in the renderer, the same entry point a Recent item uses. */
export async function openProject(win: Win, projectId: string): Promise<void> {
  await win.evaluate((id: string) => { (window as any).openWorkspace?.(id); }, projectId);
  await win.waitForTimeout(1500);
}

export interface DomDriver {
  /** Click a visible control by its exact text, leaving an open analysis first if need be. */
  clickExact: (text: string) => Promise<boolean>;
  /** Click a visible element by id. */
  clickId: (id: string) => Promise<boolean>;
  /** Answer the OPEN prompt modal (not the first one in the document). */
  fillPrompt: (value: string) => Promise<boolean>;
  /** Take the first option of the OPEN chooser modal. */
  pickFirstOption: () => Promise<boolean>;
}

/**
 * The little DOM driver every analysis file needs.
 *
 * `clickExact` models focus mode rather than reaching past it: an OPEN ANALYSIS
 * hides the project nav exactly as the reference does, so the section buttons
 * are genuinely unreachable until the analysis is closed and "‹ Back" is the
 * way out. A test that could still click a hidden nav item would be asserting
 * a UI the user does not have.
 *
 * `fillPrompt`/`pickFirstOption` target the OPEN overlay because the Data
 * section's import dialog is static markup (hidden until used), so a bare
 * `.ws-modal-overlay` query finds THAT rather than the modal under test — and
 * visibility is getClientRects(), NOT offsetParent, since an overlay is
 * position:fixed and its offsetParent is null whether shown or not.
 */
export function domDriver(win: Win): DomDriver {
  const hit = async (t: string): Promise<boolean> =>
    win.evaluate((x: string) => {
      const el = [...document.querySelectorAll('button, a, [role=button], li')].find(
        (b) => (b as HTMLElement).offsetParent !== null && (b.textContent || '').trim() === x,
      ) as HTMLElement | undefined;
      if (!el) return false;
      el.click();
      return true;
    }, t);

  const clickExact = async (text: string): Promise<boolean> => {
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
    win.evaluate((i: string) => {
      const el = document.getElementById(i) as HTMLElement | null;
      if (!el || el.hidden) return false;
      el.click();
      return true;
    }, id);

  const fillPrompt = async (value: string): Promise<boolean> =>
    win.evaluate((v: string) => {
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

  return { clickExact, clickId, fillPrompt, pickFirstOption };
}

/**
 * The two rail helpers the analysis workbench files share: open a flyout by
 * its rail icon, and open Properties the only way in — a card's ⚙.
 */
export function railDriver(win: Win): {
  openPane: (pane: string) => Promise<void>;
  openProps: () => Promise<void>;
} {
  const openPane = async (pane: string): Promise<void> => {
    await win.evaluate((p: string) => {
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
  return { openPane, openProps };
}

/** The verdict line every smoke file ends on. */
export function finishSmoke(label: string, failures: number): void {
  console.log('');
  if (failures) {
    console.error(`${failures} ${label} smoke check(s) FAILED.`);
    process.exit(1);
  }
  console.log(`All ${label} smoke checks passed.`);
  // Exit explicitly: a handle the app or Playwright left open must never turn
  // a passing smoke into a hung one.
  process.exit(0);
}
