// Self-check for the ASK ACTIVITY stream — the ordered progress steps
// buildFacts (src/ipc/copilot.ts) emits through its optional emitter. This is a
// DIFFERENTIAL check in the house style: the emitted stream must match the
// operations the function is KNOWN to perform for each kind, and — the honesty
// guardrail this whole feature turns on — NO step may carry a data value.
//
// Three things are pinned here:
//   1. The optional emitter DEFAULTS to a no-op: buildFacts(projectId, ctx) with
//      no third argument behaves and returns exactly as before (the contract
//      test-copilot-analysis-facts.ts also depends on), and passing an emitter
//      does not change the computed facts.
//   2. Each kind emits its exact ordered step set, mapping 1:1 to the functions
//      that ran (dataset: read → compute → quality; visual: read → read →
//      compute; dashboard: read → compute; unknown → project inventory).
//   3. NO emitted step contains a data VALUE — not a cell, not a metric total.
//      Counts of columns/rows/issues/metrics are facts and are allowed; a value
//      like the app-computed sum (600) is not, and must never leak into a chip.
// Like test-copilot.ts we stub 'electron' (via Module._load) to point userData at
// a fresh temp dir, then run the REAL modules against real disk. No framework.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module'); // ponytail: Node's private _load hook, untyped

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-askact-'));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: (_name: string) => tmpUserData } };
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the .ts sources under test.
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const dashboards: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');
const datasetStats: typeof import('../src/data/datasetStats') = require('../src/data/datasetStats');
const ipcCopilot: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');

type Step = import('../src/ipc/copilot').ActivityStep;


// The cell values planted in the fixture. NONE of them may appear in ANY step —
// that is the whole point of the feature (the model narrates values; the chips
// only ever name operations and counts).
const CELL_VALUES = ['Paris', 'Berlin', 'Rome', '100', '300', '200'];
function carriesDataValue(steps: Step[], forbidden: string[]): string | null {
  for (const s of steps) {
    const hay = String(s.label || '') + ' ' + String(s.detail || '');
    for (const v of forbidden) {
      // Word-ish match so "300 rows" wouldn't false-positive — but our fixtures
      // never have 100/200/300 rows, so a bare includes is the strict check.
      if (hay.includes(v)) return s.kind + ':' + hay + ' contains ' + v;
    }
    // Only the whitelisted keys may exist on a step.
    for (const k of Object.keys(s)) {
      if (k !== 'kind' && k !== 'label' && k !== 'detail' && k !== 'count') return 'unexpected key ' + k;
    }
    if (s.count !== undefined && typeof s.count !== 'number') return 'count is not a number: ' + String(s.count);
  }
  return null;
}
const kinds = (steps: Step[]): string[] => steps.map((s) => s.kind);

