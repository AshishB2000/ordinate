// The bundled sample project: seeded once, computes real figures, deletes clean.
//
// The assertion that matters is that every tile on the sample dashboard returns
// a NON-NULL computed value, through the same `dashboard:metric` and `visual:data`
// paths the app uses. A dashboard whose tiles all render "—" would satisfy every
// structural check — right card count, right kinds, right layout — while being
// exactly the broken first impression the sample exists to prevent. So the KPIs
// and the charts are actually computed here.
//
//   npm run build:ts && node scripts/test-sampleProject.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const REPO = path.resolve(__dirname, '..');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-sample-'));
const ipcHandlers = new Map<string, (e: unknown, payload: unknown) => Promise<any>>();

// The stub goes in BEFORE the first require of anything that reads app paths:
// visuals.ts and analysis.ts memoize their projects base on first use, so a late
// stub writes into the developer's real userData.
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      // getAppPath is the repo root, exactly as it is in dev — that is how the
      // seeder finds the committed CSV.
      app: { getPath: (_name: string) => tmpUserData, getAppPath: () => REPO },
      ipcMain: {
        handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<any>) => { ipcHandlers.set(ch, fn); },
      },
      net: {},
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysisStore: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');
const ipcDashboards: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');

/** Every file under a directory, recursively. */
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

