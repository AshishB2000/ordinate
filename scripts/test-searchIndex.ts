// ⌘K's name search: the index (0022_search_index.sql, src/server/searchIndex.ts) gives the SAME answer as
// reading every list (src/ipc/search.ts searchNames), field by field with Object.is, for an editor and a viewer.
//
// Always: the reference path ranks exact, then prefix, then contains, and searches names only.
// With DATABASE_URL (a scratch database it may CREATE DATABASE on):
//   1. THE DIFFERENTIAL: every query × {editor, viewer}, index === reference.
//   2. A viewer finds no draft dashboard name on the index path; an editor does (the control).
//   3. NO REBUILD when nothing changed (spies on the lists); after a save, only that source rebuilds.
//   4. A rename, a delete and an add are followed, the differential still holding.
//   5. NEGATIVE CONTROL: a row changed behind its stamp's back makes the differential FAIL; dropping its
//      source row heals it on the next search.
//   6. A failing index falls back to the reference through the handler, counted as `failed`.
//   7. A deleted project's rows go with it.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-searchIndex.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-searchindex-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(DATA);
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const caller: typeof import('../src/server/authz/caller') = require('../src/server/authz/caller');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const inOrg: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const alertStore: typeof import('../src/analysis/alertStore') = require('../src/analysis/alertStore');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const search: typeof import('../src/ipc/search') = require('../src/ipc/search');
const index: typeof import('../src/server/searchIndex') = require('../src/server/searchIndex');
const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');

type Identity = import('../src/server/context').Identity;
type Entry = Awaited<ReturnType<typeof search.searchNames>>[number];
const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const EDITOR: Identity = { user: { email: 'eve@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const QUERIES = ['sales', 'SALES', '  Sales ', 's', 'sale', 'board', 'canary', 'west', '›', 'zzz', '%', '_', "o'r", 'rows', 'chart'];

let req = 0;
const as = <T>(who: Identity, P: string | null, fn: () => Promise<T>): Promise<T> =>
  context.runInContext(who, `r${++req}`, async () => {
    if (P && who !== ADMIN) caller.seedRank(P, who === EDITOR ? 2 : 1); // what the RPC route seeds from `authorize`
    return fn();
  });

/** Both paths for one caller and query, the reference cut to the same 20. */
async function both(who: Identity, P: string, query: string): Promise<{ ref: Entry[]; idx: Entry[] | null }> {
  return as(who, P, async () => {
    const q = query.trim().toLowerCase();
    const sources = search.sourcesFor(await analysis.readsPublishedOnly(P));
    return { ref: (await search.searchNames(P, q, sources)).slice(0, 20), idx: await search.searchIndexed(P, q, sources, 20) };
  });
}

function same(a: readonly Entry[] | null, b: readonly Entry[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i] as unknown as Record<string, unknown>;
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    return [...keys].every((k) => Object.is((x as unknown as Record<string, unknown>)[k], y[k]));
  });
}

function handler(channel: string): (e: unknown, payload: unknown) => unknown {
  const h = rpc.handlers.get(channel);
  if (!h) throw new Error('no handler ' + channel);
  return h as (e: unknown, payload: unknown) => unknown;
}

const names = (es: readonly Entry[] | null) => (es ?? []).map((e) => e.name);
const resident = () => trace.snapshot()['search:names']?.resident ?? 0;
const failed = () => trace.snapshot()['search:names']?.failed ?? 0;

/** Count calls to two of the lists while `fn` runs. */
async function counting<T>(fn: () => Promise<T>): Promise<{ out: T; ds: number; vis: number }> {
  const [origDs, origVis] = [datasets.listDatasets, visuals.listVisuals];
  let ds = 0;
  let vis = 0;
  (datasets as { listDatasets: unknown }).listDatasets = (p: string) => { ds++; return origDs(p); };
  (visuals as { listVisuals: unknown }).listVisuals = (p: string) => { vis++; return origVis(p); };
  try {
    return { out: await fn(), ds, vis };
  } finally {
    (datasets as { listDatasets: unknown }).listDatasets = origDs;
    (visuals as { listVisuals: unknown }).listVisuals = origVis;
  }
}

