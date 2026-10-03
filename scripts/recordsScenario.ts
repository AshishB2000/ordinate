// One scripted pass over EVERY record store's public API, run by
// scripts/test-records.ts once per backend in a fresh process:
//
//   node scripts/recordsScenario.js json <dataDir>
//   node scripts/recordsScenario.js pg   <dataDir> <databaseUrl>
//
// The clock is frozen (advanced by hand between steps) and randomUUID counts,
// so both runs mint the same ids and timestamps: their transcripts — every
// call's result — and their final record state must be IDENTICAL. Prints one
// JSON line: { steps: [[label, result]], records: {path: text}, files: [...] }.

export {}; // module scope — sibling scripts share top-level names
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

const [backend, dataDir, dbUrl] = process.argv.slice(2);
const ORG = 'diff';

// Electron is only reached lazily (bundle export's app.getVersion); never on the server path.
const Module = require('module') as { _load: (req: string, ...rest: unknown[]) => unknown };
const origLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]): unknown {
  if (request === 'electron') return { app: { getVersion: () => '0.0.0-test', getPath: () => { throw new Error('server mode: no Electron paths'); } } };
  return origLoad.apply(this, [request, ...rest]);
};

// ── Deterministic ids and time ─────────────────────────────────────────────
let uuidN = 0;
// The real module object (an `import *` is a getter-only copy), which every store's compiled `crypto_1.randomUUID()` reads.
(require('crypto') as { randomUUID: () => string }).randomUUID = () => `00000000-0000-4000-8000-${(++uuidN).toString(16).padStart(12, '0')}`;
const RealDate = Date;
let now = RealDate.UTC(2026, 0, 5, 9, 0, 0);
class FrozenDate extends RealDate {
  // ponytail: Date's constructor overloads; no-arg = the frozen clock, anything else as given
  constructor(...args: any[]) {
    if (args.length === 0) super(now);
    else super(...(args as [number]));
  }
  static now(): number { return now; }
}
(globalThis as { Date: DateConstructor }).Date = FrozenDate as DateConstructor;
const tick = (): void => { now += 60_000; };

// The search index is rebuilt on a 1.5 s wall-clock timer after a save: in
// whichever run is slower it fires mid-scenario and takes a randomUUID, and
// the ids drift. It is a Parquet cache, not a record — switch it off.
(require('../src/engine/dataSearchResident') as { scheduleIndex: () => void }).scheduleIndex = () => undefined;

const context: typeof import('../src/server/context') = require('../src/server/context');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');

const steps: Array<[string, unknown]> = [];
async function step(label: string, fn: () => unknown): Promise<any> { // ponytail: any — each store's own result type
  tick();
  let out: unknown;
  try {
    out = await fn();
  } catch (err) {
    out = { threw: (err as Error).message };
  }
  steps.push([label, out]);
  return out;
}

