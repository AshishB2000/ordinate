// What each dashboard's published copy reads (docs/team-folders/00-design.md D9, D16; 0035_dashboard_reads.sql,
// src/analysis/publishedReads.ts, src/server/dashboardReads.ts): reach is exactly this set.
//
// 1. THE DESCRIBER vs THE DOORS (both modes): a corpus of dashboards — a chart, a KPI, a saved metric, a formula metric
//    naming one on another dataset, a chart labelled from a related dataset, a control, a statistics card, a metric
//    tree whose parts are on two datasets, text alone — each published; the copy's `reads`, as the describer reads it
//    from the stored record, is Object.is-equal (sorted, as JSON) to every dataset the doors touched rendering that copy
//    (a fan-out build's recorder, src/data/rowAccess fanOutScope). NEGATIVE CONTROL: the ids under the copy's own
//    dataset keys alone (no metric walk) miss the formula's operand, and the recorder says so.
// 2. A COPY PUBLISHED BEFORE `reads` (both modes): the describer says null (and for a Ready dashboard), and the
//    rebuild's `bodyReads` works it out Object.is-equal to what Publish recorded.
// 3. THE INDEX (with DATABASE_URL): its rows are the describer's for every dashboard, from the writes alone and after a
//    rebuild — ONE rebuild, however many ask at once; an older pod's write (no `ordinate.folders`) drops that
//    dashboard's rows and the project's marker, and the next question rebuilds them, a copy without `reads` worked out
//    without the record being written. NEGATIVE CONTROL: the same write with `ordinate.folders` on keeps the marker.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-dashboardReads.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-dashboardreads-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(DATA);
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const inOrg: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const relationships: typeof import('../src/analysis/relationships') = require('../src/analysis/relationships');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const drafts: typeof import('../src/analysis/publishDashboard') = require('../src/analysis/publishDashboard');
const copies: typeof import('../src/analysis/publishedCopy') = require('../src/analysis/publishedCopy');
const reads: typeof import('../src/analysis/publishedReads') = require('../src/analysis/publishedReads');
const rowAccess: typeof import('../src/data/rowAccess') = require('../src/data/rowAccess');
const dashboardData: typeof import('../src/publish/dashboardData') = require('../src/publish/dashboardData');
const index: typeof import('../src/server/dashboardReads') = require('../src/server/dashboardReads');
const figureDatasets: typeof import('../src/server/subscriptions/figureDatasets') = require('../src/server/subscriptions/figureDatasets');

type Identity = import('../src/server/context').Identity;
const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
let req = 0;
const as = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(ADMIN, `r${++req}`, fn);
const json = (xs: readonly string[]): string => JSON.stringify([...xs].map((x) => x.toLowerCase()).sort());
const must = <T>(what: string, v: T | null | undefined): T => {
  if (!v) throw new Error(`setup: ${what}`);
  return v;
};

interface Corpus { P: string; boards: Record<string, string>; ids: Record<string, string> }

