// A store's list reads its records a page at a time (recordFs.listRecords), not one transaction per record — and gets
// exactly the list the per-record loop got.
//
// Always (record files, no DATABASE_URL): a project with a record in every listed store, plus in each store's folder
// a corrupt record, a stray file, a stray `.json`, a tmp file, a `.json.corrupt` companion and a misnamed copy; 250
// cloned datasets, four 5 MiB v2-style datasets (rows inline), a dataset past its byte cap, a metric past the value
// budget. Every list holds its seeded records and none of the unreadable ones, and logs what it skipped; listRecords
// gives readdir's `.json` names in its order, each with readFile's text or its error.
// With DATABASE_URL (a scratch database it may CREATE DATABASE on), the same files copied into `records`:
//   1. THE DIFFERENTIAL: every store's list, batched, === the per-record path (recordFs._listPerRecord), field for
//      field with Object.is, and logs the same skips. NEGATIVE CONTROL: a changed record makes it differ.
//   2. ROUND TRIPS: listDatasets over ~260 records is a handful of statements (pages); exactly two pages for three
//      5 MiB records (the byte cap). NEGATIVE CONTROL: the per-record path is three statements a record.
//   3. MEMO: inside withReadMemo a second list, and a readFile of a listed record, make no query; a write in
//      between is seen by the next list.
//   4. Inside `locked` the list reads on the hold's transaction and is the same list.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-recordListBatch.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-recordlists-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(DATA);
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
const loggerMod: typeof import('../src/app/logger') = require('../src/app/logger');
const inOrg: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const topics: typeof import('../src/analysis/topics') = require('../src/analysis/topics');
const agents: typeof import('../src/ai/agents') = require('../src/ai/agents');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const verified: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const reports: typeof import('../src/analysis/reportSpec') = require('../src/analysis/reportSpec');
const subscriptions: typeof import('../src/analysis/subscriptions') = require('../src/analysis/subscriptions');
const scorecards: typeof import('../src/analysis/scorecards') = require('../src/analysis/scorecards');
const stories: typeof import('../src/analysis/stories') = require('../src/analysis/stories');
const channels: typeof import('../src/app/channels') = require('../src/app/channels');
const scenarios: typeof import('../src/analysis/scenarios') = require('../src/analysis/scenarios');
const notebooks: typeof import('../src/analysis/notebook/store') = require('../src/analysis/notebook/store');
const boundaries: typeof import('../src/app/projectBoundaries') = require('../src/app/projectBoundaries');
const trashStore: typeof import('../src/app/trashStore') = require('../src/app/trashStore');

type Identity = import('../src/server/context').Identity;
const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
let req = 0;
const as = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(ADMIN, `r${++req}`, fn);
const MIB = 1024 * 1024;

/** Deep equality, every leaf compared with Object.is and keys in the same order. */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const kx = Object.keys(x);
  const ky = Object.keys(y);
  return kx.length === ky.length && kx.every((k, i) => k === ky[i] && same(x[k], y[k]));
}

// Error lines (the stores' "Skipping corrupt or unreadable …"): what a list logged.
const errors: string[] = [];
const sink: import('../src/app/logger').LogSink = {
  debug: () => undefined, info: () => undefined, warn: () => undefined,
  error: (_o, msg) => { errors.push(msg); },
  child: () => sink,
};
loggerMod.useLogger(sink);
const logged = async <T>(fn: () => Promise<T>): Promise<[T, string[]]> => {
  const from = errors.length;
  const out = await fn();
  return [out, errors.slice(from)];
};

// ── the world ─────────────────────────────────────────────────────────────
interface World { P: string; ds: string; dirs: string[]; unreadable: string[]; overCap: string; overflow: string }
const uuid = (): string => crypto.randomUUID();
const write = (file: string, text: string): void => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

