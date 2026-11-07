// A dashboard's Summary card under the Share policy (src/ipc/summary.ts `computeSummary` with a `share` path): its
// KPI, driver and alert sentences quote figures, so each is judged by the reads of the figure it quotes on the path
// the page leaves by (publish/kpiPolicy kpiHidden), as the KPI tile and the alert's own post are. Under drop, a
// Summary led by a KPI over a marked salary says neither its KPI's movement nor its contributor, nor an alert over
// salary, on any surface an outside reader gets:
//
//   /p/ pages        publish:run, then GET /p/<id>/<file> as a member's browser does
//   an embed         embedHtml, the page a signed embed is served
//   the HTML export  dashboardPageHtml (the export path), and the CLI/MCP `dashboards export` that writes it
//   a report         the summary page's bullets (report:build)
//
// NEGATIVE CONTROLS: a Summary led by the hours KPI keeps its sentence; an alert over hours is said in place of the
// salary one; in the app summary:compute still says the payroll sentences; with nothing marked they leave.
//
//   npm run build:ts && node scripts/test-sharePolicySummary.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as B from './subscriptionHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-share-summary-'));
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const store: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const reportSpec: typeof import('../src/analysis/reportSpec') = require('../src/analysis/reportSpec');
const pub: typeof import('../src/publish/publish') = require('../src/publish/publish');
const embedPage: typeof import('../src/publish/embedPage') = require('../src/publish/embedPage');
const automation: typeof import('../src/automation/handlers') = require('../src/automation/handlers');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const format: typeof import('../src/app/format') = require('../src/app/format');

