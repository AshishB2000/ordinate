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
    args: ['.', '--password-store=basic', '--user-data-dir=' + userData],
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
    for (let i = 0; i < 500_000; i++) {
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

    // NOTE: still the hydrating path, deliberately — this asserts the chart
    // math itself, and is the one place the smoke test pays for a full load.
    const full = await datasets.getDataset(proj.id, ds.id);
    const viz = vizData.buildVizData(full.columns, full.rows, {
      category: 'region',
      values: [{ column: 'amount', aggregation: 'sum' }],
    });
    out.labels = viz.data.labels;
    out.seriesName = viz.data.series[0] && viz.data.series[0].name;
    out.values = viz.data.series[0] && viz.data.series[0].values;
    out.metric = metricValue.computeMetric(full.columns, full.rows, {
      column: 'amount',
      aggregation: 'sum',
    });
    out.skuSample = full.rows.slice(0, 3).map((x: any[]) => x[1]);
    out.skuTypes = full.rows.slice(0, 3).map((x: any[]) => typeof x[1]);

    const v = await visuals.saveVisual(proj.id, {
      datasetId: ds.id,
      name: 'Sales by region',
      chartType: 'column',
      encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] },
    });
    out.visualId = v && v.id;
    return out;
  });

  ok('project created', !!r.projectId);
  ok('500k-row dataset saved — 10x the old 50k cap', r.rowCount === 500_000, `rowCount=${r.rowCount}`);
  ok('dataset is Parquet-backed', r.resident === true);
  ok('chart data computed', Array.isArray(r.labels) && r.labels.length === 7,
     `labels=${JSON.stringify(r.labels)}`);
  ok('series named by measureLabel', r.seriesName === 'sum of amount', `"${r.seriesName}"`);
  ok('chart values are JS numbers', r.values.every((v: unknown) => typeof v === 'number'),
     `first=${r.values[0]}`);
  ok('metric card computed', typeof r.metric === 'number', `sum=${r.metric}`);
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
      (e) => e.children.length === 0 && /500000 rows/.test(e.textContent || ''),
    );
    return el ? (el.textContent || '').trim().slice(0, 60) : null;
  });
  ok('dataset is listed in the UI with its row count', listed !== null, listed || 'not rendered');

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