async function seed(): Promise<World> {
  const { P, ds, metricId } = await as(async () => {
    await projects.init();
    const P = (await projects.createProject('Record lists')).id;
    const d = await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }], rows: [['West', 1], ['East', 2]] });
    if (!d) throw new Error('seed dataset');
    const m = await metrics.saveMetric(P, { name: 'Revenue', datasetId: d.id, definition: { column: 'amount', aggregation: 'sum' } });
    const a = await analysis.saveAnalysis(P, { name: 'Board' });
    const now = new Date().toISOString();
    const seeded: Array<[string, unknown]> = [
      ['metric', m],
      ['analysis', a],
      ['term', await terms.saveTerm(P, { name: 'West', datasetId: d.id, filters: [{ column: 'region', op: 'eq', value: 'West' }] })],
      ['topic', await topics.saveTopic(P, { name: 'Sales', datasets: [d.id] })],
      ['agent', await agents.saveAgent(P, { name: 'Analyst' })],
      ['visual', await visuals.saveVisual(P, { name: 'Sales chart', datasetId: d.id, chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } } as never)],
      ['verified', await verified.writeVerified(P, {
        id: uuid(), projectId: P, question: 'Revenue by region', phrasings: [], verifiedBy: 'ana@acme.test', verifiedAt: now, createdAt: now, updatedAt: now, schemaVersion: 1,
        spec: { datasetId: d.id, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: '' },
      })],
      ['connection', await connections.saveConnection(P, { name: 'Sales DB', connectorId: 'postgres', values: { host: 'db.example.com', port: 5432, database: 'app', user: 'reader' } } as never)],
      ['report', a && (await reports.saveReport(P, { name: 'Weekly', analysisId: a.id }))],
      ['subscription', a && (await subscriptions.createSubscription(P, { name: 'Weekly mail', analysisId: a.id }, 'ana@acme.test'))],
      ['scorecard', await scorecards.saveScorecard(P, { name: 'KPIs' })],
      ['story', await stories.saveStory(P, { name: 'Story', blocks: [] })],
      ['scenario', await scenarios.saveScenario(P, { name: 'What if' })],
      ['notebook', await notebooks.createNotebook(P, { name: 'Notes' })],
      ['boundary', await boundaries.importBoundaryText(P, 'Regions', JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'West' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }] }))],
      ['trash', m && (await trashStore.stash(P, 'metric', m.id, { ...m }))],
    ];
    for (const [kind, got] of seeded) if (!got || (typeof got === 'object' && 'error' in got)) throw new Error('seed ' + kind + ': ' + JSON.stringify(got));
    const ch = uuid();
    write(path.join(appPaths.userData(), 'channels', ch + '.json'), JSON.stringify({ id: ch, name: 'Ops mail', kind: 'email', to: ['ops@acme.test'], createdBy: 'ana@acme.test', createdAt: now, updatedAt: now }));
    return { P, ds: d.id, metricId: (m as { id: string }).id };
  });
  const root = await as(async () => appPaths.userData());
  // Every folder holding a `<uuid>.json` record: the stores' (and the trash's) folders.
  const dirs: string[] = [];
  const walk = (dir: string): void => {
    const ents = fs.readdirSync(dir, { withFileTypes: true });
    if (ents.some((e) => e.isFile() && /^[0-9a-f-]{36}\.json$/.test(e.name))) dirs.push(dir);
    for (const e of ents) if (e.isDirectory()) walk(path.join(dir, e.name));
  };
  walk(root);
  const unreadable: string[] = [];
  for (const dir of dirs) {
    const first = fs.readdirSync(dir).find((n) => /^[0-9a-f-]{36}\.json$/.test(n)) as string;
    const body = fs.readFileSync(path.join(dir, first), 'utf8');
    const bad = uuid();
    unreadable.push(bad);
    write(path.join(dir, bad + '.json'), '{ "id": "' + bad + '", not json');
    write(path.join(dir, 'notes.txt'), 'a stray file');
    write(path.join(dir, 'README.json'), '{"stray": true}');
    write(path.join(dir, first + '.' + uuid() + '.tmp'), body);
    write(path.join(dir, first + '.corrupt'), body);
    write(path.join(dir, uuid() + '.json'), body); // misnamed: its id is `first`'s
  }
  const dsDir = path.join(root, 'projects', P, 'datasets');
  const metricsDir = path.join(root, 'projects', P, 'metrics');
  const dsBody = fs.readFileSync(path.join(dsDir, ds + '.json'), 'utf8');
  const clone = (dir: string, body: string, id: string, n: number): void => {
    for (let i = 0; i < n; i++) { const c = uuid(); write(path.join(dir, c + '.json'), body.split(id).join(c)); }
  };
  clone(dsDir, dsBody, ds, 250);
  clone(metricsDir, fs.readFileSync(path.join(metricsDir, metricId + '.json'), 'utf8'), metricId, 120);
  // v2-style datasets: the rows inline, 5 MiB each — two fill a page's 8 MiB.
  const rows = Array.from({ length: Math.ceil((5 * MIB) / 112) }, (_, i) => ['W'.repeat(100), i]);
  for (let i = 0; i < 4; i++) { const c = uuid(); write(path.join(dsDir, c + '.json'), JSON.stringify({ ...JSON.parse(dsBody.split(ds).join(c)), rows })); }
  const overCap = uuid();
  write(path.join(dsDir, overCap + '.json'), JSON.stringify({ id: overCap, pad: 'x'.repeat(9 * MIB) })); // past the 8 MiB cap
  const overflow = uuid();
  write(path.join(metricsDir, overflow + '.json'), JSON.stringify({ id: overflow, v: new Array(1_100_000).fill(0) })); // 2.2 MB, past the value budget
  write(path.join(dsDir, ds + '.search.json'), '{"disk":true}'); // not a record: it stays on disk, beside the rows
  for (let i = 0; i < 3; i++) write(path.join(root, 'projects', P, 'bigpages', uuid() + '.json'), JSON.stringify({ pad: 'y'.repeat(5 * MIB) }));
  return { P, ds, dirs, unreadable: [...unreadable, overCap, overflow], overCap, overflow };
}

