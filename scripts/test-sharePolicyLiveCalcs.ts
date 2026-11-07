// A Live dataset's calculated fields (semantic layer part 8, step 04) under the Share policy
// (src/app/sharePolicy.ts `markedLevels` over data/columnAccess `metaShape`): a calc whose formula reads a
// marked column carries the mark, as a Prepare formula does. Under drop a chart and a KPI over `Bonus = [amt] * 2`
// are hidden on an export-shaped `visual:data`, a /p/ page (buildPages with the publish hook) and a report's
// kpiHidden; under mask a chart's labels by `Who = IF … ELSE [cat]` are tokens. The Assistant's withheld list
// and the policy summary's count name the calcs. NEGATIVE CONTROL: with nothing marked every figure is drawn.
//
// A stored calc list this pod cannot read in full (`calculatedUnreadable`) still carries a mark through the calcs it
// can read: the Assistant's withheld list names them.
//
// § layer  a layer's metric (part 7 b2) is read from every column of its semantic dataset, as far as the policy can
//          tell (analysis/semanticMeasures layerReads): under drop a /p/ KPI and chart over a mirror are hidden once any
//          column of the dataset is marked; under mask they are drawn. NEGATIVE CONTROL: with nothing marked, drawn.
//
//   npm run build:ts && node scripts/test-sharePolicyLiveCalcs.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { H, close, post } from './liveRouteHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { randomUUID }: typeof import('crypto') = require('crypto');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const store: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
const share: typeof import('../src/app/sharePolicy') = require('../src/app/sharePolicy');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const pub: typeof import('../src/publish/publish') = require('../src/publish/publish');
const { kpiHidden }: typeof import('../src/publish/kpiPolicy') = require('../src/publish/kpiPolicy');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const ipcMetrics: typeof import('../src/ipc/metrics') = require('../src/ipc/metrics');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const fake: typeof import('./semanticFake') = require('./semanticFake');
const adapters: typeof import('../src/engine/live/semantic/adapters') = require('../src/engine/live/semantic/adapters');
const sq: typeof import('../src/engine/live/semantic/semanticQuery') = require('../src/engine/live/semantic/semanticQuery');

const show = (v: unknown): string => String(JSON.stringify(v)).slice(0, 300);
const HIDDEN = share.HIDDEN_BY_POLICY;
const CALCS = [
  { name: 'Bonus', expression: '[amt] * 2', type: 'number' as const },
  { name: 'Who', expression: "IF [cat] = 'zzz' THEN 'none' ELSE [cat] END", type: 'text' as const },
];

