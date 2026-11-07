// The Share policy judges each measure by ITS OWN dataset (src/app/sharePolicy.ts `applyToChart`): a chart on
// Departments totalling Employees.salary (a many-side measure, semantic layer part 8) leaves shaped exactly as
// the same chart drawn on Employees does — hidden under drop on a /p/ page (publishHosted's own build,
// `buildPages` with the publish hook), in a dashboard's HTML export and in an export-shaped `visual:data`; its
// figures pass under mask, as every aggregate's do. The same holds for a forward-joined measure (a one side's
// marked column totalled on the many side), for a formula metric totalling a many-side column (step 07: each
// leaf on its own table) and for a KPI over one, which publishes exactly what that KPI on its own table does.
//
//   npm run build:ts && node scripts/test-sharePolicyFanOut.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { randomUUID }: typeof import('crypto') = require('crypto');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-share-fanout-'));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-share-fanout-site-'));

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const store: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const pub: typeof import('../src/publish/publish') = require('../src/publish/publish');
const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers; // any: each reply is narrowed by its check
require('../src/ipc/visuals').register();

const show = (v: unknown): string => JSON.stringify(v);
function dataBlock(html: string): any { // any: the page's JSON, asserted field by field
  const m = /<script type="application\/json" id="ordinate-page">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

// Payroll per department: Ops 91357 + 82469 = 173826 (a caption says 173.8K), Lab 70913 + 66251 = 137164. Budgets: 4400017 (4.4M) and 3300023.
const PAYROLL = ['173826', '173.8K', '137164'];
const BUDGET = ['4400017', '4.4M', '3300023'];

async function main(): Promise<void> {
  await projects.init();
  const P = (await projects.createProject('Fan-out share')).id;
  const D = (await datasets.saveDataset(P, { name: 'Departments', sourceKind: 'csv',
    columns: [{ name: 'dept_id', type: 'text' }, { name: 'name', type: 'text' }, { name: 'budget', type: 'number' }],
    rows: [['d1', 'Ops', 4400017], ['d2', 'Lab', 3300023]] }))!.id;
  const E = (await datasets.saveDataset(P, { name: 'Employees', sourceKind: 'csv',
    columns: [{ name: 'emp_id', type: 'text' }, { name: 'dept_id', type: 'text' }, { name: 'salary', type: 'number' }],
    rows: [['e1', 'd1', 91357], ['e2', 'd1', 82469], ['e3', 'd2', 70913], ['e4', 'd2', 66251]] }))!.id;
  await rels.saveRelationship(P, { id: randomUUID(), from: { datasetId: E, column: 'dept_id' }, to: { datasetId: D, column: 'dept_id' }, cardinality: 'many_to_one' });
  await catalog.setColumn(P, E, 'salary', { sensitivity: 'financial' });
  await catalog.setColumn(P, D, 'budget', { sensitivity: 'financial' });

  const FAN = { category: 'name', values: [{ column: 'salary', aggregation: 'sum', datasetId: E }] }; // on Departments: a many side's measure
  const OWN = { category: 'name', categoryDatasetId: D, values: [{ column: 'salary', aggregation: 'sum' }] }; // the same chart on Employees
  const FWD = { category: 'emp_id', values: [{ column: 'budget', aggregation: 'sum', datasetId: D }] }; // on Employees: a forward join's measure
  const data = (datasetId: string, encoding: object, share?: string) => handlers.get('visual:data')!(null, { projectId: P, datasetId, encoding, ...(share ? { share } : {}) });
  const fan = await data(D, FAN);
  const own = await data(E, OWN);
  ok('fixture: in the app the fan-out chart draws each department\'s payroll, as the chart on Employees does',
    fan.ok && own.ok && show(fan.data.labels) === show(['Ops', 'Lab']) && fan.data.series[0].values.every((v: number, i: number) => Object.is(v, own.data.series[0].values[i])) && fan.data.series[0].values.includes(173826), show([fan, own]));
  const fwd = await data(E, FWD);
  ok('fixture: in the app the forward measure draws each employee\'s department budget', fwd.ok && fwd.data.series[0].values.includes(4400017), show(fwd));

  const visual = async (datasetId: string, name: string, encoding: object): Promise<string> =>
    (await visuals.saveVisual(P, { datasetId, name, chartType: 'column', encoding } as any))!.id; // any: a record literal the saver sanitizes
  const ids = [await visual(D, 'Payroll by department', FAN), await visual(E, 'Payroll on Employees', OWN), await visual(E, 'Budget per employee', FWD)];
  const dash = await analysis.saveAnalysis(P, { name: 'Payroll', sheets: [{ id: randomUUID(), name: 'Main',
    cards: ids.map((visualId, i) => ({ id: randomUUID(), type: 'visual', visualId, layout: { x: 4 * i, y: 0, w: 4, h: 4 } })) }] } as any); // any: as above
  // Step 07: KPIs over salary on each table, and a formula metric over it charted on each.
  const metricsStore: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
  const formula = async (datasetId: string, name: string, f: string) => (await metricsStore.saveMetric(P, { name, datasetId, definition: { formula: f } } as any))!; // any: as above
  const perDept = await formula(D, 'Payroll per department', 'sum(salary) / count(dept_id)');
  const perEmp = await formula(E, 'Payroll per head', 'sum(salary) / count(emp_id)');
  const viaMetric = [await visual(D, 'Formula on Departments', { category: 'name', values: [{ column: perDept.name, aggregation: 'sum', metricId: perDept.id }] }),
    await visual(E, 'Formula on Employees', { category: 'name', categoryDatasetId: D, values: [{ column: perEmp.name, aggregation: 'sum', metricId: perEmp.id }] })];
  const kpi = (datasetId: string, label: string, x: number) => ({ id: randomUUID(), type: 'metric', metric: { datasetId, column: 'salary', aggregation: 'sum', label }, layout: { x, y: 0, w: 3, h: 2 } });
  // …and that formula as a KPI on Departments: its leaf is on Employees, so the Share policy judges it there (publish/kpiPolicy).
  const formulaKpi = { id: randomUUID(), type: 'metric', metric: { datasetId: D, column: 'salary', aggregation: 'sum', metricId: perDept.id, label: 'Formula KPI on Departments' }, layout: { x: 9, y: 0, w: 3, h: 2 } };
  const kpis = await analysis.saveAnalysis(P, { name: 'Payroll KPIs', sheets: [{ id: randomUUID(), name: 'Main', cards: [kpi(D, 'Payroll on Departments', 0), kpi(E, 'Payroll on Employees', 3), formulaKpi,
    ...viaMetric.map((visualId, i) => ({ id: randomUUID(), type: 'visual', visualId, layout: { x: 6 * i, y: 2, w: 6, h: 4 } }))] }] } as any); // any: as above
  const leave = async (action: 'mask' | 'drop', board = dash!.id): Promise<{ page: string; exported: string }> => {
    await store.setPolicy(P, { publish: action, export: action });
    const cfg = pub.sanitizePublishConfig({ projectId: P, dashboardIds: [board], storyIds: [], outDir });
    if ('error' in cfg) throw new Error(cfg.error);
    const built = await pub.buildPages(cfg, {}, pub.policyOutgoing(P, 'publish')); // what publishHosted stores and /p/ serves
    return { page: built.pages[0].html, exported: await pub.dashboardPageHtml(P, board) };
  };
  const tile = (html: string, title: string): any => dataBlock(html).dashboard.sheets[0].cards.find((c: any) => c.title === title); // any: as dataBlock
  const hidden = (html: string, title: string): boolean => ((t) => !!t && t.payloads.length > 0 && t.payloads.every((p: any) => p.hidden === 'Hidden by the share policy'))(tile(html, title)); // any: as above
  const leaks = (html: string, bytes: string[]): string[] => bytes.filter((b) => html.includes(b));

  // ── drop ──
  const drop = await leave('drop');
  for (const [where, html] of [['/p/ page', drop.page], ['HTML export', drop.exported]] as const) {
    ok(`drop, ${where}, control: the chart on Employees itself is hidden`, hidden(html, 'Payroll on Employees'), show(tile(html, 'Payroll on Employees')));
    ok(`drop, ${where}: the fan-out chart over Employees.salary is hidden, as that chart is`, hidden(html, 'Payroll by department'), show(tile(html, 'Payroll by department')));
    ok(`drop, ${where}: the forward measure over Departments.budget is hidden`, hidden(html, 'Budget per employee'), show(tile(html, 'Budget per employee')));
    ok(`drop, ${where}: no payroll total and no budget is anywhere on it`, leaks(html, [...PAYROLL, ...BUDGET]).length === 0, show(leaks(html, [...PAYROLL, ...BUDGET])));
  }
  ok('drop: an export-shaped visual:data hides the fan-out chart, as the chart on Employees', (await data(E, OWN, 'export')).hiddenByPolicy === true && (await data(D, FAN, 'export')).hiddenByPolicy === true);
  ok('drop: …and the forward measure', (await data(E, FWD, 'export')).hiddenByPolicy === true);

  // ── mask: an aggregate passes, so the fan-out tile is the own-table tile's, byte for byte ──
  const mask = await leave('mask');
  const payloads = (title: string): string => show(tile(mask.page, title).payloads.map(({ note: _n, ...p }: any) => p)); // any: as above; the fan-out's own-rows note aside
  ok('mask: the fan-out tile publishes exactly what the chart on Employees publishes', payloads('Payroll by department') === payloads('Payroll on Employees'), show([payloads('Payroll by department'), payloads('Payroll on Employees')]));
  const all = [...PAYROLL, ...BUDGET];
  ok('NEGATIVE CONTROL (mask): every total and budget is on the page, so the drop checks above can see them', leaks(mask.page, all).length === all.length, show(leaks(mask.page, all)));

  // A point map's size is its row's own cell, so a marked size column hides the map even under mask — on its own table.
  const share: typeof import('../src/app/sharePolicy') = require('../src/app/sharePolicy');
  const point = (aggregation: string) => share.applyToChart(P, E, { category: 'emp_id', geo: { level: 'point', lat: 'lat', lon: 'lon' }, values: [{ column: 'budget', aggregation, datasetId: D }] } as any, // any: a geo encoding literal
    { ok: true, data: { labels: [], series: [], geo: {} } }, 'publish');
  ok('mask: a point map sized by a forward join\'s marked budget is hidden', ((await point('sum')) as { hiddenByPolicy?: boolean }).hiddenByPolicy === true);
  ok('NEGATIVE CONTROL (mask): sized by a count, it is not', (await point('count')).ok === true);

  // ── step 07 ──
  const figure = (html: string, title: string): string => show(tile(html, title).payloads.map(({ value, display, subtitle }: any) => ({ value, display, subtitle }))); // any: as above
  for (const action of ['drop', 'mask'] as const) {
    const out = await leave(action, kpis!.id);
    for (const [where, html] of [['/p/ page', out.page], ['HTML export', out.exported]] as const) {
      ok(`${action}, ${where}: the KPI over Employees.salary on Departments publishes what that KPI on Employees does (no subtitle naming the marked column)`,
        figure(html, 'Payroll on Departments') === figure(html, 'Payroll on Employees'),
        show([figure(html, 'Payroll on Departments'), figure(html, 'Payroll on Employees')]));
      // A KPI's figure is shaped as a chart over its column is (publish/kpiPolicy), judged on the table it totals.
      if (action === 'drop') ok(`drop, ${where}: …which is hidden, as the KPI on Employees is, and the payroll total is on neither`,
        hidden(html, 'Payroll on Departments') && hidden(html, 'Payroll on Employees') && leaks(html, ['310990', '311.0K']).length === 0, show(leaks(html, ['310990', '311.0K'])));
      else ok(`mask, ${where}: …which is the payroll total, as every aggregate passes`, tile(html, 'Payroll on Employees').payloads[0].value === 310990, figure(html, 'Payroll on Employees'));
      ok(`${action}, ${where}: the formula KPI over Employees.salary on Departments is ${action === 'drop' ? 'hidden' : 'its figure, 155495'}`,
        action === 'drop' ? hidden(html, 'Formula KPI on Departments') && leaks(html, ['155495', '155,495']).length === 0 : tile(html, 'Formula KPI on Departments').payloads[0].value === 155495, figure(html, 'Formula KPI on Departments'));
      if (action === 'drop') {
        ok(`drop, ${where}, control: the formula metric charted on Employees is hidden`, hidden(html, 'Formula on Employees'), show(tile(html, 'Formula on Employees')));
        ok(`drop, ${where}: the formula over Employees.salary charted on Departments is hidden too`, hidden(html, 'Formula on Departments'), show(tile(html, 'Formula on Departments')));
        ok(`drop, ${where}: …so no department's payroll is on it`, leaks(html, PAYROLL).length === 0, show(leaks(html, PAYROLL)));
      }
    }
  }

  // ── a column nobody marked: drop leaves it alone ──
  await catalog.setColumn(P, E, 'salary', { sensitivity: 'none' });
  const open = await leave('drop');
  ok('NEGATIVE CONTROL: with salary unmarked, drop publishes the fan-out tile\'s figures', !hidden(open.page, 'Payroll by department') && leaks(open.page, ['173826']).length === 1, show(tile(open.page, 'Payroll by department')));
  const openKpis = await leave('drop', kpis!.id);
  ok('NEGATIVE CONTROL: …and the formula on Departments, with its payroll', !hidden(openKpis.page, 'Formula on Departments') && leaks(openKpis.page, ['173826']).length === 1, show(tile(openKpis.page, 'Formula on Departments')));
  ok('NEGATIVE CONTROL: …and the formula KPI, with its figure', !hidden(openKpis.page, 'Formula KPI on Departments') && tile(openKpis.page, 'Formula KPI on Departments').payloads[0].value === 155495, figure(openKpis.page, 'Formula KPI on Departments'));
  ok('NEGATIVE CONTROL: …and each KPI says what it measures, so the subtitle check above can see one', JSON.parse(figure(openKpis.page, 'Payroll on Departments'))[0].subtitle === 'Sum of salary'
    && figure(openKpis.page, 'Payroll on Departments') === figure(openKpis.page, 'Payroll on Employees'), figure(openKpis.page, 'Payroll on Departments'));
}

main().then(finish, (err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