const lists = (P: string): Array<[string, () => Promise<unknown[]>]> => [
  ['listDatasets', () => datasets.listDatasets(P)],
  ['listMetrics', () => metrics.listMetrics(P)],
  ['listFullTerms', () => terms.listFullTerms(P)],
  ['listTopics', () => topics.listTopics(P)],
  ['listAgents', () => agents.listAgents(P)],
  ['listVisuals', () => visuals.listVisuals(P)],
  ['listAnalyses', () => analysis.listAnalyses(P)],
  ['verified listTagged', () => verified.listTagged(P)],
  ['listConnections', () => connections.listConnections(P)],
  ['reports readAll', () => reports.readAll(P)],
  ['listSubscriptions', () => subscriptions.listSubscriptions(P)],
  ['listScorecards', () => scorecards.listScorecards(P)],
  ['listStories', () => stories.listStories(P)],
  ['listChannels', () => channels.listChannels()],
  ['listScenarios', () => scenarios.listScenarios(P)],
  ['listNotebooks', () => notebooks.listNotebooks(P)],
  ['listBoundaries', () => boundaries.listBoundaries(P)],
  ['trash listEntries', () => trashStore.listEntries(P)],
];

/** A listing drained: each name with its text, or the code it threw. */
async function drain(dir: string): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for await (const r of await recordFs.listRecords(dir)) {
    try { out.push([r.name, r.text()]); } catch (e) { out.push([r.name, 'THREW ' + String((e as { code?: string }).code)]); }
  }
  return out;
}

