// Every KPI-like figure that leaves the org is shaped by the Share policy as a chart over the same columns is
// (src/publish/kpiPolicy.ts): under drop, a figure totalled from a marked column is withheld, in the house wording,
// on every surface an outside reader gets —
//
//   /p/ pages        a dashboard's KPI tile and metric tree, a story's metric blocks, a scorecard's rows
//                    (publish:run, then GET /p/<id>/<file> as a member's browser does)
//   an embed         the KPI tile and the metric tree (embedHtml, the page a signed embed is served)
//   the HTML export  the metric tree (dashboardPageHtml, the export path)
//   a report         its KPIs, summary and scorecard page (report:build), a story's export (story:export)
//   a send           a subscription's KPIs, as Slack and Teams get them (subscription:preview: what is sent)
//
// Under mask each figure passes, as every aggregate does. Negative controls: the hours figures beside them are
// published; the app itself (scorecard:compute, story:figures, metricTree:compute, analysis:tiles) still shows
// every figure; with nothing marked every surface is byte for byte what it was before this change (sha256 pins).
//
//   npm run build:ts && node scripts/test-sharePolicyFigures.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as B from './subscriptionHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-share-figures-'));
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const store: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const stories: typeof import('../src/analysis/stories') = require('../src/analysis/stories');
const scorecards: typeof import('../src/analysis/scorecards') = require('../src/analysis/scorecards');
const reportSpec: typeof import('../src/analysis/reportSpec') = require('../src/analysis/reportSpec');
const pub: typeof import('../src/publish/publish') = require('../src/publish/publish');
const embedPage: typeof import('../src/publish/embedPage') = require('../src/publish/embedPage');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const format: typeof import('../src/app/format') = require('../src/app/format');
const HIDDEN: string = require('../src/app/sharePolicy').HIDDEN_BY_POLICY;

const DEV: B.Identity = { user: { email: 'dev@local', role: 'admin' }, org: { id: 'default' } };
const show = (v: unknown): string => String(JSON.stringify(v)).slice(0, 400);
function dataBlock(html: string): any { // any: the page's JSON, read field by field
  const m = /<script type="application\/json" id="ordinate-page">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}
/**
 * What differs run to run — ids, times, the day — taken out, then hashed. A send is dated with the day it is
 * composed (subscription:preview's subtitle), so any "Nov 6, 2026" goes: two renders either side of midnight are
 * the same message. (Matching only the day the pin runs on failed when the renders straddled midnight.)
 */
const pin = (v: unknown): string => crypto.createHash('sha256').update(JSON.stringify(v)
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'U')
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, 'T')
  .replace(/[A-Z][a-z]{2} \d{1,2}, \d{4},? \d{1,2}:\d{2} [AP]M UTC/g, 'A')
  .replace(/[A-Z][a-z]{2} \d{1,2}, \d{4}/g, 'D'), 'utf8').digest('hex');

// Ops and Lab, January to June 2025. Salaries 9xx37 (Ops) and 9xx89 (Lab): a month's payroll is 18xx26, nobody else's
// figure has those digits. Hours 12x3 nobody marks.
const MONTHS = [1, 2, 3, 4, 5, 6];
const ROWS = MONTHS.flatMap((mo) => [['Ops', `2025-0${mo}-15`, 90037 + mo * 1000, 1203 + mo * 10], ['Lab', `2025-0${mo}-15`, 90089 + mo * 1000, 1207 + mo * 10]]);
const PAY = (mo: number): number => 90037 + 90089 + mo * 2000;
const TOTAL = MONTHS.reduce((n, mo) => n + PAY(mo), 0); // 1122756, "1.1M"; over 14880 hours, 75.45… an hour
const figs = [...MONTHS.flatMap((mo) => [90037 + mo * 1000, 90089 + mo * 1000, PAY(mo)]), TOTAL];
const SALARY_BYTES = [...figs.map(String), ...figs.map((n) => n.toLocaleString('en-US')), '1.1M', '75.45'];

