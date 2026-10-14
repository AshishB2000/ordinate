// Self-check for ANALYSIS facts — copilot.analysisFacts + the ipc/copilot
// buildFacts 'analysis' branch. Three things are pinned here:
//   1. an analysis with metric cards yields FACTS carrying the APP-computed
//      numbers and provenance.kind === 'analysis', with a per-sheet roster so
//      "what's on sheet 2" is answerable from the FACTS alone;
//   2. a card pointing at a MISSING dataset yields null → "n/a" and still
//      returns usable FACTS — it must not throw;
//   3. every figure is the one the dashboard SHOWS: under its saved filters, a
//      metric-bound KPI as its metric — compared with `analysis:tiles`' reply.
// Like test-copilot.ts we point userData (ORDINATE_LOCAL_DIR) at a fresh temp dir, then run the REAL modules against real disk.
// No framework.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-anfacts-'));

process.env.ORDINATE_LOCAL_DIR = tmpUserData;

// ponytail: compiled siblings of the .ts sources under test.
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const ipcCopilot: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const fxStore: typeof import('../src/app/fxStore') = require('../src/app/fxStore');
// The tile's side of the comparison: `analysis:tiles` and the handlers it batches, read from the RPC registry.
const { handlers }: typeof import('../src/server/rpc') = require('../src/server/rpc');
const analysesIpc: typeof import('../src/ipc/analysesServer') = require('../src/ipc/analysesServer');
const dashboardsIpc: typeof import('../src/ipc/dashboards') = require('../src/ipc/dashboards');
const metricsIpc: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const statsIpc: typeof import('../src/ipc/stats') = require('../src/ipc/stats');
const { statsFacts }: typeof import('../src/ai/statsFacts') = require('../src/ai/statsFacts');

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
  const facts = await ipcCopilot.buildFacts(proj.id, { kind: 'analysis', id: a!.id });

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

  // ── 3. The figures are the ones the dashboard shows ─────────────────────────
  // A saved dashboard-wide filter, and a KPI bound to a saved metric: the facts
  // carry what each TILE shows, never a second fold over the unfiltered table.
  // DIFFERENTIAL: every expectation below is `analysis:tiles`' own reply — the
  // registered handler, run as the RPC layer runs it — to the item the open page
  // sends for that card (editor/MetricCard.tsx: its column, aggregation and
  // metricId under the sheet's filters), compared with Object.is.
  for (const mod of [analysesIpc, dashboardsIpc, metricsIpc, statsIpc]) mod.register();
  const orders = await datasets.saveDataset(proj.id, {
    name: 'Orders',
    sourceKind: 'csv',
    columns: [{ name: 'region', type: 'text' as const }, { name: 'revenue', type: 'number' as const }, { name: 'refund', type: 'text' as const }],
    rows: [['West', 1200, 'no'], ['West', 300, 'yes'], ['East', 800, 'no'], ['North', 500, 'yes']],
  });
  const net = await metrics.saveMetric(proj.id, {
    name: 'Net revenue', datasetId: orders!.id, definition: { column: 'revenue', aggregation: 'sum' },
    filters: [{ type: 'filter', column: 'refund', op: '=', value: 'no' }],
  });
  ok('filtered fixture saved', orders !== null && net !== null);
  const west = [{ type: 'filter' as const, column: 'region', op: '=' as const, value: 'West' }];
  const spec = { column: 'revenue', aggregation: 'sum' as const };
  const kpis = [
    { type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: orders!.id, ...spec, label: 'Total revenue' } },
    // Bound to the saved metric, with no label of its own: the tile shows the metric, by its name.
    { type: 'metric', layout: { x: 3, y: 0, w: 3, h: 2 }, metric: { datasetId: orders!.id, ...spec, metricId: net!.id } },
    { type: 'stats', layout: { x: 0, y: 2, w: 6, h: 6 }, stats: { kind: 'distribution', datasetId: orders!.id, columns: ['revenue'] } },
  ];
  const filtered = await analysis.saveAnalysis(proj.id, { name: 'One region', filters: west, sheets: [{ name: 'S1', cards: kpis }] });
  const open = await analysis.saveAnalysis(proj.id, { name: 'Everywhere', sheets: [{ name: 'S1', cards: kpis }] });
  type Tile = { ok: boolean; value: number | null; display?: string; name?: string };
  const tiles = (filters: typeof west, metricId = net!.id): Promise<Tile[]> => (handlers.get('analysis:tiles') as (e: unknown, p: unknown) => Promise<Tile[]>)({}, {
    projectId: proj.id,
    params: [],
    items: [{ kind: 'metric', datasetId: orders!.id, ...spec, filters }, { kind: 'metric', datasetId: orders!.id, ...spec, metricId, filters }],
  });
  const [shownWest, shownAll] = [await tiles(west), await tiles([])];
  ok('the fixture tells the four tiles apart', [...shownWest, ...shownAll].every((t) => t.ok && typeof t.value === 'number')
    && new Set([...shownWest, ...shownAll].map((t) => t.value)).size === 4, JSON.stringify([shownWest, shownAll]));
  /** What the facts say of the DEFINED metric `name`: its line, and every figure banked under that name. */
  const defined = (f: typeof facts, name: string) => ({
    line: f.text.split('\n').find((l) => l.startsWith(`- "${name}" = `)) ?? '',
    banked: f.ledger.filter((e) => e.label === name).map((e) => e.value),
  });

  const westFacts = await ipcCopilot.buildFacts(proj.id, { kind: 'analysis', id: filtered!.id });
  const got = metricValues(westFacts.text);
  ok('a KPI under a saved filter is analysis:tiles’ figure', Object.is(got[0], shownWest[0].value), `${got[0]} vs ${shownWest[0].value}`);
  ok('a KPI bound to a saved metric is analysis:tiles’ figure for the metric', Object.is(got[1], shownWest[1].value), `${got[1]} vs ${shownWest[1].value}`);
  ok('…named as its tile is, with no label of its own', shownWest[1].name === 'Net revenue' && westFacts.text.includes(`- ${shownWest[1].name}: `));
  const netWest = defined(westFacts, 'Net revenue');
  ok('the defined metric of that name reads as the tile does — one number per name', netWest.line.endsWith(`Currently ${shownWest[1].display}.`)
    && netWest.banked.length === 2 && netWest.banked.every((v) => Object.is(v, shownWest[1].value)), JSON.stringify(netWest));
  ok('the facts name the columns the dashboard filters on, above every figure', /^Every figure below is under this dashboard's saved filters, on: "region"\.$/m.test(westFacts.text)
    && westFacts.text.indexOf('saved filters') < westFacts.text.indexOf('Metric cards'), westFacts.text);
  ok('…and never a filter’s value', !westFacts.text.includes('West'));
  // NEGATIVE CONTROL: the same cards with no saved filter give the unfiltered tiles' figures, and claim no filter.
  const allFacts = await ipcCopilot.buildFacts(proj.id, { kind: 'analysis', id: open!.id });
  const gotAll = metricValues(allFacts.text);
  const netAll = defined(allFacts, 'Net revenue');
  ok('NEGATIVE CONTROL: without a saved filter the figures are the unfiltered tiles’', Object.is(gotAll[0], shownAll[0].value) && Object.is(gotAll[1], shownAll[1].value)
    && netAll.line.endsWith(`Currently ${shownAll[1].display}.`) && netAll.banked.every((v) => Object.is(v, shownAll[1].value)), JSON.stringify([gotAll, netAll]));
  ok('…and no filter is claimed', !/saved filters/.test(allFacts.text));

  // A statistics tile is recomputed under the same saved filter (`stats:tile`): its facts are computeStats' under it.
  const statsSpec = filtered!.sheets[0].cards.find((c) => c.type === 'stats')!.stats!;
  const tileStats = async (filters: typeof west): Promise<string> => {
    const r = await statsIpc.computeStats(proj.id, statsSpec, filters);
    return r.ok ? statsFacts([{ spec: statsSpec, result: r.value }], r.datasetName).text : '';
  };
  const [statsWest, statsAll] = [await tileStats(west), await tileStats([])];
  ok('the fixture tells the two statistics apart', statsWest !== '' && statsAll !== '' && statsWest !== statsAll);
  ok('a statistics tile’s facts are the tile’s, under the saved filter', westFacts.text.endsWith(statsWest));
  ok('…and the unfiltered tile’s without one', allFacts.text.endsWith(statsAll));

  // The metric a KPI named is gone: its own stored column and aggregation, as the tile falls back.
  await metrics.deleteMetric(proj.id, net!.id);
  const fellBack = metricValues((await ipcCopilot.buildFacts(proj.id, { kind: 'analysis', id: filtered!.id })).text);
  const shownGone = await tiles(west);
  ok('a KPI whose metric was deleted is analysis:tiles’ fallback: its stored column, still filtered', shownGone[1].ok && Object.is(fellBack[1], shownGone[1].value) && Object.is(fellBack[1], shownWest[0].value),
    JSON.stringify([fellBack, shownGone]));

  // ── 4. …in the dashboard's own currency ─────────────────────────────────────
  // A dashboard's currency is saved state (fx settings) the page sends with every
  // tile; the facts' money is in it too. DIFFERENTIAL against `analysis:tiles`
  // asked as the page asks, with that currency.
  const sales = await datasets.saveDataset(proj.id, {
    name: 'Sales',
    sourceKind: 'csv',
    columns: [{ name: 'date', type: 'date' as const }, { name: 'amount', type: 'number' as const }],
    rows: [['2024-03-01', 100], ['2024-03-02', 200]],
  });
  await fxStore.setProjectFx(proj.id, { target: 'USD' });
  await fxStore.setColumnCurrency(proj.id, sales!.id, 'amount', { kind: 'fixed', code: 'EUR', date: 'date' });
  const money = [{ type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: sales!.id, column: 'amount', aggregation: 'sum', label: 'Amount' } }];
  const inGbp = await analysis.saveAnalysis(proj.id, { name: 'In pounds', sheets: [{ name: 'S1', cards: money }] });
  const inTarget = await analysis.saveAnalysis(proj.id, { name: 'In the project currency', sheets: [{ name: 'S1', cards: money }] });
  await fxStore.setDashboardCurrency(proj.id, inGbp!.id, 'GBP');
  const moneyTile = async (currency?: string): Promise<Tile> => (await (handlers.get('analysis:tiles') as (e: unknown, p: unknown) => Promise<Tile[]>)({}, {
    projectId: proj.id, params: [], ...(currency ? { currency } : {}),
    items: [{ kind: 'metric', datasetId: sales!.id, column: 'amount', aggregation: 'sum', filters: [] }],
  }))[0];
  const [gbpTile, usdTile] = [await moneyTile('GBP'), await moneyTile()];
  ok('the fixture tells the two currencies apart', gbpTile.ok && usdTile.ok && typeof gbpTile.value === 'number' && !Object.is(gbpTile.value, usdTile.value), JSON.stringify([gbpTile, usdTile]));
  const gbpGot = metricValues((await ipcCopilot.buildFacts(proj.id, { kind: 'analysis', id: inGbp!.id })).text);
  ok('a KPI on a dashboard with its own currency is analysis:tiles’ figure in that currency', Object.is(gbpGot[0], gbpTile.value), `${gbpGot[0]} vs ${gbpTile.value}`);
  // NEGATIVE CONTROL: the same card on a dashboard with no currency of its own follows the project's.
  const usdGot = metricValues((await ipcCopilot.buildFacts(proj.id, { kind: 'analysis', id: inTarget!.id })).text);
  ok('NEGATIVE CONTROL: a dashboard with no currency of its own reads in the project’s', Object.is(usdGot[0], usdTile.value), `${usdGot[0]} vs ${usdTile.value}`);
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
    if (failureCount()) { console.error('\n' + failureCount() + ' analysis-facts check(s) FAILED'); process.exit(1); }
    console.log('\nAll analysis-facts checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