// ── always: record files ─────────────────────────────────────────────────
async function fileLeg(w: World): Promise<void> {
  for (const [name, list] of lists(w.P)) {
    const [got, lines] = await as(() => logged(list));
    const text = JSON.stringify(got);
    ok(`files: ${name} holds its records`, got.length > 0, text.slice(0, 200));
    ok(`files: ${name} holds no unreadable record`, w.unreadable.every((id) => !text.includes(id)));
    if (name === 'listDatasets') ok('files: listDatasets logs the dataset past its cap and the corrupt one', lines.some((l) => l.includes(w.overCap)) && lines.some((l) => w.unreadable.some((id) => l.includes(id) && id !== w.overCap)), lines.join('\n'));
    if (name === 'listMetrics') ok('files: listMetrics logs the metric past the value budget', lines.some((l) => l.includes(w.overflow)), lines.join('\n'));
  }
  const dir = await as(async () => path.join(appPaths.userData(), 'projects', w.P, 'datasets'));
  const listing = await as(() => drain(dir));
  const want = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.json')).map((d) => d.name);
  ok('files: listRecords gives readdir\'s .json files, in its order', same(listing.map(([n]) => n), want));
  ok('files: each with its text, or the error readFile throws',
    listing.every(([n, t]) => (n === w.overCap + '.json' ? t === 'THREW ERECORDTOOLARGE' : t === fs.readFileSync(path.join(dir, n), 'utf8'))));
  ok('files: the .search.json beside them is listed too (as readdir lists it)', listing.some(([n, t]) => n === w.ds + '.search.json' && t === '{"disk":true}'));
  const missing = await as(() => recordFs.listRecords(path.join(dir, 'nope')).then(() => 'listed', (e: { code?: string }) => String(e.code)));
  ok('files: a missing folder throws ENOENT, as readdir does', missing === 'ENOENT');
}

// ── with Postgres ──────────────────────────────────────────────────────────
let queries = 0;
function countQueries(): void {
  const proto = Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const real = proto.query;
  proto.query = function (this: unknown, ...args: unknown[]): unknown { queries++; return real.apply(this, args); };
}
const counted = async <T>(fn: () => Promise<T>): Promise<[number, T]> => {
  const from = queries;
  const out = await fn();
  return [queries - from, out];
};
const perRecord = async <T>(fn: () => Promise<T>): Promise<T> => {
  recordFs._listPerRecord(true);
  try { return await fn(); } finally { recordFs._listPerRecord(false); }
};

async function copyIntoRecords(pool: Pool): Promise<number> {
  const root = await as(async () => appPaths.userData());
  const rels: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { const rel = path.relative(root, p).split(path.sep).join('/'); if (recordFs.isRecordPath(rel)) rels.push(rel); }
    }
  };
  walk(root);
  for (const rel of rels) {
    await pool.query('INSERT INTO records (org_id, path, body) VALUES ($1, $2, $3)', ['acme', rel, fs.readFileSync(path.join(root, rel), 'utf8')]);
  }
  return rels.length;
}

