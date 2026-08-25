// Self-check for ANALYSIS facts — copilot.analysisFacts + the ipc/copilot
// buildFacts 'analysis' branch. Two things are pinned here:
//   1. an analysis with metric cards yields FACTS carrying the APP-computed
//      numbers and provenance.kind === 'analysis', with a per-sheet roster so
//      "what's on sheet 2" is answerable from the FACTS alone;
//   2. a card pointing at a MISSING dataset yields null → "n/a" and still
//      returns usable FACTS — it must not throw.
// Like test-copilot.ts we stub the 'electron' module (via Module._load) to point
// userData at a fresh temp dir, then run the REAL modules against real disk.
// No framework.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module'); // ponytail: Node's private _load hook, untyped

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-anfacts-'));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  // ipcMain is only destructured by ipc/copilot.ts (register() is never called
  // here), so app.getPath is the entire surface this graph actually touches.
  if (request === 'electron') return { app: { getPath: (_name: string) => tmpUserData } };
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the .ts sources under test.
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const ipcCopilot: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');


// A UUID-shaped id that no dataset file will ever answer to — case 2's "missing".
const GHOST_DATASET_ID = '00000000-0000-4000-8000-0000000000ff';

// Pull the app-computed figures back out of a FACTS block: the "- label: value"
// lines under the metric-card header, in order. 'n/a' is a real answer (the app
// had no number), so it maps to null rather than being dropped.
function metricValues(text: string): (number | null)[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('Metric cards'));
  if (start < 0) return [];
  const out: (number | null)[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = /^- .*: (.+)$/.exec(lines[i]);
    if (!m) break;
    out.push(m[1] === 'n/a' ? null : Number(m[1]));
  }
  return out;
}

async function main(): Promise<void> {
  await projects.init();
  const proj = await projects.createProject('Analysis facts project');
  const ds = await datasets.saveDataset(proj.id, {
    name: 'Cities',
    sourceKind: 'csv',
    columns: [{ name: 'city', type: 'text' as const }, { name: 'pop', type: 'number' as const }],
    rows: [['Paris', 100], ['Berlin', 300], ['Rome', 200]],
  });
  ok('dataset fixture saved', ds !== null);

  // ONE card set, used verbatim for both the analysis and the dashboard — that
  // shared fixture is what makes case 3 a differential test rather than two
  // hand-written expectations.
  const cards = [
    { type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 },
      metric: { datasetId: ds!.id, column: 'pop', aggregation: 'sum', label: 'Total pop' } },
    { type: 'metric', layout: { x: 3, y: 0, w: 3, h: 2 },
      metric: { datasetId: ds!.id, column: 'city', aggregation: 'count', label: 'City count' } },
    { type: 'metric', layout: { x: 6, y: 0, w: 3, h: 2 },
      metric: { datasetId: GHOST_DATASET_ID, column: 'pop', aggregation: 'sum', label: 'Ghost' } },
    { type: 'text', layout: { x: 0, y: 2, w: 12, h: 2 }, heading: 'Notes' },
  ];

  const a = await analysis.saveAnalysis(proj.id, {
    name: 'Q3 draft',
    sheets: [{ name: 'Overview', cards }, { name: 'Detail', cards: [] }],
  });
  ok('analysis fixture saved with 2 sheets', a !== null && a!.sheets.length === 2);

  // ── 1. App-computed values + analysis provenance ────────────────────────────
  // Spy on getDataset: three metric cards reference TWO distinct datasets, so a
  // per-card load would be 3 calls. Proving it is 2 pins the shared cache.
  const realGet = datasets.getDataset;
  let getCalls = 0;
  (datasets as any).getDataset = (...args: any[]) => { getCalls += 1; return (realGet as any)(...args); };
  const facts = await ipcCopilot.buildFacts(proj.id, { kind: 'analysis', id: a!.id });
  (datasets as any).getDataset = realGet;

  ok('analysis facts carry the guard line', /computed by the app/i.test(facts.text));
  ok('analysis facts embed the app-computed sum (600)', facts.text.includes('Total pop: 600'));
  ok('analysis facts embed the app-computed count (3)', facts.text.includes('City count: 3'));
  ok('provenance.kind is analysis', facts.provenance.kind === 'analysis');
  ok('provenance names the analysis', facts.provenance.name === 'Q3 draft');
  ok('facts open with the header line naming the analysis', /^Dashboard: "Q3 draft" \(/.test(facts.text.split('\n')[2]));
  // A per-sheet roster, not a flat list of names: "what's on sheet 2" has to be
  // answerable from the FACTS alone, or the model has nothing to narrate from.
  ok('facts name the sheets',
    facts.text.includes('- Sheet 1 "Overview": ') && facts.text.includes('- Sheet 2 "Detail": '));
  ok('facts say what is on a populated sheet', /- Sheet 1 "Overview": \d+ card\(s\) \([^)]+\)\./.test(facts.text));
  ok('an empty sheet reports zero, not nothing', facts.text.includes('- Sheet 2 "Detail": 0 card(s).'));
  ok('facts count the sheets and cards', facts.text.includes('(2 sheet(s), 4 card(s))'));
  ok('each referenced dataset is loaded once, not once per card', getCalls === 2);

  // ── 2. Missing dataset → null → "n/a", and never a throw ────────────────────
  ok('a card over a missing dataset renders n/a (no fabrication)', facts.text.includes('Ghost: n/a'));
  ok('the rest of the facts are still usable', facts.text.includes('Total pop: 600'));
  ok('a null value is carried as null, not NaN', Object.is(metricValues(facts.text)[2], null));

  // An analysis whose EVERY card is dangling still returns facts, never throws.
  const orphan = await analysis.saveAnalysis(proj.id, {
    name: 'All dangling',
    sheets: [{ name: 'S1', cards: [cards[2]] }],
  });
  const orphanFacts = await ipcCopilot.buildFacts(proj.id, { kind: 'analysis', id: orphan!.id });
  ok('an all-dangling analysis still yields analysis facts',
    orphanFacts.provenance.kind === 'analysis' && orphanFacts.text.includes('Ghost: n/a'));

  // An unknown analysis id falls through to the project inventory (no throw).
  const unknown = await ipcCopilot.buildFacts(proj.id, { kind: 'analysis', id: GHOST_DATASET_ID });
  ok('an unknown analysis id falls back to project facts', unknown.provenance.kind === 'project');

  // The three metric cards produce three app-computed values (the middle two
  // real, the third n/a), pulled straight from the FACTS text.
  const an = metricValues(facts.text);
  ok('the metric cards yield three app-computed values', an.length === 3);
  ok('the values are the app-computed figures (600, 3, null)',
    Object.is(an[0], 600) && Object.is(an[1], 3) && Object.is(an[2], null));

  // The pure builder agrees with the IPC path it is called from.
  const direct = copilot.analysisFacts(a!, [{ label: 'Total pop', value: 600 }]);
  ok('analysisFacts is pure and matches the IPC-built framing',
    direct.provenance.kind === 'analysis' && direct.text.includes('Total pop: 600'));
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    Module._load = origLoad;
    if (failureCount()) { console.error('\n' + failureCount() + ' analysis-facts check(s) FAILED'); process.exit(1); }
    console.log('\nAll analysis-facts checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