/** The corpus, published as an admin: one dashboard per shape. */
async function corpus(): Promise<Corpus> {
  return as(async () => {
    const P = (await projects.createProject('Reach')).id;
    const save = async (name: string, columns: Array<{ name: string; type: 'text' | 'number' | 'date' }>, rows: unknown[][]) =>
      must(name, await datasets.saveDataset(P, { name, sourceKind: 'csv', columns, rows: rows as never })).id;
    const A = await save('Orders', [{ name: 'dept', type: 'text' }, { name: 'salary', type: 'number' }, { name: 'day', type: 'date' }], Array.from({ length: 12 }, (_, i) => [`d${i % 3}`, i * 7, `2024-0${1 + (i % 6)}-10`]));
    const B = await save('Targets', [{ name: 'dept', type: 'text' }, { name: 'goal', type: 'number' }], [['d0', 5], ['d1', 6], ['d2', 7]]);
    const Dim = await save('Departments', [{ name: 'dept', type: 'text' }, { name: 'label', type: 'text' }], [['d0', 'Zero'], ['d1', 'One'], ['d2', 'Two']]);
    const C = await save('Regions', [{ name: 'dept', type: 'text' }, { name: 'region', type: 'text' }], [['d0', 'North'], ['d1', 'South']]);
    must('relationship', await relationships.saveRelationship(P, { from: { datasetId: A, column: 'dept' }, to: { datasetId: Dim, column: 'dept' }, cardinality: 'many_to_one' }));
    const enc = { category: 'dept', values: [{ column: 'salary', aggregation: 'sum' }] };
    const vA = must('chart', await visuals.saveVisual(P, { name: 'By dept', datasetId: A, chartType: 'bar', encoding: enc })).id;
    const vRel = must('related chart', await visuals.saveVisual(P, { name: 'By label', datasetId: A, chartType: 'bar', encoding: { category: 'label', categoryDatasetId: Dim, values: [{ column: 'salary', aggregation: 'sum' }] } })).id;
    const mA = must('metric', await metrics.saveMetric(P, { name: 'A total', datasetId: A, definition: { column: 'salary', aggregation: 'sum' } })).id;
    const mB = must('B metric', await metrics.saveMetric(P, { name: 'B total', datasetId: B, definition: { column: 'goal', aggregation: 'sum' } })).id;
    const mF = must('formula', await metrics.saveMetric(P, { name: 'Goal plus', datasetId: B, definition: { formula: 'sum(goal) + [A total]' } })).id;
    const mT = must('tree metric', await metrics.saveMetric(P, { name: 'Both totals', datasetId: A, definition: { formula: '[A total] + [B total]' } })).id;
    must('tree', await metrics.updateMetric(P, mT, { tree: { metricId: mT, relation: 'sum', children: [{ metricId: mA }, { metricId: mB }] } }));
    const card = (n: number, extra: object) => ({ id: `0000000${n}-0000-4000-8000-000000000000`.slice(-36), layout: { x: 0, y: 0, w: 6, h: 4 }, ...extra });
    const kpi = (ds: string, column: string, metricId?: string) => ({ type: 'metric', metric: { datasetId: ds, column, aggregation: 'sum', ...(metricId ? { metricId } : {}) } });
    const shapes: Record<string, object[]> = {
      chart: [{ type: 'visual', visualId: vA }],
      kpi: [kpi(A, 'salary')],
      saved: [kpi(A, 'salary', mA)],
      formula: [kpi(B, 'goal', mF)],
      related: [{ type: 'visual', visualId: vRel }],
      control: [{ type: 'control', control: { kind: 'dropdown', label: 'Dept', datasetId: C, column: 'dept' } }, { type: 'visual', visualId: vA }],
      stats: [{ type: 'stats', stats: { kind: 'distribution', datasetId: A, columns: ['salary'] } }],
      tree: [{ type: 'metricTree', metricTree: { metricId: mT } }],
      text: [{ type: 'text', heading: 'Notes', text: 'Nothing to read.' }],
    };
    const boards: Record<string, string> = {};
    for (const [name, cards] of Object.entries(shapes)) {
      const a = must(name, await analysis.saveAnalysis(P, { name, sheets: [{ name: 'One', cards: cards.map((c, i) => card(i + 1, c)) }] }));
      must(`publish ${name}`, await drafts.publish(P, a.id));
      boards[name] = a.id;
    }
    return { P, boards, ids: { A, B, Dim, C } };
  });
}

/** The stored record of dashboard `id`. */
const bodyOf = (P: string, id: string): Promise<string> => as(() => recordFs.readFile(path.join(appPaths.userData(), 'projects', P, 'analyses', `${id}.json`), 'utf8'));
/** Every dataset the doors touch rendering the copy: a fan-out build's recorder. */
const touched = (P: string, id: string): Promise<string[]> => as(async () => (await rowAccess.fanOutScope(() => dashboardData.buildDashboard(P, id, 8, {}, undefined, { defaultOnly: true }))).datasets);