async function scenario(): Promise<void> {
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
  const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
  const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
  const reports: typeof import('../src/analysis/reportSpec') = require('../src/analysis/reportSpec');
  const alerts: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
  const stories: typeof import('../src/analysis/stories') = require('../src/analysis/stories');
  const scorecards: typeof import('../src/analysis/scorecards') = require('../src/analysis/scorecards');
  const scenarios: typeof import('../src/analysis/scenarios') = require('../src/analysis/scenarios');
  const notebooks: typeof import('../src/analysis/notebook/store') = require('../src/analysis/notebook/store');
  const events: typeof import('../src/analysis/eventStore') = require('../src/analysis/eventStore');
  const rels: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
  const fx: typeof import('../src/app/fxStore') = require('../src/app/fxStore');
  const comments: typeof import('../src/app/comments') = require('../src/app/comments');
  const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
  const pipelines: typeof import('../src/app/pipelineStore') = require('../src/app/pipelineStore');
  const privacy: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
  const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
  const publish: typeof import('../src/publish/publish') = require('../src/publish/publish');
  const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
  const boundaries: typeof import('../src/app/projectBoundaries') = require('../src/app/projectBoundaries');
  const versions: typeof import('../src/app/versions') = require('../src/app/versions');
  const trash: typeof import('../src/app/trash') = require('../src/app/trash');
  const history: typeof import('../src/app/history') = require('../src/app/history');
  const themes: typeof import('../src/app/themeStore') = require('../src/app/themeStore');
  const templates: typeof import('../src/app/userTemplateStore') = require('../src/app/userTemplateStore');
  const { captureTemplate }: typeof import('../src/analysis/userTemplate') = require('../src/analysis/userTemplate');
  const bundle: typeof import('../src/app/bundle') = require('../src/app/bundle');

  // projects
  await step('projects.init', () => projects.init());
  const P = await step('projects.create', () => projects.createProject('Records'));
  const Q = await step('projects.create second', () => projects.createProject('Scratch'));
  const pid: string = P.id;
  await step('projects.rename', () => projects.renameProject(pid, 'Records renamed'));
  await step('projects.setArchived', () => projects.setArchived(Q.id, true));
  await step('projects.touchOpened', () => projects.touchOpened(pid));
  await step('projects.list', () => projects.listProjects());
  await step('projects.get', () => projects.getProject(pid));

  // datasets (metadata row + Parquet on disk)
  const columns = [{ name: 'region', type: 'text' }, { name: 'sales', type: 'number' }];
  const D = await step('datasets.save', () => datasets.saveDataset(pid, { name: 'Orders', sourceKind: 'csv', columns, rows: [['East', 10], ['West', 20], ['West', 5]] } as never));
  const D2 = await step('datasets.save second', () => datasets.saveDataset(pid, { name: 'Other', sourceKind: 'csv', columns, rows: [['North', 1]] } as never));
  await step('datasets.updateSteps', () => datasets.updateSteps(pid, D.id, [{ type: 'filter', column: 'sales', op: '>', value: 4 }] as never));
  await step('datasets.list', () => datasets.listDatasets(pid));
  await step('datasets.getMeta', () => datasets.getDatasetMeta(pid, D.id));
  await step('datasets.get', () => datasets.getDataset(pid, D.id));

  // visuals, dashboards, metrics, reports
  const V = await step('visuals.save', () => visuals.saveVisual(pid, { name: 'Sales by region', datasetId: D.id, chartType: 'column', encoding: { category: 'region', values: [{ column: 'sales', aggregation: 'sum' }] } }));
  await step('visuals.save on second dataset', () => visuals.saveVisual(pid, { name: 'Other chart', datasetId: D2.id, chartType: 'bar', encoding: { category: 'region', values: [{ column: 'sales', aggregation: 'sum' }] } }));
  await step('visuals.update', () => visuals.updateVisual(pid, V.id, { name: 'Sales by region v2' } as never));
  await step('visuals.duplicate', () => visuals.duplicateVisual(pid, V.id));
  await step('visuals.list', () => visuals.listVisuals(pid));
  await step('visuals.get', () => visuals.getVisual(pid, V.id));
  const A = await step('analysis.save', () => analysis.saveAnalysis(pid, { name: 'Board', sheets: [{ name: 'Overview', cards: [{ type: 'visual', visualId: V.id, layout: { x: 0, y: 0, w: 6, h: 4 } }] }] }));
  await step('analysis.update', () => analysis.updateAnalysis(pid, A.id, { name: 'Board v2' } as never));
  await step('analysis.list', () => analysis.listAnalyses(pid));
  await step('analysis.get', () => analysis.getAnalysis(pid, A.id));
  const M = await step('metrics.save', () => metrics.saveMetric(pid, { name: 'Sales', datasetId: D.id, definition: { column: 'sales', aggregation: 'sum' } }));
  await step('metrics.update', () => metrics.updateMetric(pid, M.id, { name: 'Total sales' } as never));
  await step('metrics.duplicate', () => metrics.duplicateMetric(pid, M.id));
  await step('metrics.list', () => metrics.listMetrics(pid));
  const R = await step('reports.save', () => reports.saveReport(pid, { analysisId: A.id, name: 'Weekly' }));
  await step('reports.update', () => reports.updateReport(pid, R.id, { name: 'Weekly v2' } as never));
  await step('reports.list', () => reports.listReports(pid));
  await step('reports.get', () => reports.getReport(pid, R.id));

  // versions (the IPC layer records one per save; called directly here)
  for (const [type, get] of [['visual', () => visuals.getVisual(pid, V.id)], ['dashboard', () => analysis.getAnalysis(pid, A.id)], ['metric', () => metrics.getMetric(pid, M.id)]] as const) {
    await step(`versions.record ${type}`, async () => versions.record(pid, type, await get()));
    await step(`versions.record ${type} same content`, async () => versions.record(pid, type, await get()));
  }
  await step('metrics.update again', () => metrics.updateMetric(pid, M.id, { name: 'Net sales' } as never));
  await step('versions.record metric v2', async () => versions.record(pid, 'metric', await metrics.getMetric(pid, M.id)));
  await step('versions.list visual', () => versions.list(pid, 'visual', V.id));
  await step('versions.list dashboard', () => versions.list(pid, 'dashboard', A.id));
  const vk = await step('versions.list metric', () => versions.list(pid, 'metric', M.id));
  if (Array.isArray(vk) && vk.length) await step('versions.get metric oldest', () => versions.get(pid, 'metric', M.id, vk[vk.length - 1].key));

  // alerts.json (one file per project)
  const rule = await step('alerts.saveRule', () => alerts.saveRule(pid, { name: 'Sales under 20', datasetId: D.id, metric: { column: 'sales', aggregation: 'sum' }, compare: 'threshold', threshold: { op: '<', value: 20 } }));
  await step('alerts.patchRule', () => alerts.patchRule(pid, rule.id, { name: 'Sales under 25' }));
  await step('alerts.setDigest', () => alerts.setDigest(pid, true));
  await step('alerts.recordEvents', () => alerts.recordEvents(pid, [{ id: '90000000-0000-4000-8000-000000000001', ruleId: rule.id, ruleName: 'Sales under 25', at: new Date().toISOString(), value: 15 } as never]));
  await step('alerts.markSeen', () => alerts.markSeen(pid));
  await step('alerts.load', () => alerts.load(pid));

  // the smaller per-project files
  const S = await step('stories.save', () => stories.saveStory(pid, { name: 'Q4 review', blocks: [{ type: 'text', text: 'Hello' }] }));
  await step('stories.update', () => stories.updateStory(pid, S.id, { name: 'Q4 review v2' }));
  await step('stories.list', () => stories.listStories(pid));
  const SC = await step('scorecards.save', () => scorecards.saveScorecard(pid, { name: 'Monthly', period: 'month', rows: [{ metricId: M.id, target: 100, group: 'Sales' }] }));
  await step('scorecards.duplicate', () => scorecards.duplicateScorecard(pid, SC.id));
  await step('scorecards.list', () => scorecards.listScorecards(pid));
  const SN = await step('scenarios.save', () => scenarios.saveScenario(pid, { name: 'Price +5%', baseMetricIds: [M.id], drivers: [] } as never));
  await step('scenarios.update', () => scenarios.updateScenario(pid, SN.id, { name: 'Price +6%' } as never));
  await step('scenarios.list', () => scenarios.listScenarios(pid));
  const NB = await step('notebooks.create', () => notebooks.createNotebook(pid, { name: 'Review', cells: [] }));
  await step('notebooks.update', () => notebooks.updateNotebook(pid, NB.id, { name: 'Review v2' }));
  await step('notebooks.list', () => notebooks.listNotebooks(pid));
  await step('events.save', () => events.save(pid, { events: [{ id: '90000000-0000-4000-8000-000000000002', name: 'Launch', start: '2026-01-02', end: '2026-01-02' } as never], calendars: ['us'] }));
  await step('events.load', () => events.load(pid));
  const REL = await step('relationships.save', () => rels.saveRelationship(pid, { from: { datasetId: D.id, column: 'region' }, to: { datasetId: D2.id, column: 'region' } }));
  await step('relationships.list', () => rels.listRelationships(pid));
  await step('fx.setProjectFx', () => fx.setProjectFx(pid, { target: 'USD' }));
  await step('fx.setColumnCurrency', () => fx.setColumnCurrency(pid, D.id, 'sales', 'EUR'));
  await step('fx.get', () => fx.getFx(pid));
  const C = await step('comments.add', () => comments.add(pid, { kind: 'analysis', id: A.id }, 'Is **Q3** net of returns?'));
  const cid = C && C.comments && C.comments[0] ? C.comments[0].id : '';
  await step('comments.reply', () => comments.reply(pid, cid, 'Yes'));
  await step('comments.resolve', () => comments.resolve(pid, cid));
  await step('comments.list', () => comments.list(pid));
  await step('catalog.setDoc', () => catalog.setDoc(pid, 'dataset:' + D.id, { description: 'Every order', tags: ['#Sales'], owner: 'Ana' } as never));
  await step('catalog.setColumn', () => catalog.setColumn(pid, D.id, 'region', { description: 'Where' } as never));
  await step('catalog.load', () => catalog.load(pid));
  await step('pipelines.update', () => pipelines.update(pid, (s) => { s.paused = [D.id]; }));
  await step('pipelines.load', () => pipelines.load(pid));
  await step('privacy.setPolicy', () => privacy.setPolicy(pid, { export: 'drop' }));
  await step('privacy.getPolicy', () => privacy.getPolicy(pid));
  await step('privacy.decide', () => privacy.decide(pid, D.id, 'region', 'personal'));
  await step('privacy.getReview', () => privacy.getReview(pid, D.id));
  const T1 = await step('copilot.createThread', () => copilot.createThread(pid));
  await step('copilot.appendTurn', () => copilot.appendTurn(pid, { role: 'user', text: 'Total sales?' }, T1.id));
  await step('copilot.listThreads', () => copilot.listThreads(pid));
  await step('copilot.loadHistory', () => copilot.loadHistory(pid, T1.id));
  const cfg = publish.sanitizePublishConfig({ projectId: pid, dashboardIds: [A.id], storyIds: [], outDir: path.join(dataDir, 'site-out'), options: { title: 'Site' } });
  await step('publish.storeConfig', () => ('error' in cfg ? cfg : publish.storeConfig(cfg)));
  await step('publish.getStoredConfig', () => publish.getStoredConfig(pid));
  const CN = await step('connections.save', () => connections.saveConnection(pid, { connectorId: 'postgres', name: 'Warehouse', values: { host: 'db.internal', port: 5432, database: 'w', user: 'r' } } as never));
  await step('connections.update', () => connections.updateConnection(pid, CN.id, { name: 'Warehouse 2' } as never));
  await step('connections.list', () => connections.listConnections(pid));
  const geo = JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'A' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }] });
  const B = await step('boundaries.import', () => boundaries.importBoundaryText(pid, 'Zones', geo));
  await step('boundaries.list', () => boundaries.listBoundaries(pid));
  await step('boundaries.get', () => boundaries.getBoundary(pid, B.id));

  // org-level records: capture history, themes, user templates
  await step('history.saveThread', () => history.saveThread({ id: '1700000000000', projectId: pid, title: 'First', createdAt: 'a', updatedAt: 'b', cropPath: null, messages: [{ role: 'user', text: 'hi' }] }));
  await step('history.setDatasetId', () => history.setDatasetId('1700000000000', D.id));
  await step('history.summaries', () => history.loadAllSummaries(pid));
  await step('history.load', () => history.loadThread('1700000000000'));
  const TH = await step('themes.save', () => themes.saveTheme({ name: 'Brand', tokens: { '--bg': '#ffffff' } }));
  await step('themes.setDefault', () => themes.setDefaultTheme(TH.theme && TH.theme.id));
  await step('themes.list', () => themes.listThemes());
  const full = await analysis.getAnalysis(pid, A.id);
  const cap = captureTemplate({ analysis: full as never, visuals: [(await visuals.getVisual(pid, V.id)) as never], dataset: { id: D.id, columns, steps: [], summaries: columns.map((c) => ({ ...c, nonEmpty: 3 })) } as never, metrics: [] });
  const TP = await step('templates.save', () => templates.saveTemplate({ id: '', name: 'Captured', description: '', createdAt: new Date().toISOString(), roles: cap.roles.map(({ column: _c, uses: _u, where: _w, ...r }) => r), body: cap.body, thumbnail: '' } as never));
  await step('templates.update', () => templates.updateTemplate(TP && TP.id, { name: 'Captured v2' }));
  await step('templates.list', () => templates.listTemplates());

  // trash: a dataset takes its visual along; every other kind round-trips
  await step('trash.dataset', () => trash.trashRecord(pid, 'dataset', D2.id));
  await step('trash.list after dataset', () => trash.list(pid));
  await step('datasets.list without it', () => datasets.listDatasets(pid));
  await step('trash.restore dataset', () => trash.restore(pid, 'dataset', D2.id));
  await step('datasets.get restored', () => datasets.getDataset(pid, D2.id));
  for (const [type, id] of [['visual', V.id], ['dashboard', A.id], ['metric', M.id], ['report', R.id], ['alert', rule.id]] as const) {
    await step(`trash.${type}`, () => trash.trashRecord(pid, type, id));
    await step(`trash.restore ${type}`, () => trash.restore(pid, type, id));
  }
  await step('trash.metric again', () => trash.trashRecord(pid, 'metric', M.id));
  await step('trash.purge metric', () => trash.purge(pid, 'metric', M.id));
  await step('trash.report again', () => trash.trashRecord(pid, 'report', R.id));
  await step('trash.list end', () => trash.list(pid));
  await step('versions.list metric after purge', () => versions.list(pid, 'metric', M.id));

  // whole-project paths: bundle export walks the tree
  await step('bundle.export entries', async () => {
    const r = await bundle.exportProject(pid);
    return r && bundle.readZip(r.bytes).map((e) => [e.name, e.name.endsWith('.parquet') ? e.data.length : e.data.toString('utf8')]);
  });

  // deletes
  await step('relationships.delete', () => rels.deleteRelationship(pid, REL.id));
  await step('stories.delete', () => stories.deleteStory(pid, S.id));
  await step('notebooks.delete', () => notebooks.deleteNotebook(pid, NB.id));
  await step('connections.delete', () => connections.deleteConnection(pid, CN.id));
  await step('comments.remove', () => comments.remove(pid, cid));
  await step('copilot.clear', () => copilot.clearHistory(pid));
  await step('themes.delete', () => themes.deleteTheme(TH.theme && TH.theme.id));
  await step('templates.delete', () => templates.deleteTemplate(TP && TP.id));
  await step('history.delete', () => history.deleteThread('1700000000000'));
  await step('datasets.delete', () => datasets.deleteDataset(pid, D.id));
  await step('projects.delete scratch', () => projects.deleteProject(Q.id));
  await step('projects.list end', () => projects.listProjects());
  await step('getters on deleted ids', async () => [
    await datasets.getDatasetMeta(pid, D.id), await stories.getStory(pid, S.id), await projects.getProject(Q.id),
    await visuals.getVisual(Q.id, V.id), await history.loadThread('1700000000000'),
  ]);
}