const DEV: B.Identity = { user: { email: 'dev@local', role: 'admin' }, org: { id: 'default' } };
const JOBS: B.Identity = { user: { email: 'jobs@system', role: 'admin' }, org: { id: 'default' } };
const show = (v: unknown): string => String(JSON.stringify(v)).slice(0, 500);
function dataBlock(html: string): any { // any: the page's JSON, read field by field
  const m = /<script type="application\/json" id="ordinate-page">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

// Ops and Lab, January to June 2025, as test-sharePolicyFigures: salaries 9xx37 / 9xx89, hours 12x3 nobody marks.
const MONTHS = [1, 2, 3, 4, 5, 6];
const ROWS = MONTHS.flatMap((mo) => [['Ops', `2025-0${mo}-15`, 90037 + mo * 1000, 1203 + mo * 10], ['Lab', `2025-0${mo}-15`, 90089 + mo * 1000, 1207 + mo * 10]]);
const PAY = (mo: number): number => 90037 + 90089 + mo * 2000;
const TOTAL = MONTHS.reduce((n, mo) => n + PAY(mo), 0);
const figs = [...MONTHS.flatMap((mo) => [90037 + mo * 1000, 90089 + mo * 1000, PAY(mo)]), TOTAL];
// The KPI's movement (192.1K from 190.1K, by 2.0K), its lead contributor's (+1.0K) and the payroll alert's total.
const SALARY_BYTES = [...figs.map(String), ...figs.map((n) => n.toLocaleString('en-US')), '1.1M', '192.1K', '190.1K', '2.0K', '1.0K', 'Payroll above'];

async function main(): Promise<void> {
  B.context.enterServerMode(DATA);
  appMod.registerHandlers();
  format.setFormatPrefs({ locale: 'en-US' });
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA, ORDINATE_ENV: 'dev' }));
  const base = await B.listen(app);
  const { call } = B.client(base);
  const rpc = async (channel: string, payload: unknown): Promise<any> => (await call(channel, payload)).body; // any: each channel's reply
  const inApp = <T>(fn: () => Promise<T>): Promise<T> => B.context.runInContext(DEV, 'test', fn);
  try {
    const P: string = (await rpc('projects:create', { name: 'Summary share' })).id;
    const fx = await inApp(async () => {
      const S = (await datasets.saveDataset(P, { name: 'Staff', sourceKind: 'csv',
        columns: [{ name: 'team', type: 'text' }, { name: 'day', type: 'date' }, { name: 'salary', type: 'number' }, { name: 'hours', type: 'number' }], rows: ROWS }))!.id;
      // Refreshed long ago: a page that leaves the app names the alerts fired on the data as it is now.
      await rec.serialized(rec.datasetFilePath(P, S), (raw) => { raw.lastRefreshedAt = '2000-01-01T00:00:00.000Z'; });
      const id = (i: number): string => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const card = (i: number, type: string, extra: object) => ({ id: id(i), type, layout: { x: (i % 4) * 3, y: 0, w: 3, h: 3 }, ...extra });
      const board = async (name: string, column: string, label: string, n: number) => (await analysis.saveAnalysis(P, { name, sheets: [{ id: id(90 + n), name: 'Main', cards: [
        card(n * 10, 'metric', { metric: { datasetId: S, column, aggregation: 'sum', label } }),
        card(n * 10 + 1, 'summary', { summary: {} }),
      ] }] } as never))!;
      const pay = await board('Payroll board', 'salary', 'Payroll KPI', 1);
      const hrs = await board('Hours board', 'hours', 'Hours KPI', 2);
      const report = (await reportSpec.saveReport(P, { name: 'Payroll report', analysisId: pay.id, pages: [{ kind: 'summary', include: true, layout: 'full' }] }))!;
      const hrsReport = (await reportSpec.saveReport(P, { name: 'Hours report', analysisId: hrs.id, pages: [{ kind: 'summary', include: true, layout: 'full' }] }))!;
      return { S, pay: pay.id, hrs: hrs.id, report: report.id, hrsReport: hrsReport.id };
    });
    // The hours alert fires first, the payroll one later: the newest is the one a Summary names.
    const rule = async (name: string, column: string, label: string) => rpc('alerts:save', { projectId: P, rule: {
      name, datasetId: fx.S, metric: { column, aggregation: 'sum', label }, compare: 'threshold', threshold: { op: '>', value: 10 } } });
    await rule('Hours above 10', 'hours', 'Hours');
    await B.context.runInContext(JOBS, 'job:tick:default', () => alertStore.evaluateProject(P, undefined, Date.now() - 60_000));
    await rule('Payroll above 10', 'salary', 'Payroll');
    const fired = await B.context.runInContext(JOBS, 'job:tick:default', () => alertStore.evaluateProject(P));
    ok('fixture: the payroll rule fires on the total payroll', fired.some((e) => e.ruleName === 'Payroll above 10' && e.value === TOTAL), show(fired.map((e) => [e.ruleName, e.value])));

    /** Every surface an outside reader gets, as its bytes, and each Summary's sentences. */
    const leave = async (action: 'mask' | 'drop' | 'include') => {
      await inApp(() => store.setPolicy(P, { publish: action, export: action, report: action }));
      const run = await rpc('publish:run', { projectId: P, dashboardIds: [fx.pay, fx.hrs], storyIds: [] });
      const site = run.site as import('../src/publish/hosted').HostedSite;
      const pages = await Promise.all(site.pages.filter((p) => p.kind === 'dashboard').map(async (p) => dataBlock(await (await fetch(`${base}/p/${site.id}/${p.file}`)).text())));
      const page = (name: string): any => pages.find((b) => b?.dashboard?.name === name); // any: as above
      embedPage.clearEmbedCache();
      const claims = { pub: site.id, dash: fx.pay, exp: 0, params: {}, hide: [] } as unknown as import('../src/server/embed/token').EmbedClaims;
      const embedded = await B.context.runAsPublished(DEV, 'embed', () => recordFs.withReadMemo(() => embedPage.embedHtml(site, fx.pay, claims)));
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-share-summary-cli-'));
      const cli = await inApp(() => automation.dashboardsExport({ projectId: P, transport: 'cli', cwd, headless: true, progress: () => {} }, 'Payroll board', 'html', 'out.html')) as { path: string };
      const bullets = async (id: string): Promise<string[]> => ((await rpc('report:build', { projectId: P, id })).pages || []).flatMap((p: any) => p.bullets || []); // any: a report page
      return {
        page: page('Payroll board'), hoursPage: page('Hours board'),
        embed: dataBlock('html' in embedded ? embedded.html : ''),
        exported: dataBlock(await inApp(() => pub.dashboardPageHtml(P, fx.pay))),
        cli: dataBlock(fs.readFileSync(cli.path, 'utf8')),
        report: await bullets(fx.report), hoursReport: await bullets(fx.hrsReport),
      };
    };
    type Out = Awaited<ReturnType<typeof leave>>;
    const said = (block: any): string[] => (block?.dashboard?.sheets[0].cards.find((c: any) => c.kind === 'summary')?.payloads ?? []).flatMap((p: any) => p.sentences ?? []); // any: a page's JSON
    const payrollSurfaces = (o: Out): Record<string, unknown> => ({ page: o.page, embed: o.embed, exported: o.exported, cli: o.cli, report: o.report });
    const leaks = (o: Out): Record<string, string[]> => Object.fromEntries(Object.entries(payrollSurfaces(o))
      .map(([k, v]) => [k, SALARY_BYTES.filter((b) => JSON.stringify(v ?? null).includes(b))]).filter(([, l]) => l.length));
    const hoursKpi = (lines: string[]): boolean => lines.some((s) => s.startsWith('Hours KPI rose'));
    const hoursAlert = (lines: string[]): boolean => lines.some((s) => s.startsWith('Alert “Hours above 10” fired'));

    // ── nothing marked: the payroll sentences leave ──
    const before = await leave('drop');
    ok('fixture: with nothing marked, the payroll Summary quotes the KPI, its contributor and the payroll alert on every surface',
      Object.keys(leaks(before)).length === 5 && ['page', 'embed', 'exported', 'cli'].every((k) => said((before as Record<string, unknown>)[k]).some((s) => s.startsWith('Payroll KPI rose')))
      && before.report.some((s) => s.startsWith('Alert “Payroll above 10” fired')), show([Object.keys(leaks(before)), said(before.page), before.report]));

    await inApp(() => catalog.setColumn(P, fx.S, 'salary', { sensitivity: 'financial' }));

    // ── drop ──
    const drop = await leave('drop');
    ok('drop: no salary figure, payroll sentence or payroll alert leaves on /p/, the embed, the export, the CLI/MCP export or the report bullets',
      Object.keys(leaks(drop)).length === 0, show([leaks(drop), said(drop.page), drop.report]));
    ok('drop: the KPI tile beside it is hidden, as before', drop.page.dashboard.sheets[0].cards.find((c: any) => c.title === 'Payroll KPI')?.payloads.every((p: any) => p.hidden), show(drop.page.dashboard.sheets[0].cards[0])); // any: as above
    ok('NEGATIVE CONTROL (drop): the payroll Summary names the hours alert instead, on the page and in the report',
      hoursAlert(said(drop.page)) && hoursAlert(drop.report), show([said(drop.page), drop.report]));
    ok('NEGATIVE CONTROL (drop): the hours Summary keeps its KPI sentence, on /p/ and in its report', hoursKpi(said(drop.hoursPage)) && hoursKpi(drop.hoursReport), show([said(drop.hoursPage), drop.hoursReport]));
    const app2 = await rpc('summary:compute', { projectId: P, analysisId: fx.pay, pages: (await inApp(() => analysis.getAnalysis(P, fx.pay)))!.sheets });
    ok('NEGATIVE CONTROL (drop): in the app the Summary still says the payroll KPI sentence', app2.ok && app2.sentences.some((s: any) => s.text.startsWith('Payroll KPI rose')), show(app2)); // any: a sentence

    // ── mask: an aggregate passes ──
    const mask = await leave('mask');
    ok('mask: the payroll KPI sentence leaves, as every aggregate does', said(mask.page).some((s) => s.startsWith('Payroll KPI rose')) && mask.report.some((s) => s.startsWith('Payroll KPI rose')), show([said(mask.page), mask.report]));
  } finally {
    await app.close();
  }
}

main().then(finish, (err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