async function describerLeg(c: Corpus, mode: string): Promise<void> {
  const differ: string[] = [];
  for (const [name, id] of Object.entries(c.boards)) {
    const described = copies.copyReadsOf(await bodyOf(c.P, id));
    const doors = await touched(c.P, id);
    if (described === null || json(described) !== json(doors)) differ.push(`${name}: reads ${JSON.stringify(described)} | doors ${json(doors)}`);
  }
  ok(`${mode}: for each of ${Object.keys(c.boards).length} dashboard shapes, the copy's reads (as the describer reads them) are what the doors touched rendering it`, differ.length === 0, differ.join('\n'));
  const expect: Record<string, string[]> = { formula: [c.ids.A, c.ids.B], related: [c.ids.A, c.ids.Dim], control: [c.ids.A, c.ids.C], tree: [c.ids.A, c.ids.B], text: [] };
  const named: string[] = [];
  for (const [name, ds] of Object.entries(expect)) {
    const got = copies.copyReadsOf(await bodyOf(c.P, c.boards[name]));
    if (json(got ?? ['null']) !== json(ds)) named.push(`${name}: ${JSON.stringify(got)}`);
  }
  ok(`${mode}: an operand's, a related dimension's, a control's and a tree part's datasets are in reads; text reads none`, named.length === 0, named.join('\n'));
  const own = async (name: string): Promise<string> => {
    const copy = must('copy', copies.sanitizePublished(JSON.parse(await bodyOf(c.P, c.boards[name])).published, () => 'x'));
    const found = { all: new Set<string>(), datasets: new Set<string>(), visuals: new Set<string>() };
    figureDatasets.collectIds({ sheets: copy.sheets, filters: copy.filters }, found);
    return json([...found.datasets]);
  };
  ok(`NEGATIVE CONTROL (${mode}): the formula's own dataset keys alone miss its operand's dataset, which the doors touch`, (await own('formula')) !== json(await touched(c.P, c.boards.formula)));

  // 2. A copy published before `reads`.
  const legacy: string[] = [];
  for (const [name, id] of Object.entries(c.boards)) {
    const body = JSON.parse(await bodyOf(c.P, id));
    const { reads: recorded, ...rest } = body.published;
    const old = JSON.stringify({ ...body, published: rest });
    const worked = await as(() => reads.bodyReads(c.P, old));
    if (copies.copyReadsOf(old) !== null || json(worked) !== json(recorded)) legacy.push(`${name}: ${json(worked)} | ${json(recorded)}`);
  }
  ok(`${mode}: a copy published before reads is described as null, and the rebuild works out what Publish recorded`, legacy.length === 0, legacy.join('\n'));
  ok(`${mode}: a Ready dashboard (before drafts) is described as null too; a draft never published reads nothing`, copies.copyReadsOf(JSON.stringify({ id: 'x', ready: true })) === null && json(copies.copyReadsOf(JSON.stringify({ id: 'x' })) ?? ['null']) === '[]');
}