async function world(): Promise<{ P: string; dsOld: string; E: string }> {
  return as(ADMIN, null, async () => {
    await projects.init();
    const P = (await projects.createProject('Search index')).id;
    const cols = [{ name: 'region', type: 'text' as const }, { name: 'amount', type: 'number' as const }];
    const save = async (name: string) => {
      const d = await datasets.saveDataset(P, { name, sourceKind: 'csv', columns: cols, rows: [['West', 1], ['East', 2]] });
      if (!d) throw new Error('seed ' + name);
      return d.id;
    };
    const [sales] = [await save('Sales'), await save('Sales 2024'), await save('Revenue')];
    const dsOld = await save('Old sales backup');
    await visuals.saveVisual(P, { name: 'Sales chart', datasetId: sales, chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } } as never);
    await metrics.saveMetric(P, { name: 'Sales total', datasetId: sales, definition: { column: 'amount', aggregation: 'sum' } });
    await alertStore.saveRule(P, { name: 'Sales drop', datasetId: sales, metric: { column: 'amount', aggregation: 'sum' }, compare: 'threshold', threshold: { op: '<', value: 1 }, enabled: true });
    await connections.saveConnection(P, { name: 'Sales DB', connectorId: 'postgres', values: { host: 'db.example.com', port: 5432, database: 'app', user: 'reader' } } as never);
    const call = async (channel: string, payload: unknown) => (await handler(channel)({}, payload)) as { id: string };
    await call('analysis:create', { projectId: P, name: 'Draftcanary sales plan' });
    const E = (await call('analysis:create', { projectId: P, name: 'Shown sales board' })).id;
    await call('analysis:view', { projectId: P, id: E, op: { op: 'create', name: 'West', state: {} } });
    await call('analysis:publish', { projectId: P, id: E });
    await call('analysis:update', { projectId: P, id: E, name: 'Editcanary sales board' });
    return { P, dsOld, E };
  });
}

async function pureLeg(): Promise<void> {
  const { P } = await world();
  const before = trace.snapshot()['search:names']?.skipped ?? 0;
  const { ref, idx } = await both(EDITOR, P, 'sales');
  ok('no DB: the index path is skipped (null), counted as skipped', idx === null && (trace.snapshot()['search:names']?.skipped ?? 0) > before);
  ok('ranking: the exact name first, then the prefixes, then the rest', names(ref).slice(0, 4).join(' | ') === 'Sales | Sales 2024 | Sales chart | Sales DB', names(ref));
  ok('ranking: a "contains" match comes after every prefix match', names(ref).indexOf('Old sales backup') > names(ref).indexOf('Sales drop'), names(ref));
  ok('names only: a detail line ("4 rows") is never searched', (await both(EDITOR, P, 'rows')).ref.length === 0);
  const viewer = await both(VIEWER, P, 'canary');
  ok('a viewer: no draft dashboard name (the published copy is "Shown sales board")', viewer.ref.length === 0 && names((await both(VIEWER, P, 'board')).ref).includes('Shown sales board'));
  ok('an editor: the drafts are found (the control)', names((await both(EDITOR, P, 'canary')).ref).length === 3);
}

