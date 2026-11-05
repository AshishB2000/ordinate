// The Share policy judges every figure by the column it is drawn from, on the table that OWNS that column
// (src/app/sharePolicy.ts `applyToChart`): a chart on Assignments totalling Employees.salary (a forward-joined
// measure) leaves exactly as the chart drawn on Employees does — hidden under drop on a /p/ page (publishHosted's
// own build, `buildPages` with the publish hook), in a dashboard's HTML export and in an export-shaped
// `visual:data`; under mask its figures pass, as every aggregate's do. A point map's size and small multiples too.
//
// Negative controls: a column nobody marked publishes its figures on the same page; the editor in the app
// still sees every figure; with salary unmarked, the pages are the ones this release pinned (sha256), so a
// page that touches no marked column publishes byte for byte as it did before.
//
//   npm run build:ts && node scripts/test-sharePolicyMeasures.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');
const { randomUUID } = crypto;

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-share-measures-'));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-share-measures-site-'));

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const store: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const metricsStore: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const pub: typeof import('../src/publish/publish') = require('../src/publish/publish');
const share: typeof import('../src/app/sharePolicy') = require('../src/app/sharePolicy');
const format: typeof import('../src/app/format') = require('../src/app/format');
const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers; // any: each reply is narrowed by its check
require('../src/ipc/visuals').register();
require('../src/ipc/dashboards').register();

const show = (v: unknown): string => JSON.stringify(v);
function dataBlock(html: string): any { // any: the page's JSON, asserted field by field
  const m = /<script type="application\/json" id="ordinate-page">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}
const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A page's data block with what differs run to run (ids, the build time) taken out, hashed. */
const pin = (html: string): string => {
  const d = dataBlock(html);
  if (d && d.site) delete d.site.generatedAt;
  return crypto.createHash('sha256').update(JSON.stringify(d).replace(UUIDS, 'U'), 'utf8').digest('hex');
};

// Salaries 91357 / 82469 / 70913: payroll 244739, on its own table and through the join alike (a one side's row
// is counted once). Hours 1213 / 719 / 3037 / 547 nobody marks.
const SALARY = ['91357', '82469', '70913'];
const HOURS = ['1213', '3037', '5516'];