async function dbLeg(pool: Pool, w: World): Promise<void> {
  ok('the record files are rows now', (await copyIntoRecords(pool)) > 400);
  recordFs.useRecordDb(pool);
  countQueries();

  // 1. THE DIFFERENTIAL
  let reference: unknown[] = [];
  for (const [name, list] of lists(w.P)) {
    const [ref, refLines] = await as(() => perRecord(() => logged(list)));
    const [got, lines] = await as(() => logged(list));
    ok(`db: ${name} batched === per record (${ref.length} items)`, ref.length > 0 && same(got, ref), JSON.stringify(got).slice(0, 300));
    const logs = name === 'listDatasets' ? lines.some((l) => l.includes(w.overCap)) : name === 'listMetrics' ? lines.some((l) => l.includes(w.overflow)) : true;
    ok(`db: ${name} logs the same skips`, logs && same(lines, refLines), lines.join('\n') + '\n--\n' + refLines.join('\n'));
    if (name === 'listMetrics') reference = ref;
  }
  const dir = await as(async () => path.join(appPaths.userData(), 'projects', w.P, 'datasets'));
  const [refListing, listing] = [await as(() => perRecord(() => drain(dir))), await as(() => drain(dir))];
  ok('db: listRecords — the same names, texts and errors as one readFile each', listing.length > 250 && same(listing, refListing));
  // A file that is no record (the .search.json beside a table) is listed when readdir lists it, and reads exactly as
  // readFile reads it: where it lives (local disk, or the storage CI's S3 pass routes it to) is readFile's business.
  const searchName = w.ds + '.search.json';
  const onDisk = (await as(() => recordFs.readdir(dir))).includes(searchName);
  const searchListed = listing.find(([n]) => n === searchName);
  const direct = await as(() => recordFs.readFile(path.join(dir, searchName), 'utf8').then((t) => t, (e: NodeJS.ErrnoException) => 'THREW ' + String(e.code)));
  ok('db: the .search.json beside the rows is listed as readdir lists it, read as readFile reads it',
    onDisk ? searchListed !== undefined && searchListed[1] === direct : searchListed === undefined, `readdir lists it: ${onDisk}; readFile: ${direct}; listed: ${searchListed?.[1]}`);
  const metricRow = `projects/${w.P}/metrics/${(reference[0] as { id: string }).id}.json`;
  await pool.query("UPDATE records SET body = replace(body, '\"Revenue\"', '\"Revenue changed\"') WHERE org_id = 'acme' AND path = $1", [metricRow]);
  ok('NEGATIVE CONTROL: a changed record makes the lists differ', !same(await as(() => metrics.listMetrics(w.P)), reference));

  // 2. ROUND TRIPS
  const [batched, a] = await counted(() => as(() => datasets.listDatasets(w.P)));
  const [each, b] = await counted(() => as(() => perRecord(() => datasets.listDatasets(w.P))));
  ok(`db: listDatasets over ${a.length} datasets is ${batched} statements: a handful of pages`, batched <= 3 * (1 + 12) && same(a, b), String(batched));
  ok(`NEGATIVE CONTROL: one transaction a record is ${each} statements`, each >= 3 * 255, String(each));
  const big = await as(async () => path.join(appPaths.userData(), 'projects', w.P, 'bigpages'));
  const [bigQ, bigListing] = await counted(() => as(() => drain(big)));
  ok('db: three 5 MiB records are two pages (readdir + 2 × BEGIN, SELECT, COMMIT)', bigQ === 9 && bigListing.length === 3 && bigListing.every(([, t]) => t.length > 5 * MIB), String(bigQ));

  // 3. MEMO
  await as(() => recordFs.withReadMemo(async () => {
    const [q1, first] = await counted(() => datasets.listDatasets(w.P));
    const [q2, second] = await counted(() => datasets.listDatasets(w.P));
    ok(`memo: the second list makes no query (first ${q1})`, q1 > 0 && q2 === 0 && same(first, second), String(q2));
    const file = path.join(dir, w.ds + '.json');
    const [q3, body] = await counted(() => recordFs.readFile(file, 'utf8'));
    ok('memo: a listed record is a memo hit for readFile', q3 === 0 && body.length > 0, String(q3));
    await recordFs.writeFile(file, JSON.stringify({ ...JSON.parse(body), name: 'Orders renamed' }, null, 2));
    const [q4, third] = await counted(() => datasets.listDatasets(w.P));
    ok('memo: after a write the list reads again and sees it', q4 > 0 && third.some((d) => d.id === w.ds && d.name === 'Orders renamed'));
    await recordFs.writeFile(file, body);
  }));
  const [o1] = await counted(() => as(() => datasets.listDatasets(w.P)));
  ok('NEGATIVE CONTROL: outside the memo every list queries', o1 > 0);

  // 4. LOCKED
  const plain = await as(() => datasets.listDatasets(w.P));
  const held = await as(() => recordFs.locked(path.join(dir, w.ds + '.json'), () => datasets.listDatasets(w.P)));
  ok('locked: the same list, read on the hold', same(held, plain));
}

(async () => {
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  const w = await seed();
  await fileLeg(w);

  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip the Postgres leg: DATABASE_URL is unset');
    return;
  }
  const dbName = `ordinate_recordlists_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: u.toString(), max: 10 });
  pool.on('error', () => undefined);
  try {
    await mig.migrate(pool);
    inOrg.useOrgDb(pool);
    await dbLeg(pool, w);
  } finally {
    recordFs.useRecordDb(null);
    inOrg.useOrgDb(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((e) => ok('record list suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    loggerMod.useLogger(null);
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