async function main(): Promise<void> {
  B.context.enterServerMode(DATA);
  appMod.registerHandlers();
  format.setFormatPrefs({ locale: 'en-US' }); // the displays the pins read, whatever the machine's locale
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA, ORDINATE_ENV: 'dev' }));
  const base = await B.listen(app);
  const { call } = B.client(base);
  const rpc = async (channel: string, payload: unknown): Promise<any> => (await call(channel, payload)).body; // any: each channel's reply
  const inApp = <T>(fn: () => Promise<T>): Promise<T> => B.context.runInContext(DEV, 'test', fn);
  try {
    const P: string = (await rpc('projects:create', { name: 'Figures share' })).id;
    const fx = await inApp(async () => {
      const S = (await datasets.saveDataset(P, { name: 'Staff', sourceKind: 'csv',
        columns: [{ name: 'team', type: 'text' }, { name: 'day', type: 'date' }, { name: 'salary', type: 'number' }, { name: 'hours', type: 'number' }], rows: ROWS }))!.id;
      const metric = async (name: string, definition: object, extra: object = {}) => (await metrics.saveMetric(P, { name, datasetId: S, definition, format: { kind: 'number', decimals: 0 }, ...extra } as never))!;
      const pay = await metric('Payroll', { column: 'salary', aggregation: 'sum' }, { tree: { split: 'team' } });
      const hrs = await metric('Hours', { column: 'hours', aggregation: 'sum' }, { tree: { split: 'team' } });
      const rate = await metric('Pay per hour', { formula: '[Payroll] / [Hours]' });
      const id = (i: number): string => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`; // fixed, so the pins hold run to run
      const card = (i: number, type: string, extra: object) => ({ id: id(i), type, layout: { x: (i % 4) * 3, y: Math.floor(i / 4) * 3, w: 3, h: 3 }, ...extra });
      const board = (await analysis.saveAnalysis(P, { name: 'Payroll board', sheets: [{ id: id(90), name: 'Main', cards: [
        card(1, 'metric', { metric: { datasetId: S, column: 'salary', aggregation: 'sum', label: 'Payroll KPI' } }),
        card(2, 'metric', { metric: { datasetId: S, column: 'hours', aggregation: 'sum', label: 'Hours KPI' } }),
        card(3, 'metric', { metric: { datasetId: S, column: rate.name, aggregation: 'count', label: 'Rate KPI', metricId: rate.id } }),
        card(4, 'metricTree', { metricTree: { metricId: pay.id } }),
        card(5, 'metricTree', { metricTree: { metricId: hrs.id } }),
      ] }] } as never))!;
      const story = (await stories.saveStory(P, { name: 'Payroll story', blocks: [
        { id: id(10), kind: 'metric', metricId: pay.id, filters: [] },
        { id: id(11), kind: 'metrics_row', metricIds: [rate.id, hrs.id], filters: [] },
      ] }))!;
      const sc = (await scorecards.saveScorecard(P, { name: 'Payroll card', period: 'month', rows: [
        { metricId: pay.id }, { metricId: hrs.id }, { metricId: rate.id }, { metricId: hrs.id, target: { metricId: pay.id } },
      ] }))!;
      const report = (await reportSpec.saveReport(P, { name: 'Payroll report', analysisId: board.id, pages: [
        { kind: 'summary', include: true, layout: 'full' }, { kind: 'sheet', sheetIdx: 0, include: true, layout: 'full' },
        { kind: 'scorecard', scorecardId: sc.id, include: true, layout: 'full' },
      ] }))!;
      return { S, board: board.id, story: story.id, sc: sc.id, report: report.id, pay: pay.id, hrs: hrs.id, rate: rate.id };
    });
    ok('fixture: a dashboard, a story, a scorecard and a report over Staff', !!fx.report);

    /** Every surface an outside reader gets, as its bytes. */
    const leave = async (action: 'mask' | 'drop' | 'include') => {
      await inApp(() => store.setPolicy(P, { publish: action, export: action, report: action }));
      const run = await rpc('publish:run', { projectId: P, dashboardIds: [fx.board], storyIds: [fx.story], scorecardIds: [fx.sc] });
      const site = run.site as import('../src/publish/hosted').HostedSite;
      const page = async (kind: string) => {
        const file = site.pages.find((p) => p.kind === kind)!.file;
        return dataBlock(await (await fetch(`${base}/p/${site.id}/${file}`)).text());
      };
      embedPage.clearEmbedCache();
      const claims = { pub: site.id, dash: fx.board, exp: 0, params: {}, hide: [] } as unknown as import('../src/server/embed/token').EmbedClaims;
      const embedded = await B.context.runAsPublished(DEV, 'embed', () => recordFs.withReadMemo(() => embedPage.embedHtml(site, fx.board, claims)));
      const draft = B.definition({ aid: fx.board } as B.Seed, []);
      const sent = await rpc('subscription:preview', { projectId: P, draft });
      return {
        dashboard: await page('dashboard'), story: await page('story'), scorecard: await page('scorecard'),
        embed: dataBlock('html' in embedded ? embedded.html : ''),
        exported: dataBlock(await inApp(() => pub.dashboardPageHtml(P, fx.board))),
        report: (await rpc('report:build', { projectId: P, id: fx.report })).pages,
        storyExport: (await rpc('story:export', { projectId: P, id: fx.story })).pages,
        send: { slack: sent.slack?.model, teams: sent.teams?.model },
      };
    };
    type Out = Awaited<ReturnType<typeof leave>>;
    const tile = (block: any, title: string): any => block?.dashboard?.sheets[0].cards.find((c: any) => c.title === title); // any: a page's JSON
    const tileHidden = (block: any, title: string): boolean => ((t) => !!t && t.payloads.length > 0 && t.payloads.every((p: any) => p.hidden === HIDDEN))(tile(block, title)); // any: as above
    const storyMetrics = (o: Out): any[] => (o.story?.story?.blocks || []).flatMap((b: any) => b.metrics || []); // any: as above
    const scoreRow = (o: Out, i: number): any => o.scorecard?.scorecard?.rows[i]; // any: as above
    const reportKpis = (o: Out): any[] => (o.report || []).flatMap((p: any) => p.kpis || []); // any: a report page
    const reportScore = (o: Out): string[][] => ((o.report || []).find((p: any) => p.kind === 'scorecard')?.grid?.body ?? []); // any: as above
    const exportKpis = (o: Out): any[] => (o.storyExport || []).flatMap((p: any) => p.kpis || []); // any: as above
    const sentKpis = (o: Out): any[] => o.send.slack?.kpis ?? []; // any: a message model's KPIs
    const surfaces = (o: Out): Record<string, unknown> => ({ dashboard: o.dashboard, story: o.story, scorecard: o.scorecard, embed: o.embed, exported: o.exported, report: o.report, storyExport: o.storyExport, send: o.send });
    const leaks = (o: Out): Record<string, string[]> => Object.fromEntries(Object.entries(surfaces(o)).map(([k, v]) => [k, SALARY_BYTES.filter((b) => JSON.stringify(v ?? null).includes(b))]).filter(([, l]) => l.length));
    const named = (rows: any[], name: string): any => rows.find((r: any) => (r.label ?? r.name) === name); // any: a KPI-ish entry

    // ── nothing marked: what every surface published before, pinned ──
    const before = await leave('drop');
    const PINNED: Record<string, string> = { // what develop 98176da9 published for this fixture — re-pin only for a format changed on purpose
      dashboard: 'a385a7f8f2b968c65fa3bd3fe97910960b5a2a051d6c45c846ef4d233e196e7c',
      story: '49586fbd5665a11b48f7e4f19141682b4695e49d9fca7e2c5488fe9ac3e2f4ee',
      scorecard: '38658da07a16aa8dfdc56df6d92a75c51e4c96d7ff7ac613c5245a9288c25196',
      embed: '52da55741a9e8cf12b6ef7917a48842509526854d1cc0bb3fab24b44959d7e29',
      exported: '67b7b2917ed57f5753b8c0fdbbbfcc180e66c41d07f5033205d6a5a31c3fefb9',
      report: 'bf06be5f978db7aae36ca378a616dfe97d3baae961c664de2956d1813c752cf1',
      storyExport: '07a6c3d22f222d23d7d481c39b4907f58bb2fc040c090be3a75bfa7cf4adca18',
      send: 'fddbbb7ce22a0f0d5ec7f7555052acfe9e969cfc2499d220faf2a6c3f144d438',
    };
    for (const [k, v] of Object.entries(surfaces(before))) ok(`PIN: with nothing marked, the ${k} is the one published before this change`, pin(v) === PINNED[k], `${k}: ${pin(v)}`);
    ok('fixture: with nothing marked, the payroll figures are on every surface, so the drop greps can see them',
      Object.keys(leaks(before)).length === 8, show(Object.keys(leaks(before))));

    await inApp(() => catalog.setColumn(P, fx.S, 'salary', { sensitivity: 'financial' }));

    // ── drop ──
    const drop = await leave('drop');
    for (const [where, block] of [['/p/ page', drop.dashboard], ['embed', drop.embed], ['HTML export', drop.exported]] as const) {
      const [payTree, hrsTree] = block.dashboard.sheets[0].cards.filter((c: any) => c.title === 'Metric tree'); // any: as above; in sheet order (a page carries no card ids)
      ok(`drop, ${where}: the metric tree over payroll is hidden`, payTree?.payloads.length > 0 && payTree.payloads.every((p: any) => p.hidden === HIDDEN), show(payTree)); // any: as above
      ok(`NEGATIVE CONTROL (drop, ${where}): the hours tree is drawn`, (hrsTree?.payloads ?? []).some((p: any) => Array.isArray(p.labels) && p.labels.length > 1 && !p.hidden), show(hrsTree)); // any: as above
    }
    ok('drop, embed: the KPI tile over salary publishes only the house wording, the hours KPI its figure',
      tileHidden(drop.embed, 'Payroll KPI') && tileHidden(drop.embed, 'Rate KPI') && !tileHidden(drop.embed, 'Hours KPI') && typeof tile(drop.embed, 'Hours KPI').payloads[0].value === 'number', show(tile(drop.embed, 'Payroll KPI')));
    ok('drop, /p/ story: Payroll and Pay per hour say the house wording, no figure', ['Payroll', 'Pay per hour'].every((n) => named(storyMetrics(drop), n)?.display === HIDDEN && named(storyMetrics(drop), n)?.value === null), show(storyMetrics(drop)));
    ok('NEGATIVE CONTROL (drop, /p/ story): Hours publishes its figure', typeof named(storyMetrics(drop), 'Hours')?.value === 'number', show(storyMetrics(drop)));
    const withheld = (r: any): boolean => !!r && r.display === HIDDEN && r.targetDisplay === '' && r.deltaDisplay === '' && r.attainment === null && r.status === 'none' && r.spark.length === 0; // any: a row
    ok('drop, /p/ scorecard: the payroll row, the formula row and the hours row with a payroll target withhold every figure, and the counts follow',
      [0, 2, 3].every((i) => withheld(scoreRow(drop, i))) && drop.scorecard.scorecard.counts.none === 4 && drop.scorecard.scorecard.counts.off === 0, show([[0, 2, 3].map((i) => scoreRow(drop, i)), drop.scorecard?.scorecard?.counts]));
    ok('NEGATIVE CONTROL (drop, /p/ scorecard): the hours row keeps its figures', !withheld(scoreRow(drop, 1)) && scoreRow(drop, 1).spark.length > 0 && /\d/.test(scoreRow(drop, 1).display), show(scoreRow(drop, 1)));
    ok('drop, report: the payroll and rate KPIs say the house wording, on the sheet and the summary', ['Payroll KPI', 'Rate KPI'].every((n) => reportKpis(drop).filter((k) => k.label === n).every((k) => k.value === HIDDEN)) && reportKpis(drop).filter((k) => k.value === HIDDEN).length === 4, show(reportKpis(drop)));
    ok('NEGATIVE CONTROL (drop, report): the hours KPI keeps its figure', reportKpis(drop).filter((k) => k.label === 'Hours KPI').every((k) => k.value !== HIDDEN && /\d/.test(k.value)), show(reportKpis(drop)));
    ok('drop, report scorecard page: the payroll rows say the house wording', [0, 2, 3].every((i) => reportScore(drop)[i]?.[1] === HIDDEN) && reportScore(drop)[1]?.[1] !== HIDDEN, show(reportScore(drop)));
    ok('drop, story export: Payroll and Pay per hour say the house wording, Hours its figure', ['Payroll', 'Pay per hour'].every((n) => named(exportKpis(drop), n)?.value === HIDDEN) && /\d/.test(named(exportKpis(drop), 'Hours')?.value ?? ''), show(exportKpis(drop)));
    ok('drop, send: the payroll and rate KPIs say the house wording, the hours KPI its figure', ['Payroll KPI', 'Rate KPI'].every((n) => named(sentKpis(drop), n)?.value === HIDDEN) && /\d/.test(named(sentKpis(drop), 'Hours KPI')?.value ?? ''), show(sentKpis(drop)));
    ok('drop: no salary and no payroll figure is on any surface', Object.keys(leaks(drop)).length === 0, show(leaks(drop)));

    // ── the app itself still shows every figure ──
    const scApp = await rpc('scorecard:compute', { projectId: P, id: fx.sc });
    const treeApp = await rpc('metricTree:compute', { projectId: P, id: fx.pay });
    const storyApp = await rpc('story:figures', { projectId: P, blocks: [{ id: 'b', kind: 'metric', metricId: fx.pay }] });
    const tilesApp = await rpc('analysis:tiles', { projectId: P, items: [{ kind: 'metric', datasetId: fx.S, column: 'salary', aggregation: 'sum' }, { kind: 'metric', datasetId: fx.S, column: 'Pay per hour', aggregation: 'count', metricId: fx.rate }] });
    ok('NEGATIVE CONTROL (drop): in the app the scorecard, the tree, the story and the dashboard\'s tiles still show the payroll',
      typeof scApp.rows?.[0]?.value === 'number' && typeof treeApp.root?.current === 'number' && storyApp.blocks?.b?.figures?.[0]?.value === TOTAL
      && tilesApp[0]?.value === TOTAL && typeof tilesApp[1]?.value === 'number', show([scApp.rows?.[0]?.value, treeApp.root?.current, storyApp.blocks?.b, tilesApp]));

    // ── mask: an aggregate passes, so every surface is the unmarked one ──
    const mask = await leave('mask');
    // A KPI's subtitle never names a marked column, masked or not (publish/kpiSubtitle): the figures are compared without it.
    const noSub = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null, (key, x) => (key === 'subtitle' ? undefined : x)));
    for (const [k, v] of Object.entries(surfaces(mask))) ok(`mask: the ${k} publishes every figure, as before`, pin(noSub(v)) === pin(noSub((surfaces(before) as Record<string, unknown>)[k])), k);

    // ── unmarked again: drop leaves it alone ──
    await inApp(() => catalog.setColumn(P, fx.S, 'salary', { sensitivity: 'none' }));
    const after = await leave('drop');
    ok('NEGATIVE CONTROL: with salary unmarked again, every surface is byte for byte the one before', Object.entries(surfaces(after)).every(([k, v]) => pin(v) === pin((surfaces(before) as Record<string, unknown>)[k])));
  } finally {
    await app.close();
  }
}

main().then(finish, (err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
