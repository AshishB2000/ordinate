// A Live dataset's calculated fields (semantic layer part 8, step 04) under the Share policy
// (src/app/sharePolicy.ts `markedLevels` over data/columnAccess `metaShape`): a calc whose formula reads a
// marked column carries the mark, as a Prepare formula does. Under drop a chart and a KPI over `Bonus = [amt] * 2`
// are hidden on an export-shaped `visual:data`, a /p/ page (buildPages with the publish hook) and a report's
// kpiHidden; under mask a chart's labels by `Who = IF … ELSE [cat]` are tokens. The Assistant's withheld list
// and the policy summary's count name the calcs. NEGATIVE CONTROL: with nothing marked every figure is drawn.
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
  const site = async (): Promise<Record<string, any>> => inApp(async () => { // any: a page tile, read field by field
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-share-livecalc-site-'));
    const vid = (await visuals.saveVisual(P, { datasetId: L, name: 'Bonus by cat', chartType: 'column', encoding: { category: 'cat', values: [{ column: 'Bonus', aggregation: 'sum' }] } } as never))!.id;
    const dash = (await analysis.saveAnalysis(P, { name: 'Bonus', sheets: [{ id: randomUUID(), name: 'Main', cards: [
      { id: randomUUID(), type: 'visual', visualId: vid, layout: { x: 0, y: 0, w: 4, h: 4 } },
      { id: randomUUID(), type: 'metric', metric: { datasetId: L, column: 'Bonus', aggregation: 'sum', label: 'Bonus KPI' }, layout: { x: 4, y: 0, w: 3, h: 2 } },
      { id: randomUUID(), type: 'metric', metric: { datasetId: L, column: 'qty', aggregation: 'sum', label: 'Qty KPI' }, layout: { x: 4, y: 2, w: 3, h: 2 } },
    ] }] } as never))!;
    const cfg = pub.sanitizePublishConfig({ projectId: P, dashboardIds: [dash.id], storyIds: [], outDir: out });
    if ('error' in cfg) throw new Error(cfg.error);
    const built = await pub.buildPages(cfg, {}, pub.policyOutgoing(P, 'publish'));
    const m = /<script type="application\/json" id="ordinate-page">([\s\S]*?)<\/script>/.exec(built.pages[0].html);
    const cards: any[] = m ? JSON.parse(m[1]).dashboard.sheets[0].cards : []; // any: as above
    return Object.fromEntries(cards.map((c) => [c.title, c.payloads[0]]));
  });
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
}

main().then(async () => { await close(); finish(); }, async (err) => {
  console.error(err);
  process.exitCode = 1;
  await close();
  finish();
});