async function main(): Promise<void> {
  const { projectId: P, liveId: L } = await H.setupOrg(H.ORG_A);
  const inApp = <T>(fn: () => Promise<T>): Promise<T> => H.as(H.ORG_A, fn);
  ok('fixture: the calcs are stored', !!(await inApp(() => H.liveDataset.setLiveCalcs(P, L, CALCS.map((c) => ({ ...c }))))));
  const chart = async (category: string, column: string, aggregation: string, sh?: string) =>
    (await post('visual:data', { projectId: P, datasetId: L, encoding: { category, values: [{ column, aggregation }] }, ...(sh ? { share: sh } : {}) })).value;
  /** A /p/ page of a chart (`ds`, `encoding`) beside KPI cards, each tile's first payload by title. */
  const page = async (ds: string, title: string, encoding: object, kpis: object[]): Promise<Record<string, any>> => inApp(async () => { // any: a page tile, read field by field
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-share-livecalc-site-'));
    const vid = (await visuals.saveVisual(P, { datasetId: ds, name: title, chartType: 'column', encoding } as never))!.id;
    const dash = (await analysis.saveAnalysis(P, { name: title, sheets: [{ id: randomUUID(), name: 'Main', cards: [
      { id: randomUUID(), type: 'visual', visualId: vid, layout: { x: 0, y: 0, w: 4, h: 4 } },
      ...kpis.map((metric, i) => ({ id: randomUUID(), type: 'metric', metric, layout: { x: 4, y: i * 2, w: 3, h: 2 } })),
    ] }] } as never))!;
    const cfg = pub.sanitizePublishConfig({ projectId: P, dashboardIds: [dash.id], storyIds: [], outDir: out });
    if ('error' in cfg) throw new Error(cfg.error);
    const built = await pub.buildPages(cfg, {}, pub.policyOutgoing(P, 'publish'));
    const m = /<script type="application\/json" id="ordinate-page">([\s\S]*?)<\/script>/.exec(built.pages[0].html);
    const cards: any[] = m ? JSON.parse(m[1]).dashboard.sheets[0].cards : []; // any: as above
    return Object.fromEntries(cards.map((c) => [c.title, c.payloads[0]]));
  });
  const site = () => page(L, 'Bonus by cat', { category: 'cat', values: [{ column: 'Bonus', aggregation: 'sum' }] },
    [{ datasetId: L, column: 'Bonus', aggregation: 'sum', label: 'Bonus KPI' }, { datasetId: L, column: 'qty', aggregation: 'sum', label: 'Qty KPI' }]);
  const BONUS = [{ datasetId: L, column: 'Bonus', aggregation: 'sum' as const }];

  // ── nothing marked: every figure is drawn ──
  await inApp(() => store.setPolicy(P, { publish: 'drop', export: 'drop', report: 'drop' }));
  const ctlChart = await chart('cat', 'Bonus', 'sum', 'export');
  const ctlSite = await site();
  ok('NEGATIVE CONTROL (nothing marked, drop): an export of sum(Bonus) is drawn', ctlChart.ok === true && ctlChart.data.series[0].values.length > 1, show(ctlChart));
  ok('NEGATIVE CONTROL (nothing marked, drop): on /p/ the Bonus chart and KPI are drawn', !ctlSite['Bonus by cat']?.hidden && typeof ctlSite['Bonus KPI']?.value === 'number', show(ctlSite));
  ok('NEGATIVE CONTROL (nothing marked): no calc is withheld, none counted', (await inApp(() => share.withheldColumns(P, L))).size === 0
    && (await inApp(() => share.policySummary(P, [L], 'publish'))).count === 0);

  // ── amt marked financial, drop ──
  await inApp(() => catalog.setColumn(P, L, 'amt', { sensitivity: 'financial' }));
  const exp = await chart('cat', 'Bonus', 'sum', 'export');
  ok('drop: an export of sum(Bonus), a calc over the marked amt, is hidden', exp.hiddenByPolicy === true && exp.error === HIDDEN, show(exp));
  const dropSite = await site();
  ok('drop: on /p/ the chart and the KPI over Bonus are hidden', dropSite['Bonus by cat']?.hidden === HIDDEN && dropSite['Bonus KPI']?.hidden === HIDDEN, show(dropSite));
  ok('NEGATIVE CONTROL (drop): on /p/ the qty KPI beside them is drawn', typeof dropSite['Qty KPI']?.value === 'number', show(dropSite['Qty KPI']));
  ok('drop: a report or an alert post withholds a KPI over Bonus', (await inApp(() => kpiHidden(P, BONUS, 'report'))) === HIDDEN);
  ok('drop: the Assistant\'s withheld list names the calc', show([...(await inApp(() => share.withheldColumns(P, L)))].sort()) === show(['Bonus', 'amt']));
  const sum = await inApp(() => share.policySummary(P, [L], 'publish'));
  ok('drop: the policy summary counts amt and the calc over it', sum.count === 2 && show(sum.columns.map((c) => c.column).sort()) === show(['Bonus', 'amt']), show(sum));

  // ── cat marked personal, mask: labels drawn from a calc over it are tokens ──
  await inApp(async () => {
    await catalog.setColumn(P, L, 'cat', { sensitivity: 'personal' });
    await store.setPolicy(P, { publish: 'mask', export: 'mask', report: 'mask' });
  });
  const byCat = await chart('cat', 'qty', 'count', 'export');
  const byWho = await chart('Who', 'qty', 'count', 'export');
  const raw = await chart('cat', 'qty', 'count');
  const values = new Set<string>(raw.data.labels.filter((l: string) => l !== '').map(String));
  ok('fixture: in the app the labels by cat are its values', values.size > 3, show(raw.data?.labels));
  ok('NEGATIVE CONTROL (mask): labels by cat are tokens', byCat.ok === true && byCat.data.labels.every((l: string) => !values.has(l)), show(byCat.data?.labels));
  ok('mask: labels by Who, a text calc over cat, are tokens — the same ones', byWho.ok === true && byWho.data.labels.every((l: string) => !values.has(l))
    && show([...byWho.data.labels].sort()) === show([...byCat.data.labels].sort()), show(byWho.data?.labels));

  // ── § layer: a semantic dataset's mirrors ──
  fake.registerSemanticFake();
  adapters.registerTestSemanticAdapter('fake', { encode: (q, model) => ({ kind: 'semantic', body: { table: model, columns: H.fx.COLUMNS, query: q }, columns: sq.answerColumns(q) }) });
  const SEM = await inApp(async () => {
    const conn = (await H.connections.saveConnection(P, { name: 'Layer prod', connectorId: fake.SEMANTIC_FAKE_ID, values: {} }))!;
    return (await liveRecord.saveSemanticRecord(P, { name: 'Orders layer', connId: conn.id, columns: [], semantic: { backend: 'fake', model: 'live_typed', metrics: [], grains: [], syncedAt: '2026-11-01T00:00:00.000Z' } }))!.id;
  });
  ok('fixture: the semantic dataset syncs', (await post('dataset:syncLiveSchema', { projectId: P, datasetId: SEM })).value.ok === true);
  const revenue = (await inApp(() => metrics.listMetrics(P))).find((m) => m.datasetId === SEM && m.name === 'revenue')!.id;
  const layerPage = () => page(SEM, 'Revenue by region', { category: 'region', values: [{ column: '', aggregation: 'sum', metricId: revenue }] },
    [{ datasetId: SEM, column: '', aggregation: 'sum', metricId: revenue, label: 'Revenue KPI' }]);
  const drawn = (p: Record<string, any>): boolean => !p['Revenue by region']?.hidden && (p['Revenue by region']?.labels?.length ?? 0) > 1 && typeof p['Revenue KPI']?.value === 'number'; // any: as above
  const hidden = (p: Record<string, any>): boolean => p['Revenue by region']?.hidden === HIDDEN && p['Revenue KPI']?.hidden === HIDDEN; // any: as above
  await inApp(() => store.setPolicy(P, { publish: 'drop', export: 'drop', report: 'drop' }));
  const ctlLayer = await layerPage();
  ok('NEGATIVE CONTROL (layer, nothing marked on it, drop): the mirror\'s chart and KPI are drawn on /p/', drawn(ctlLayer), show(ctlLayer));
  await inApp(() => catalog.setColumn(P, SEM, 'bigid', { sensitivity: 'personal' }));
  const dropLayer = await layerPage();
  ok('layer, drop: one marked column on the semantic dataset hides the mirror\'s chart and KPI on /p/', hidden(dropLayer), show(dropLayer));
  const reads: import('../src/ipc/metrics').MetricRead[] = [];
  await inApp(() => ipcMetrics.resolveMetric(P, revenue, { reads }));
  ok('layer, drop: the mirror\'s figure reads every field, so a report or an alert post withholds it', reads.length > 1 && (await inApp(() => kpiHidden(P, reads, 'report'))) === HIDDEN, show(reads));
  await inApp(() => store.setPolicy(P, { publish: 'mask', export: 'mask', report: 'mask' }));
  const maskLayer = await layerPage();
  ok('layer, mask: the mirror\'s figures pass, as every aggregate does', drawn(maskLayer), show(maskLayer));

  // ── a calc list read in part ──
  await inApp(() => rec.serialized(rec.datasetFilePath(P, L), (r) => { r.calculated = [...CALCS, 7]; }));
  ok('fixture: the stored list is read in part', (await inApp(() => datasets.getDatasetMeta(P, L)))?.live?.calculatedUnreadable === true);
  ok('a list read in part still carries the marks through the calcs it can read', show([...(await inApp(() => share.withheldColumns(P, L)))].sort()) === show(['Bonus', 'Who', 'amt', 'cat']),
    show([...(await inApp(() => share.withheldColumns(P, L)))]));
}

main().then(async () => { await close(); finish(); }, async (err) => {
  console.error(err);
  process.exitCode = 1;
  await close();
  finish();
});