async function main(): Promise<void> {
  await projects.init();
  const proj = await projects.createProject('Activity project');
  const saved = await datasets.saveDataset(proj.id, {
    name: 'Cities',
    sourceKind: 'csv',
    columns: [{ name: 'city', type: 'text' as const }, { name: 'pop', type: 'number' as const }],
    rows: [['Paris', 100], ['Berlin', 300], ['Rome', 200]],
  });
  ok('dataset fixture saved', saved !== null);
  const ds = (await datasets.getDataset(proj.id, saved!.id))!;

  // ── 1. Default emitter is a no-op, and emitting does not change the facts ──
  const noEmitFacts = await ipcCopilot.buildFacts(proj.id, { kind: 'dataset', id: ds.id });
  const cap: Step[] = [];
  const withEmitFacts = await ipcCopilot.buildFacts(proj.id, { kind: 'dataset', id: ds.id }, (s) => cap.push(s));
  ok('the optional emitter defaults to a no-op (call with no emitter is unchanged)',
    typeof noEmitFacts.text === 'string' && noEmitFacts.provenance.kind === 'dataset');
  ok('passing an emitter does not change the computed facts (side-effect only)',
    withEmitFacts.text === noEmitFacts.text
      && JSON.stringify(withEmitFacts.provenance) === JSON.stringify(noEmitFacts.provenance));

  // ── 2. Dataset ask: read → compute → quality, exact labels + counts ───────
  ok('dataset emits exactly read → compute → quality',
    JSON.stringify(kinds(cap)) === JSON.stringify(['read', 'compute', 'quality']),
    JSON.stringify(kinds(cap)));
  ok('the read step names the dataset and counts rows (a count, not a value)',
    cap[0].kind === 'read' && cap[0].label === 'Read Cities' && cap[0].detail === '3 rows');
  ok('the compute step counts the columns it summarised',
    cap[1].kind === 'compute' && cap[1].label === 'Summarised 2 columns' && cap[1].count === 2);
  // The quality count is data-derived — assert it against the SAME pure function
  // buildFacts calls, so this stays a differential, not a hand-written number.
  const expectedIssues = datasetStats.findQualityIssues(ds.columns, ds.rows).length;
  ok('the quality step reports the real issue count from findQualityIssues',
    cap[2].kind === 'quality' && cap[2].label === 'Checked data quality'
      && cap[2].count === expectedIssues && cap[2].detail === expectedIssues + (expectedIssues === 1 ? ' issue found' : ' issues found'),
    JSON.stringify(cap[2]));
  ok('no dataset step carries a data value', carriesDataValue(cap, CELL_VALUES) === null,
    String(carriesDataValue(cap, CELL_VALUES)));
  ok('buildFacts never emits a model step (that is the ipc handler, not the facts)',
    !cap.some((s) => s.kind === 'model'));

  // ── 3. Visual ask: read (visual) → read (dataset) → compute ───────────────
  const viz = await visuals.saveVisual(proj.id, {
    name: 'Pop by city',
    datasetId: ds.id,
    chartType: 'bar',
    encoding: { category: 'city', values: [{ column: 'pop', aggregation: 'sum' }] },
    filters: [],
  });
  const vcap: Step[] = [];
  await ipcCopilot.buildFacts(proj.id, { kind: 'visual', id: viz!.id }, (s) => vcap.push(s));
  ok('visual emits exactly read → read → compute',
    JSON.stringify(kinds(vcap)) === JSON.stringify(['read', 'read', 'compute']), JSON.stringify(kinds(vcap)));
  ok('…naming the visual, then its dataset, then the chart-data build',
    vcap[0].label === 'Read Pop by city' && vcap[1].label === 'Read Cities' && vcap[2].label === 'Built chart data');
  ok('no visual step carries a data value', carriesDataValue(vcap, CELL_VALUES) === null);

  // ── 4. Dashboard ask: read → compute, and the metric TOTAL never leaks ────
  const cards = [
    { type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 },
      metric: { datasetId: ds.id, column: 'pop', aggregation: 'sum', label: 'Total pop' } },
    { type: 'metric', layout: { x: 3, y: 0, w: 3, h: 2 },
      metric: { datasetId: ds.id, column: 'city', aggregation: 'count', label: 'City count' } },
  ];
  const dash = await dashboards.saveDashboard(proj.id, { name: 'City board', pages: [{ name: 'P1', cards }] });
  const dcap: Step[] = [];
  const dFacts = await ipcCopilot.buildFacts(proj.id, { kind: 'dashboard', id: dash!.id }, (s) => dcap.push(s));
  ok('dashboard emits exactly read → compute', JSON.stringify(kinds(dcap)) === JSON.stringify(['read', 'compute']), JSON.stringify(kinds(dcap)));
  ok('…naming the dashboard, then counting the metrics computed (a count, not a total)',
    dcap[0].label === 'Read City board' && dcap[1].label === 'Computed 2 metrics' && dcap[1].count === 2);
  // The app-computed sum (600) IS in the facts the model narrates — and must NOT
  // be in any chip. This is the guardrail the whole feature turns on.
  ok('the facts DO carry the app-computed total…', dFacts.text.includes('Total pop: 600'));
  ok('…but NO activity step does (a value dressed as a finding is forbidden)',
    carriesDataValue(dcap, ['600']) === null && carriesDataValue(dcap, CELL_VALUES) === null);

  // ── 5. Unknown reference → project inventory, one 'inventory' step ────────
  const icap: Step[] = [];
  await ipcCopilot.buildFacts(proj.id, { kind: 'dataset', id: '00000000-0000-4000-8000-0000000000ff' }, (s) => icap.push(s));
  ok('an unresolved reference falls back to a single inventory step',
    JSON.stringify(kinds(icap)) === JSON.stringify(['inventory']) && icap[0].label === 'Scanned the project',
    JSON.stringify(icap));
  ok('the inventory step counts records, carries no value', carriesDataValue(icap, CELL_VALUES) === null);
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    Module._load = origLoad;
    if (failureCount()) { console.error('\n' + failureCount() + ' ask-activity check(s) FAILED'); process.exit(1); }
    console.log('\nAll ask-activity checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