/** Every record path → its text (DB rows or JSON files), and every other file under userData → its size. */
async function snapshot(pool: Pool | null): Promise<{ records: Record<string, string>; files: string[] }> {
  const root = appPaths.userData();
  const records: Record<string, string> = {};
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isDirectory()) walk(p);
      else if (recordFs.isRecordPath(rel)) records[rel] = fs.readFileSync(p, 'utf8');
      else files.push(rel + ' ' + fs.statSync(p).size);
    }
  };
  walk(root);
  if (pool) {
    if (Object.keys(records).length) records['!! record files on disk under the DB backend'] = Object.keys(records).join();
    // As the app reads them: the RLS org set, so this also holds for a non-superuser role.
    const c = await pool.connect();
    try {
      await c.query(`BEGIN; SELECT set_config('ordinate.org', '${ORG}', true)`);
      const r = await c.query('SELECT path, body FROM records WHERE org_id = $1', [ORG]);
      await c.query('COMMIT');
      for (const row of r.rows) records[row.path] = row.body;
    } finally {
      c.release();
    }
  }
  return { records, files: files.sort() };
}

(async () => {
  context.enterServerMode(dataDir);
  let pool: Pool | null = null;
  if (backend === 'pg') {
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    recordFs.useRecordDb(pool);
  }
  const who = { user: { email: 'diff@test', role: 'admin' as const }, org: { id: ORG } };
  const out = await context.runInContext(who, 'diff', async () => {
    await scenario();
    return snapshot(pool);
  });
  if (pool) await pool.end();
  const text = JSON.stringify({ steps, ...out }).split(dataDir).join('<DATA>');
  process.stdout.write(text + '\n');
  process.exit(0);
})().catch((err) => {
  process.stderr.write(String(err && (err as Error).stack) + '\n');
  process.exit(1);
});