async function dbLeg(pool: Pool): Promise<void> {
  const { P, dsOld, E } = await world();

  // ── 1 + 2. The differential, editor and viewer ─────────────────────────
  const r0 = resident();
  let unequal: string[] = [];
  for (const who of [EDITOR, VIEWER]) {
    for (const q of QUERIES) {
      const { ref, idx } = await both(who, P, q);
      if (!same(ref, idx)) unequal.push(`${who.user.email} "${q}": ${JSON.stringify(names(ref))} vs ${JSON.stringify(names(idx))}`);
    }
  }
  ok('differential: the index equals the reference for every query, editor and viewer', unequal.length === 0, unequal);
  ok('the index path answered each one (resident)', resident() - r0 === QUERIES.length * 2, resident() - r0);
  const sales = await both(EDITOR, P, 'sales');
  ok('the index ranks as the reference does: "Sales" first', sales.idx?.[0]?.name === 'Sales', names(sales.idx));
  ok('a viewer: no draft name from the index; the published copy and its view are there',
    (await both(VIEWER, P, 'canary')).idx?.length === 0 && names((await both(VIEWER, P, 'shown')).idx).join(' | ') === 'Shown sales board | Shown sales board › West');
  ok('an editor: both drafts and the view from the index (the control)', (await both(EDITOR, P, 'canary')).idx?.length === 3);

  // ── 3. No rebuild when nothing changed; one source after a save ────────
  const still = await counting(() => both(EDITOR, P, 'sales').then((b) => b.idx));
  // `both` runs the reference too: it lists once. The index path must add nothing.
  ok('nothing changed: the index lists nothing (only the reference read the lists)', still.ds === 1 && still.vis === 1, still);
  await as(ADMIN, null, () => datasets.saveDataset(P, { name: 'Salesforce export', sourceKind: 'csv', columns: [{ name: 'a', type: 'text' }], rows: [['x']] }));
  const after = await counting(() => as(EDITOR, P, async () => search.searchIndexed(P, 'sales', search.sourcesFor(false), 20)));
  ok('after a dataset save: the datasets source rebuilds, the visuals source does not', after.ds === 1 && after.vis === 0, after);
  ok('…and the new dataset is found', names(after.out).includes('Salesforce export'));

  // ── 4. Rename, delete, add: followed ───────────────────────────────────
  await as(ADMIN, null, async () => {
    await handler('analysis:update')({}, { projectId: P, id: E, name: 'Renamed sales board' });
    await datasets.deleteDataset(P, dsOld);
  });
  const moved = await both(EDITOR, P, 'sales');
  ok('a rename and a delete are followed by the index', names(moved.idx).includes('Renamed sales board') && !names(moved.idx).includes('Old sales backup') && !names(moved.idx).includes('Editcanary sales board'), names(moved.idx));
  ok('…and the differential still holds', same(moved.ref, moved.idx));
  const viewed = names((await both(VIEWER, P, 'board')).idx);
  ok('a viewer still gets the PUBLISHED name, not the renamed draft', viewed.includes('Shown sales board') && !viewed.some((n) => n.startsWith('Renamed')), viewed);

  // ── 5. NEGATIVE CONTROL: a row changed behind its stamp's back ─────────
  await pool.query(`UPDATE search_entries SET name = 'Sales tampered', name_lc = 'sales tampered' WHERE project_id = $1 AND name = 'Sales 2024'`, [P]);
  const tampered = await both(EDITOR, P, 'sales');
  ok('NEGATIVE CONTROL: a tampered row makes the differential fail (the comparison can see a difference)', !same(tampered.ref, tampered.idx) && names(tampered.idx).includes('Sales tampered'));
  await pool.query(`DELETE FROM search_sources WHERE project_id = $1 AND source = 'datasets'`, [P]);
  const healed = await both(EDITOR, P, 'sales');
  ok('…and dropping its source row rebuilds it on the next search', same(healed.ref, healed.idx));

  // ── 6. A failing index: the handler still answers, from the reference ──
  const realQuery = index.queryEntries;
  (index as { queryEntries: unknown }).queryEntries = async () => { throw Object.assign(new Error('boom'), { code: 'XX000' }); };
  const f0 = failed();
  try {
    const viaHandler = (await as(EDITOR, P, async () => (await handler('search:query')({}, { projectId: P, query: 'sales' })) as unknown)) as { ok: boolean; results: Array<{ name: string }> };
    ok('a failing index: the handler answers from the reference, the same names', viaHandler.ok === true && viaHandler.results.map((h) => h.name).join('|') === names(healed.ref).join('|'), viaHandler);
    ok('…counted as failed (the regression signal)', failed() === f0 + 1);
  } finally {
    (index as { queryEntries: unknown }).queryEntries = realQuery;
  }

  // ── 7. A deleted project's rows go with it ─────────────────────────────
  ok('the project has index rows', Number((await pool.query('SELECT count(*) FROM search_entries WHERE project_id = $1', [P])).rows[0].count) > 0);
  await as(ADMIN, null, () => projects.deleteProject(P));
  const left = await pool.query('SELECT (SELECT count(*) FROM search_entries WHERE project_id = $1) + (SELECT count(*) FROM search_sources WHERE project_id = $1) AS n', [P]);
  ok('a deleted project: no index rows left', Number(left.rows[0].n) === 0, left.rows[0]);
}

(async () => {
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  await pureLeg();

  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip the Postgres leg: DATABASE_URL is unset');
    return;
  }
  const dbName = `ordinate_searchindex_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: u.toString(), max: 10 });
  pool.on('error', () => undefined);
  try {
    await mig.migrate(pool);
    recordFs.useRecordDb(pool);
    inOrg.useOrgDb(pool);
    await dbLeg(pool);
  } finally {
    recordFs.useRecordDb(null);
    inOrg.useOrgDb(null);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((e) => ok('search index suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
