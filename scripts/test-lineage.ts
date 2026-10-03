// Self-check for src/analysis/lineage.ts, on the REAL sample project.
//
// The sample is seeded through sampleProject.seedSampleProject — the same path
// a first launch takes — and the graph is read through the real `lineage:get`
// handler, so a reference the loader stops reading is caught here, not in a
// screenshot.
//
//   1. The sample dataset's graph has what the smoke promises: the dataset, the
//      Month calculated field, three visuals and one dashboard.
//   2. It is COLUMN-LEVEL: "Revenue by month" hangs off Month; the other two
//      charts off the dataset.
//   3. Focus is paths THROUGH the record, not the whole project.
//   4. CYCLES ARE IMPOSSIBLE: every edge points left to right, including for an
//      input that tries to make one (two formula metrics naming each other).
//
//   npm run build:ts && node scripts/test-lineage.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const REPO = path.resolve(__dirname, '..');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-lineage-'));
// Handlers land in the RPC registry (src/ipc/bus.ts outside Electron), not the stub.
const ipcHandlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData, getAppPath: () => REPO },
      net: {}, dialog: {}, shell: {},
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the real modules.
const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
const lineage: typeof import('../src/analysis/lineage') = require('../src/analysis/lineage');
const reportSpec: typeof import('../src/analysis/reportSpec') = require('../src/analysis/reportSpec');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
require('../src/ipc/lineage').register();

type G = import('../src/analysis/lineage').FocusedLineage;
const get = (projectId: string, type: string, id: string): Promise<G> =>
  ipcHandlers.get('lineage:get')!({}, { projectId, type, id });