async function main(): Promise<void> {
  ipcVisuals.register();
  ipcDashboards.register();
  await projects.init();

  // ── Seeding ──────────────────────────────────────────────────────────────
  const first = await sample.seedSampleProject();
  ok('seeding reports that it seeded', first.seeded === true && !!first.projectId, JSON.stringify(first));

  const all = await projects.listProjects();
  ok('it creates the sample project and an empty one to work in', all.length === 2,
    JSON.stringify(all.map((p: any) => p.name)));
  // Newest first (projects.listProjects sorts by updatedAt), so [0] is the one
  // resolveProjectId adopts. If the sample were newest, the user's first real
  // import would land inside it.
  ok('…and the EMPTY one is newest, so the sample is never the working project',
    all[0].name === sample.FIRST_PROJECT_NAME, JSON.stringify(all.map((p: any) => p.name)));

  const pid = String(first.projectId);
  const ds = await datasets.listDatasets(pid);
  ok('the sample dataset is imported', ds.length === 1 && ds[0].name === sample.SAMPLE_DATASET_NAME,
    JSON.stringify(ds.map((d: any) => d.name)));
  ok('…with every row of the committed CSV', ds[0] && ds[0].rowCount === 5000, String(ds[0] && ds[0].rowCount));

  const meta = await datasets.getDatasetMeta(pid, ds[0].id);
  const typeOf = (n: string): string => {
    const c = (meta!.columns as any[]).find((x) => x.name === n);
    return c ? c.type : '(missing)';
  };
  // Through the ORDINARY parser. A measure typed as text would make `sum` a
  // loud binder error and every KPI a dash.
  ok('…typed by the ordinary parse path: the date is a date',
    typeOf('order_date') === 'date', typeOf('order_date'));
  ok('…the measures are numbers',
    ['units', 'unit_price', 'discount', 'revenue', 'profit', 'ship_days'].every((c) => typeOf(c) === 'number'),
    ['units', 'unit_price', 'discount', 'revenue', 'profit', 'ship_days'].map((c) => c + ':' + typeOf(c)).join(' '));
  ok('…and the map joins on a TEXT state column', typeOf('state') === 'text', typeOf('state'));

  const vis = await visuals.listVisuals(pid);
  ok('three visuals are saved', vis.length === 3, JSON.stringify(vis.map((v: any) => v.name)));
  const anList = await analysisStore.listAnalyses(pid);
  ok('one dashboard is created', anList.length === 1, JSON.stringify(anList.map((a: any) => a.name)));

  const dash = await analysisStore.getAnalysis(pid, anList[0].id);
  const cards: any[] = dash!.sheets[0].cards;
  ok('the sample dashboard has at least five tiles', cards.length >= 5, String(cards.length));
  ok('…four KPIs, three charts and a note',
    cards.filter((c) => c.type === 'metric').length === 4
    && cards.filter((c) => c.type === 'visual').length === 3
    && cards.filter((c) => c.type === 'text').length === 1,
    JSON.stringify(cards.map((c) => c.type)));

  // ── Every computed tile returns a real figure ────────────────────────────
  const metricCards = cards.filter((c) => c.type === 'metric');
  const metricResults: any[] = [];
  for (const c of metricCards) {
    const res = await ipcHandlers.get('dashboard:metric')!(null, {
      projectId: pid, datasetId: c.metric.datasetId, column: c.metric.column,
      aggregation: c.metric.aggregation, filters: [],
    });
    metricResults.push({ label: c.metric.label, value: res && res.value });
  }
  ok('every KPI computes a real number, not a dash',
    metricResults.length === 4 && metricResults.every((m) => typeof m.value === 'number' && Number.isFinite(m.value)),
    JSON.stringify(metricResults));
  // Sanity on the figures themselves — a sum of 0 would pass a null check and
  // still be a broken sample.
  const revenue = metricResults.find((m) => m.label === 'Revenue');
  ok('…and revenue is a plausible total, not zero', revenue && revenue.value > 100000, JSON.stringify(revenue));

  const visualCards = cards.filter((c) => c.type === 'visual');
  const drawn: any[] = [];
  for (const c of visualCards) {
    const v = await visuals.getVisual(pid, c.visualId);
    const res: any = await ipcVisuals.vizDataFor(pid, v!.datasetId, v!.encoding, v!.filters || []);
    drawn.push({
      name: v!.name,
      type: v!.chartType,
      labels: res && res.ok && res.data ? res.data.labels.length : 0,
      series: res && res.ok && res.data ? res.data.series.length : 0,
      error: res && res.ok === false ? res.error : '',
    });
  }
  ok('every chart computes data to draw',
    drawn.length === 3 && drawn.every((d) => d.labels > 0 && d.series > 0), JSON.stringify(drawn));
  ok('…the month line spans two years of data',
    (drawn.find((d) => d.type === 'line') || { labels: 0 }).labels >= 24, JSON.stringify(drawn));
  ok('…and the choropleth resolves real states',
    (drawn.find((d) => d.type === 'map_choropleth') || { labels: 0 }).labels >= 20, JSON.stringify(drawn));

  // ── Starred, so Home is not empty ────────────────────────────────────────
  ok('the dashboard is pinned to Home',
    execConfig.publicConfig().starred.includes('analysis:' + anList[0].id),
    JSON.stringify(execConfig.publicConfig().starred));

  // ── The renderer's copy of the dataset name ──────────────────────────────
  // homeAsk.ts swaps in sample-specific ask chips by matching this name, and the
  // renderer is a classic <script> that cannot import from main. Two spellings
  // of one string is the shape that drifts, so they are pinned together.
  const homeAsk = fs.readFileSync(path.join(REPO, 'renderer', 'hub', 'homeAsk.ts'), 'utf8');
  const m = /^const HA_SAMPLE_DATASET = '([^']*)';$/m.exec(homeAsk);
  ok('homeAsk.ts declares the sample dataset name', Boolean(m));
  ok('…identical to sampleProject.ts\'s', Boolean(m) && m![1] === sample.SAMPLE_DATASET_NAME,
    `renderer=${m ? m[1] : '(none)'} main=${sample.SAMPLE_DATASET_NAME}`);

  // ── Seeding twice is a no-op ─────────────────────────────────────────────
  // The flag records that seeding HAPPENED, not that the sample still exists —
  // otherwise deleting it would be undone on the next launch.
  const second = await sample.seedSampleProject();
  ok('a second launch does not seed again', second.seeded === false, JSON.stringify(second));
  ok('…and creates no extra project', (await projects.listProjects()).length === 2);

  // ── Deleting leaves nothing behind ───────────────────────────────────────
  const parquetBefore = walk(path.join(tmpUserData, 'projects')).filter((f) => f.endsWith('.parquet'));
  ok('the sample stored real Parquet tables', parquetBefore.length >= 1, String(parquetBefore.length));

  ok('deleting the sample project succeeds', await projects.deleteProject(pid));
  ok('…its directory is gone', !fs.existsSync(path.join(tmpUserData, 'projects', pid)));
  const leftovers = walk(path.join(tmpUserData, 'projects'))
    .filter((f) => f.endsWith('.parquet') || f.includes(pid));
  ok('…leaving no orphan Parquet anywhere under userData', leftovers.length === 0,
    JSON.stringify(leftovers));

  const third = await sample.seedSampleProject();
  ok('…and it is not re-seeded on the next launch', third.seeded === false, JSON.stringify(third));

  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
}

main()
  .then(() => {
    if (failureCount()) {
      console.error('\n' + failureCount() + ' sample-project check(s) FAILED');
      process.exit(1);
    }
    console.log('\nAll sample-project checks passed.');
  })
  .catch((err) => { console.error(err); process.exit(1); });