async function main(): Promise<void> {
  format.setFormatPrefs({ locale: 'en-US' }); // the displays the greps and the pin read, whatever the machine's locale
  await projects.init();
  const P = (await projects.createProject('Joined share')).id;
  const E = (await datasets.saveDataset(P, { name: 'Employees', sourceKind: 'csv',
    columns: [{ name: 'emp_id', type: 'text' }, { name: 'name', type: 'text' }, { name: 'salary', type: 'number' }],
    rows: [['e1', 'Ana', 91357], ['e2', 'Bo', 82469], ['e3', 'Cy', 70913]] }))!.id;
  const A = (await datasets.saveDataset(P, { name: 'Assignments', sourceKind: 'csv',
    columns: [{ name: 'asg_id', type: 'text' }, { name: 'emp_id', type: 'text' }, { name: 'hours', type: 'number' }],
    rows: [['a1', 'e1', 1213], ['a2', 'e1', 719], ['a3', 'e2', 3037], ['a4', 'e3', 547]] }))!.id;
  await rels.saveRelationship(P, { id: randomUUID(), from: { datasetId: A, column: 'emp_id' }, to: { datasetId: E, column: 'emp_id' }, cardinality: 'many_to_one' });

  // ── the fixture, as the editor in the app sees it ──
  const FWD = { category: 'asg_id', values: [{ column: 'salary', aggregation: 'sum', datasetId: E }] }; // on Assignments: a forward join's measure
  const OWN = { category: 'name', values: [{ column: 'salary', aggregation: 'sum' }] }; // salary on its own table
  const HRS = { category: 'asg_id', values: [{ column: 'hours', aggregation: 'sum' }] }; // nobody marks hours
  const data = (datasetId: string, encoding: object, sharePath?: string) => handlers.get('visual:data')!(null, { projectId: P, datasetId, encoding, ...(sharePath ? { share: sharePath } : {}) });
  const metric = (datasetId: string, column: string) => handlers.get('dashboard:metric')!(null, { projectId: P, datasetId, column, aggregation: 'sum' });
  const inApp = async (): Promise<boolean> => {
    const [fwd, own, kOwn, kFwd] = [await data(A, FWD), await data(E, OWN), await metric(E, 'salary'), await metric(A, 'salary')];
    return fwd.ok && show(fwd.data.series[0].values) === show([91357, 91357, 82469, 70913]) && own.ok && own.data.series[0].values.includes(70913)
      && kOwn.value === 244739 && kFwd.value === 244739;
  };
  ok('fixture: in the app the forward measure draws each assignment\'s salary, and both KPIs total it', await inApp());

  const visual = async (datasetId: string, name: string, encoding: object): Promise<string> =>
    (await visuals.saveVisual(P, { datasetId, name, chartType: 'column', encoding } as any))!.id; // any: a record literal the saver sanitizes
  const charts = [await visual(A, 'Salary per assignment', FWD), await visual(E, 'Salary by person', OWN), await visual(A, 'Hours per assignment', HRS)];
  const saved = async (datasetId: string, name: string, definition: object) => (await metricsStore.saveMetric(P, { name, datasetId, definition } as any))!; // any: as above
  const mPay = await saved(E, 'Payroll metric', { column: 'salary', aggregation: 'sum' });
  const mRate = await saved(A, 'Salary per hour', { formula: 'sum(salary) / sum(hours)' }); // salary: a related column
  const mRef = await saved(A, 'Payroll per hour', { formula: '[Payroll metric] / sum(hours)' }); // another table's metric
  const mHrs = await saved(A, 'Hours per assignment metric', { formula: 'sum(hours) / count(asg_id)' });
  // Fixed card ids, so a page's bytes are the same run to run (the pin below).
  const cardId = (i: number): string => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const kpi = (i: number, datasetId: string, column: string, label: string, metricId?: string) => ({ id: cardId(i), type: 'metric', layout: { x: (i % 4) * 3, y: Math.floor(i / 4) * 2, w: 3, h: 2 },
    metric: { datasetId, column, aggregation: metricId && column !== 'salary' ? 'count' : 'sum', label, ...(metricId ? { metricId } : {}) } }); // a formula card stores its metric's name, as the app's picker does
  const board = await analysis.saveAnalysis(P, { name: 'Payroll', sheets: [{ id: cardId(99), name: 'Main', cards: [
    ...charts.map((visualId, i) => ({ id: cardId(20 + i), type: 'visual', visualId, layout: { x: 4 * i, y: 6, w: 4, h: 4 } })),
    kpi(0, E, 'salary', 'Payroll'), kpi(1, A, 'salary', 'Payroll over assignments'), kpi(2, A, 'hours', 'Hours'),
    kpi(3, E, 'salary', 'Payroll (metric)', mPay.id), kpi(4, A, mRate.name, 'Salary per hour', mRate.id),
    kpi(5, A, mRef.name, 'Payroll per hour', mRef.id), kpi(6, A, mHrs.name, 'Hours per assignment (metric)', mHrs.id),
  ] }] } as any); // any: as above
  const leave = async (action: 'mask' | 'drop' | 'include'): Promise<{ page: string; exported: string }> => {
    await store.setPolicy(P, { publish: action, export: action });
    const cfg = pub.sanitizePublishConfig({ projectId: P, dashboardIds: [board!.id], storyIds: [], outDir });
    if ('error' in cfg) throw new Error(cfg.error);
    const built = await pub.buildPages(cfg, {}, pub.policyOutgoing(P, 'publish')); // what publishHosted stores and /p/ serves
    return { page: built.pages[0].html, exported: await pub.dashboardPageHtml(P, board!.id) };
  };
  const tile = (html: string, title: string): any => dataBlock(html).dashboard.sheets[0].cards.find((c: any) => c.title === title); // any: as dataBlock
  const hidden = (html: string, title: string): boolean => ((t) => !!t && t.payloads.length > 0 && t.payloads.every((p: any) => p.hidden === share.HIDDEN_BY_POLICY))(tile(html, title)); // any: as above
  const figure = (html: string, title: string): any => tile(html, title)?.payloads[0]; // any: as above
  const leaks = (html: string, bytes: string[]): string[] => bytes.filter((b) => html.includes(b));
  const MARKED_KPIS = ['Payroll', 'Payroll over assignments', 'Payroll (metric)', 'Salary per hour', 'Payroll per hour'];

  // ── with nothing marked: what an old page publishes, pinned ──
  const before = await leave('drop');
  const PINNED = { // the pages develop 98176da9 published for this fixture — re-pin only for a page format changed on purpose
    page: '84b8086aa83cce8896608815089a70ab856059752fbbbd01cd0d32a7e6217e22',
    exported: '5097d79e7be0b90e022be5088d6fcf0ff270b87d00143a2a96bda328f59c3f99',
  };
  ok('PIN: with nothing marked, the /p/ page is the one published before this change, byte for byte', pin(before.page) === PINNED.page, pin(before.page));
  ok('PIN: …and the HTML export', pin(before.exported) === PINNED.exported, pin(before.exported));
  ok('fixture: with nothing marked, every KPI publishes its figure', MARKED_KPIS.every((t) => typeof figure(before.page, t)?.value === 'number') && figure(before.page, 'Payroll').value === 244739,
    show(MARKED_KPIS.map((t) => figure(before.page, t))));

  await catalog.setColumn(P, E, 'salary', { sensitivity: 'financial' });

  // ── drop ──
  const drop = await leave('drop');
  for (const [where, html] of [['/p/ page', drop.page], ['HTML export', drop.exported]] as const) {
    ok(`drop, ${where}, control: the chart over salary on Employees is hidden`, hidden(html, 'Salary by person'), show(tile(html, 'Salary by person')));
    ok(`drop, ${where}: the chart on Assignments totalling Employees.salary is hidden, as that chart is`, hidden(html, 'Salary per assignment'), show(tile(html, 'Salary per assignment')));
    ok(`drop, ${where}: no employee's salary is anywhere on it`, leaks(html, SALARY).length === 0, show(leaks(html, SALARY)));
    ok(`NEGATIVE CONTROL (drop, ${where}): the hours chart and both hours KPIs publish their figures`, !hidden(html, 'Hours per assignment') && figure(html, 'Hours').value === 5516
      && typeof figure(html, 'Hours per assignment (metric)').value === 'number' && leaks(html, HOURS).length === HOURS.length, show([tile(html, 'Hours per assignment'), figure(html, 'Hours')]));
  }
  ok('drop: an export-shaped visual:data hides the forward measure, as the chart on Employees', (await data(E, OWN, 'export')).hiddenByPolicy === true && (await data(A, FWD, 'export')).hiddenByPolicy === true);
  ok('NEGATIVE CONTROL (drop): …and answers the hours chart', (await data(A, HRS, 'export')).ok === true);
  ok('NEGATIVE CONTROL (drop): the editor in the app still sees every figure', await inApp());

  // A point map's size and a small-multiples measure are judged on the measure's own table too.
  const shape = (encoding: object, d: object) => share.applyToChart(P, A, encoding as any, { ok: true, data: { labels: [], series: [], ...d } }, 'publish'); // any: encoding literals
  const point = (aggregation: string) => shape({ category: 'asg_id', geo: { level: 'point', lat: 'lat', lon: 'lon' }, values: [{ column: 'salary', aggregation, datasetId: E }] }, { geo: {} });
  const facet = (column: string, datasetId?: string) => shape({ category: 'asg_id', facet: { rows: 'emp_id' }, values: [{ column, aggregation: 'sum', ...(datasetId ? { datasetId } : {}) }] }, { facets: [] });
  ok('drop: small multiples over a forward join\'s salary are hidden', ((await facet('salary', E)) as { hiddenByPolicy?: boolean }).hiddenByPolicy === true);
  ok('NEGATIVE CONTROL (drop): …over hours, they are not', (await facet('hours')).ok === true);

  // ── mask: an aggregate passes, so each figure is published as it was ──
  const mask = await leave('mask');
  ok('mask: a point map sized by a forward join\'s salary is hidden (a size is a row\'s own cell)', ((await point('sum')) as { hiddenByPolicy?: boolean }).hiddenByPolicy === true);
  ok('NEGATIVE CONTROL (mask): sized by a count, it is not', (await point('count')).ok === true);
  for (const [where, html] of [['/p/ page', mask.page], ['HTML export', mask.exported]] as const) {
    ok(`mask, ${where}: the forward measure's figures pass, as every aggregate's do`, !hidden(html, 'Salary per assignment') && leaks(html, SALARY).length === SALARY.length, show(tile(html, 'Salary per assignment')));
  }

  // ── include: everything passes ──
  const incl = await leave('include');
  ok('NEGATIVE CONTROL (include): every salary is on the page, so the drop grep can see them', leaks(incl.page, SALARY).length === SALARY.length, show(leaks(incl.page, SALARY)));

  // ── a column nobody marked: drop leaves it alone, and the page is the old one again ──
  await catalog.setColumn(P, E, 'salary', { sensitivity: 'none' });
  const after = await leave('drop');
  ok('NEGATIVE CONTROL: with salary unmarked again, drop publishes the forward measure', !hidden(after.page, 'Salary per assignment'));
  ok('PIN: …and the page and the export are byte for byte the ones before salary was marked', pin(after.page) === pin(before.page) && pin(after.exported) === pin(before.exported));
}

main().then(finish, (err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