async function indexLeg(pool: Pool): Promise<void> {
  const c = await corpus();
  await describerLeg(c, 'Postgres');
  const rowsOf = async (): Promise<string> => JSON.stringify((await pool.query<{ a: string; d: string }>('SELECT analysis_id AS a, dataset_id AS d FROM dashboard_reads WHERE org_id = $1 AND project_id = $2 ORDER BY 1, 2', ['acme', c.P])).rows.map((r) => `${r.a}:${r.d}`));
  const expected = async (): Promise<string> => {
    const out: string[] = [];
    for (const id of Object.values(c.boards)) for (const d of copies.copyReadsOf(await bodyOf(c.P, id)) ?? []) out.push(`${id.toLowerCase()}:${d}`);
    return JSON.stringify(out.sort());
  };
  const want = await expected();
  ok('index: from the writes alone, its rows are the describer\'s for every dashboard', (await rowsOf()) === want, `${await rowsOf()} | ${want}`);
  const marker = async (): Promise<number> => Number((await pool.query('SELECT count(*) AS n FROM dashboard_reads_built WHERE org_id = $1 AND project_id = $2', ['acme', c.P])).rows[0].n);
  const ask = () => as(() => index.readersOf(c.P, [c.ids.A.toLowerCase()], recordFs.rowsUnder));
  const before = index.rebuildCount();
  await Promise.all([ask(), ask(), ask()]);
  ok('index: three questions at once on an unbuilt project rebuild it ONCE, to the same rows', index.rebuildCount() - before === 1 && (await marker()) === 1 && (await rowsOf()) === want, `${index.rebuildCount() - before} rebuilds`);
  const answer = await ask();
  ok('index: Orders is read by dashboards in one folder, Everyone (the project id), and asking again rebuilt nothing', JSON.stringify(answer.get(c.ids.A.toLowerCase())) === JSON.stringify([c.P.toLowerCase()]) && index.rebuildCount() - before === 1, JSON.stringify([...answer]));

  // An older pod's writes: one dashboard re-saved as it is, and the formula board's copy published without `reads`.
  const rel = (id: string) => `projects/${c.P}/analyses/${id}.json`;
  await pool.query('UPDATE records SET body = body WHERE org_id = $1 AND path = $2', ['acme', rel(c.boards.chart)]);
  const formula = JSON.parse(await bodyOf(c.P, c.boards.formula));
  const { reads: _recorded, ...older } = formula.published;
  const olderBody = JSON.stringify({ ...formula, published: older });
  await pool.query('UPDATE records SET body = $1 WHERE org_id = $2 AND path = $3', [olderBody, 'acme', rel(c.boards.formula)]);
  const gone = JSON.parse(await rowsOf()) as string[];
  ok('trigger: an older pod\'s writes drop those dashboards\' rows and the project\'s marker', (await marker()) === 0 && !gone.some((r) => r.startsWith(c.boards.chart.toLowerCase()) || r.startsWith(c.boards.formula.toLowerCase())), JSON.stringify(gone));
  const rebuilt = index.rebuildCount();
  await ask();
  ok('trigger: the next question rebuilds once, the copy without reads worked out — the rows are as before', index.rebuildCount() - rebuilt === 1 && (await rowsOf()) === want && (await marker()) === 1, `${await rowsOf()} | ${want}`);
  ok('trigger: the rebuild did not write the record (its copy still has no reads)', (await bodyOf(c.P, c.boards.formula)) === olderBody);
  const kept = await pool.connect();
  try {
    await kept.query("BEGIN; SELECT set_config('ordinate.org', 'acme', true), set_config('ordinate.folders', 'on', true)");
    await kept.query('UPDATE records SET body = body WHERE org_id = $1 AND path = $2', ['acme', rel(c.boards.kpi)]);
    await kept.query('COMMIT');
  } finally {
    kept.release();
  }
  ok('NEGATIVE CONTROL: a write that says it keeps the index (`ordinate.folders` on) leaves the marker', (await marker()) === 1);

  // Through the store: unpublishing empties a dashboard's rows, republishing fills them; deleting the project leaves none.
  await as(() => drafts.unpublish(c.P, c.boards.kpi));
  const unpublished = JSON.parse(await rowsOf()) as string[];
  ok('on write: an unpublished dashboard has no rows, and the marker stays', !unpublished.some((r) => r.startsWith(c.boards.kpi.toLowerCase())) && (await marker()) === 1);
  await as(() => drafts.publish(c.P, c.boards.kpi));
  ok('on write: republished, its rows are back with no rebuild', (await rowsOf()) === want && index.rebuildCount() - rebuilt === 1, `${await rowsOf()} | ${want}`);
  await as(() => projects.deleteProject(c.P));
  ok('a deleted project leaves no rows and no marker', (await rowsOf()) === '[]' && (await marker()) === 0);
}

(async () => {
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  await describerLeg(await corpus(), 'files');
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip the Postgres leg: DATABASE_URL is unset');
    return;
  }
  const dbName = `ordinate_dashboardreads_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: u.toString(), max: 10 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  try {
    await mig.migrate(pool);
    recordFs.useRecordDb(pool);
    inOrg.useOrgDb(pool);
    await indexLeg(pool);
  } finally {
    recordFs.useRecordDb(null);
    inOrg.useOrgDb(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((e) => ok('dashboard reads suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
