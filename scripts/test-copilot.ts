// Self-check for src/copilot.ts — the per-project chat store (persist/append/
// clear round-trip + the UUID traversal guard) AND the PURE context-fact builders
// (datasetFacts/visualFacts/dashboardFacts emit the app-computed numbers, the
// "app-computed" guard line, correct provenance, and fabricate NO figures). Also
// exercises the askCopilot not_ready path (no model configured → soft error, no
// network call). Like test-datasets.ts, we stub the 'electron' module (via
// Module._load) to point userData at a fresh temp dir, then run the REAL modules
// against real disk. No framework.

export {}; // module scope — sibling test scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-copilot-'));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    // Enough surface for the whole analyze module graph to load: app.getPath is
    // the only member touched at runtime here; net/nativeImage/ipcMain are only
    // destructured (never called on the not_ready path).
    return { app: { getPath: (_name: string) => tmpUserData } };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the .ts sources under test.
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const projects: typeof import('../src/projects') = require('../src/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const datasetStats: typeof import('../src/data/datasetStats') = require('../src/data/datasetStats');

let failures = 0;
function ok(label: string, cond: boolean) {
  if (cond) console.log('ok   ' + label);
  else { console.error('FAIL ' + label); failures++; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

async function main(): Promise<void> {
  await projects.init();
  await copilot.init(); // no-op stub

  const proj = await projects.createProject('Copilot project');
  ok('created a parent project', typeof proj.id === 'string' && proj.id.length > 0);

  // ── Store: empty → append → order/id/timestamp → reload survival ────────────
  let hist = await copilot.loadHistory(proj.id);
  ok('loadHistory is empty initially', Array.isArray(hist) && hist.length === 0);

  const afterUser = await copilot.appendTurn(proj.id, { role: 'user', text: 'How big is this?' });
  ok('appendTurn returns the updated list', Array.isArray(afterUser) && afterUser!.length === 1);
  ok('appendTurn assigns a UUID id', afterUser !== null && UUID_RE.test(afterUser![0].id));
  ok('appendTurn assigns an ISO createdAt',
    afterUser !== null && typeof afterUser![0].createdAt === 'string' &&
    !Number.isNaN(Date.parse(afterUser![0].createdAt)));
  ok('appendTurn clamps role to user', afterUser !== null && afterUser![0].role === 'user');

  const afterAsst = await copilot.appendTurn(proj.id, {
    role: 'assistant',
    text: 'It has 2 rows.',
    provenance: { kind: 'dataset', name: 'Cities', columns: ['city', 'pop'], note: 'stats app-computed' },
  });
  ok('second appendTurn grows the list to 2', afterAsst !== null && afterAsst!.length === 2);
  ok('assistant turn keeps whitelisted provenance',
    afterAsst !== null && afterAsst![1].provenance !== undefined &&
    afterAsst![1].provenance!.kind === 'dataset' && afterAsst![1].provenance!.name === 'Cities');
  ok('turn ids are unique', afterAsst !== null && afterAsst![0].id !== afterAsst![1].id);

  // Reload (fresh read from disk) → order + content survive.
  hist = await copilot.loadHistory(proj.id);
  ok('history survives a reload (2 turns, in order)',
    hist.length === 2 && hist[0].role === 'user' && hist[1].role === 'assistant');
  ok('reloaded text is intact', hist[0].text === 'How big is this?' && hist[1].text === 'It has 2 rows.');
  ok('copilot.json written to disk',
    fs.existsSync(path.join(tmpUserData, 'projects', proj.id, 'copilot.json')));

  // ── MAX_TURNS ring cap (200) ────────────────────────────────────────────────
  const capProj = await projects.createProject('Cap project');
  let capList: Awaited<ReturnType<typeof copilot.appendTurn>> = [];
  for (let i = 0; i < 205; i += 1) {
    capList = await copilot.appendTurn(capProj.id, { role: 'user', text: 'msg ' + i });
  }
  ok('MAX_TURNS caps the thread at 200', capList !== null && capList!.length === 200);
  ok('ring cap keeps the NEWEST turns (drops the oldest)',
    capList !== null && capList![capList!.length - 1].text === 'msg 204' && capList![0].text === 'msg 5');
  const capReload = await copilot.loadHistory(capProj.id);
  ok('cap survives a reload', capReload.length === 200);

  // ── clearHistory ─────────────────────────────────────────────────────────────
  const cleared = await copilot.clearHistory(proj.id);
  ok('clearHistory returns true', cleared === true);
  ok('clearHistory empties the thread', (await copilot.loadHistory(proj.id)).length === 0);
  ok('clearHistory of a missing file succeeds (force)', (await copilot.clearHistory(capProj.id)) === true && (await copilot.clearHistory(proj.id)) === true);

  // ── Guards: invalid id / project missing / dual-id traversal rejection ───────
  ok('appendTurn rejects a nonexistent (but UUID-shaped) project',
    (await copilot.appendTurn(ZERO_UUID, { role: 'user', text: 'x' })) === null);
  ok('appendTurn rejects a traversal projectId',
    (await copilot.appendTurn('..', { role: 'user', text: 'x' })) === null);
  ok('appendTurn rejects a nested traversal projectId',
    (await copilot.appendTurn('../../foo', { role: 'user', text: 'x' })) === null);
  ok('loadHistory rejects a traversal projectId', (await copilot.loadHistory('..')).length === 0);
  ok('clearHistory rejects a traversal projectId', (await copilot.clearHistory('..')) === false);

  // Traversal ops must NOT touch a sentinel one level above the project dir.
  const sentinel = path.join(tmpUserData, 'projects', 'DO_NOT_DELETE.txt');
  fs.writeFileSync(sentinel, 'keep');
  await copilot.clearHistory('..');
  ok('traversal clear did not delete files outside the project', fs.existsSync(sentinel));

  // ── Corrupt file skipped gracefully ─────────────────────────────────────────
  const corruptProj = await projects.createProject('Corrupt project');
  fs.writeFileSync(path.join(tmpUserData, 'projects', corruptProj.id, 'copilot.json'), '{ not valid json');
  ok('loadHistory skips a corrupt file (returns [])', (await copilot.loadHistory(corruptProj.id)).length === 0);

  // ── Context builders: app-computed numbers, guard line, no fabrication ───────
  // datasetFacts — build REAL summaries via datasetStats over a fixture dataset.
  const ds = await datasets.saveDataset(proj.id, {
    name: 'Cities',
    sourceKind: 'csv',
    columns: [{ name: 'city', type: 'text' as const }, { name: 'pop', type: 'number' as const }],
    rows: [['Paris', 100], ['Berlin', 300], ['Rome', 200]],
  });
  ok('dataset fixture saved', ds !== null);
  const summaries = ds!.columns.map((col, c) =>
    datasetStats.computeColumnSummary(col, ds!.rows.map((row) => (row ? row[c] ?? null : null))));
  const issues = datasetStats.findQualityIssues(ds!.columns, ds!.rows);
  const dFacts = copilot.datasetFacts(ds!, summaries, issues);

  ok('datasetFacts opens with the app-computed guard line',
    /computed by the app/i.test(dFacts.text) && /NEVER recompute/i.test(dFacts.text));
  // The stats the app computed: sum path isn't used here, but min/max/mean are.
  ok('datasetFacts embeds the app-computed min (100)', dFacts.text.includes('min 100'));
  ok('datasetFacts embeds the app-computed max (300)', dFacts.text.includes('max 300'));
  ok('datasetFacts embeds the app-computed mean (200)', dFacts.text.includes('mean 200'));
  ok('datasetFacts states the row/column counts', dFacts.text.includes('3 rows') && dFacts.text.includes('2 columns'));
  ok('datasetFacts provenance is correct',
    dFacts.provenance.kind === 'dataset' && dFacts.provenance.name === 'Cities' &&
    JSON.stringify(dFacts.provenance.columns) === JSON.stringify(['city', 'pop']) &&
    dFacts.provenance.note === 'stats app-computed');
  // Anti-fabrication: every number in the facts text must be one we actually fed
  // in (row/col counts, sample cells, or a computed stat). Assert no stray figure
  // like a fabricated total appears.
  const nums = (dFacts.text.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  const allowed = new Set([3, 2, 100, 300, 200, 5, 1]); // counts, cells, stats, "first N"
  ok('datasetFacts fabricates no numbers (every figure is app-supplied)',
    nums.every((n) => allowed.has(n)));

  // visualFacts — feed a hand-built VizDataResult (the app-computed series).
  const viz: any = {
    data: { labels: ['Paris', 'Berlin', 'Rome'], series: [{ name: 'sum(pop)', values: [100, 300, 200] }] },
    recommendedShape: 'categorical',
    warnings: [],
  };
  const vFacts = copilot.visualFacts(
    { name: 'Pop chart', chartType: 'column', datasetId: ds!.id,
      encoding: { category: 'city', values: [{ column: 'pop', aggregation: 'sum' as const }] } } as any,
    'Cities',
    viz,
  );
  ok('visualFacts has the guard line', /computed by the app/i.test(vFacts.text));
  ok('visualFacts embeds the computed series values', vFacts.text.includes('Paris=100') && vFacts.text.includes('Berlin=300'));
  ok('visualFacts provenance names the visual + dataset',
    vFacts.provenance.kind === 'visual' && vFacts.provenance.name === 'Pop chart' && vFacts.provenance.datasetName === 'Cities');

  // dashboardFacts — one app-computed number per metric card.
  const dashFixture: any = {
    name: 'Overview',
    pages: [{ id: 'p1', name: 'Page 1', cards: [
      { id: 'c1', type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: ds!.id, column: 'pop', aggregation: 'sum', label: 'Total pop' } },
    ] }],
  };
  const dashFacts = copilot.dashboardFacts(dashFixture, [{ label: 'Total pop', value: 600 }]);
  ok('dashboardFacts has the guard line', /computed by the app/i.test(dashFacts.text));
  ok('dashboardFacts embeds the app-computed metric (600)', dashFacts.text.includes('Total pop: 600'));
  ok('dashboardFacts provenance kind is dashboard', dashFacts.provenance.kind === 'dashboard' && dashFacts.provenance.name === 'Overview');

  // A null metric value is rendered as n/a (never a guessed figure).
  const nullMetric = copilot.dashboardFacts(dashFixture, [{ label: 'Missing', value: null }]);
  ok('dashboardFacts renders a null metric as n/a (no fabrication)', nullMetric.text.includes('Missing: n/a'));

  // projectFacts fallback — inventory only, no figures.
  const pFacts = copilot.projectFacts('Copilot project', { datasets: ['Cities'], visuals: [], dashboards: [] });
  ok('projectFacts lists the inventory', pFacts.text.includes('Cities') && pFacts.provenance.kind === 'project');

  // ── askCopilot not_ready path (no model configured → soft error, no network) ─
  const notReady = await analyze.askCopilot([], dFacts.text, 'What stands out?');
  ok('askCopilot returns a soft not_ready when no model is configured',
    notReady.ok === false && (notReady as any).errorType === 'not_ready');
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    Module._load = origLoad;
    if (failures) { console.error('\n' + failures + ' copilot check(s) FAILED'); process.exit(1); }
    console.log('\nAll copilot checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