/** Every edge left to right, and a topological order that covers every node. */
function acyclic(g: G): boolean {
  const col = new Map(g.nodes.map((n) => [n.id, n.col as number]));
  if (!g.edges.every((e) => (col.get(e.from) as number) < (col.get(e.to) as number))) return false;
  const indeg = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  let seen = 0;
  while (queue.length) {
    const id = queue.shift()!;
    seen++;
    for (const e of g.edges.filter((x) => x.from === id)) {
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  return seen === g.nodes.length;
}

const named = (g: G, kind: string): string[] => g.nodes.filter((n) => n.kind === kind).map((n) => n.name).sort();
const inputsOf = (g: G, nodeId: string): string[] => g.edges.filter((e) => e.to === nodeId).map((e) => e.from);

async function main(): Promise<void> {
  const seeded = await sample.seedSampleProject();
  if (!seeded.seeded || !seeded.projectId || !seeded.analysisId) throw new Error('sample not seeded');
  const pid = seeded.projectId;
  const req = (m: string) => require(m);
  const datasetId = (await req('../src/data/datasets').listDatasets(pid))[0].id as string;
  const visuals = await req('../src/analysis/visuals').listVisuals(pid) as Array<{ id: string; name: string }>;

  // ── 1. the sample dataset ───────────────────────────────────────────────────
  const g = await get(pid, 'dataset', datasetId);
  ok('the graph is focused on the dataset', g.focus === 'dataset:' + datasetId);
  ok('…which is in it, named', named(g, 'dataset').join() === 'Retail orders', JSON.stringify(named(g, 'dataset')));
  ok('…with the Month calculated field', named(g, 'calc').join() === 'Month', JSON.stringify(named(g, 'calc')));
  ok('…three visuals', JSON.stringify(named(g, 'visual')) === JSON.stringify(['Profit by state', 'Revenue by category', 'Revenue by month']),
    JSON.stringify(named(g, 'visual')));
  ok('…and one dashboard', named(g, 'dashboard').join() === 'Retail overview', JSON.stringify(named(g, 'dashboard')));
  ok('…its source: the CSV it was imported from', named(g, 'source').join() === 'CSV file', JSON.stringify(named(g, 'source')));
  ok('…and the six metrics defined on it', named(g, 'metric').length === 6, JSON.stringify(named(g, 'metric')));
  ok('"Used in" counts what is downstream', g.usedIn.visual === 3 && g.usedIn.dashboard === 1 && g.usedIn.metric === 6,
    JSON.stringify(g.usedIn));
  ok('no cycle: every edge points left to right, and the order covers every node', acyclic(g));
  ok('columns run source → dataset → calculated field → metric → visual → dashboard',
    ['source', 'dataset', 'calc', 'metric', 'visual', 'dashboard']
      .map((k) => Math.min(...g.nodes.filter((n) => n.kind === k).map((n) => n.col as number)))
      .every((c, i, a) => i === 0 || c > a[i - 1]));

  // ── 2. column-level edges ───────────────────────────────────────────────────
  const byMonth = visuals.find((v) => v.name === 'Revenue by month')!;
  const byCat = visuals.find((v) => v.name === 'Revenue by category')!;
  ok('"Revenue by month" is built from the Month field',
    JSON.stringify(inputsOf(g, 'visual:' + byMonth.id)) === JSON.stringify([`calc:${datasetId}:Month`]));
  ok('"Revenue by category" is built from the dataset itself',
    JSON.stringify(inputsOf(g, 'visual:' + byCat.id)) === JSON.stringify(['dataset:' + datasetId]));
  const margin = g.nodes.find((n) => n.name === 'Margin %')!;
  ok('a formula metric is built from the metrics it names',
    inputsOf(g, margin.id).map((id) => g.nodes.find((n) => n.id === id)!.name).sort().join() === 'Profit,Revenue');
  ok('…and sits to their right', inputsOf(g, margin.id).every((id) => (g.nodes.find((n) => n.id === id)!.col as number) < (margin.col as number)));

  // ── 3. focus is paths through the record ────────────────────────────────────
  const v = await get(pid, 'visual', byMonth.id);
  ok('a visual\'s lineage: its source, dataset and field upstream, its dashboard downstream',
    named(v, 'source').length === 1 && named(v, 'calc').join() === 'Month' && named(v, 'dashboard').length === 1);
  ok('…and NOT its sibling charts or the metrics', named(v, 'visual').join() === 'Revenue by month' && named(v, 'metric').length === 0,
    JSON.stringify(v.nodes.map((n) => n.name)));
  const d = await get(pid, 'dashboard', seeded.analysisId);
  ok('a dashboard\'s lineage reaches back to all three visuals and the source',
    named(d, 'visual').length === 3 && named(d, 'source').length === 1 && d.usedIn.report === undefined);

  // Reports and alerts are the last column.
  const rep = await reportSpec.saveReport(pid, { analysisId: seeded.analysisId, name: 'Weekly retail' });
  const revenue = (await metrics.listMetrics(pid)).find((m) => m.name === 'Revenue')!;
  await alertStore.saveRule(pid, {
    name: 'Revenue dips', datasetId, compare: 'threshold', threshold: { op: '<', value: 1 },
    metric: { column: 'revenue', aggregation: 'sum', metricId: revenue.id },
  });
  const g2 = await get(pid, 'dataset', datasetId);
  ok('downstream of the dataset: the report on its dashboard and the alert on its metric',
    named(g2, 'report').join() === 'Weekly retail' && named(g2, 'alert').join() === 'Revenue dips');
  ok('…the alert hangs off the metric it watches',
    JSON.stringify(inputsOf(g2, g2.nodes.find((n) => n.kind === 'alert')!.id)) === JSON.stringify(['metric:' + revenue.id]));
  ok('…and the graph is still acyclic', acyclic(g2));
  const r = await get(pid, 'report', rep!.id);
  ok('a report\'s lineage runs all the way back to the CSV', named(r, 'source').length === 1 && named(r, 'dashboard').length === 1);

  // ── 4. an input built to loop cannot ────────────────────────────────────────
  const D = '40000000-0000-4000-8000-000000000001';
  const A = '40000000-0000-4000-8000-00000000000a';
  const B = '40000000-0000-4000-8000-00000000000b';
  const loop = lineage.buildGraph({
    datasets: [{ id: D, name: 'D', sourceKind: 'csv', steps: [] }],
    metrics: [
      { id: A, name: 'A', datasetId: D, definition: { formula: '[B] * 2' } },
      { id: B, name: 'B', datasetId: D, definition: { formula: '[A] / 2' } },
    ],
    visuals: [], dashboards: [], reports: [], alerts: [],
  });
  const fa = lineage.focus(loop, 'metric:' + A);
  ok('two metrics naming each other still lay out left to right — the closing edge is dropped',
    acyclic(fa) && fa.nodes.length === 2 && fa.edges.length === 1, JSON.stringify(fa.edges));

  // A combined dataset sits right of both parents.
  const P1 = '40000000-0000-4000-8000-000000000011';
  const P2 = '40000000-0000-4000-8000-000000000012';
  const C = '40000000-0000-4000-8000-000000000013';
  const comb = lineage.focus(lineage.buildGraph({
    datasets: [
      { id: P1, name: 'Orders', sourceKind: 'csv', steps: [] },
      { id: P2, name: 'Regions', sourceKind: 'csv', steps: [] },
      { id: C, name: 'Joined', sourceKind: 'combined', steps: [], origin: { kind: 'composed', baseId: P1, joins: [{ datasetId: P2, mode: 'left' }] } },
    ],
    metrics: [], visuals: [], dashboards: [], reports: [], alerts: [],
  }), 'dataset:' + C);
  const colOf = (id: string) => comb.nodes.find((n) => n.id === id)!.col as number;
  ok('a combined dataset is built from its parents and sits right of them',
    inputsOf(comb, 'dataset:' + C).sort().join() === ['dataset:' + P1, 'dataset:' + P2].sort().join()
    && colOf('dataset:' + C) > colOf('dataset:' + P1) && acyclic(comb));
  ok('an unknown focus is an empty graph, not a throw', lineage.focus(comb, 'dataset:nope').nodes.length === 0);
  ok('the handler refuses a traversal id', (await get(pid, 'dataset', '../../x')) === null);

  finish();
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
