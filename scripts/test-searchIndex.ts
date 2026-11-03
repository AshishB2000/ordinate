// ⌘K's name search: the index (0022_search_index.sql, src/server/searchIndex.ts, kept current by every
// write in recordFs) gives the SAME answer as reading every list (src/ipc/search.ts searchNames), field by
// field with Object.is, for an editor and for a viewer.
//
// Always: the matching rules (src/app/searchMatch.ts) and the reference path — word prefixes, ranking,
// names only, a viewer never finding a draft.
// With DATABASE_URL (a scratch database it may CREATE DATABASE on):
//   1. THE DIFFERENTIAL: every query × {editor, viewer}, index === reference.
//   2. A viewer finds no draft name on the index path; an editor does (the control).
//   3. ON WRITE: once built, a search rebuilds nothing and reads no list; a save, a rename and a delete
//      are found by the very next search with still no rebuild — the write updated the index itself.
//   4. A save never fails for the index: a describer that throws, or none at all, drops the marker, the
//      save goes through, and the next search rebuilds that source and finds it.
//   4b. A NUL in a detail line is stored cleaned; a record past its limits never ends a rebuild early; a page is
//      cut by bytes; a failed index write keeps its shared lock until its transaction ends.
//   5. NEGATIVE CONTROL: a row changed behind the index's back makes the differential FAIL.
//   6. A failing index query falls back to the reference through the handler, counted as `failed`.
//   7. A deleted project leaves no rows and no markers.
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
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');
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
const match: typeof import('../src/app/searchMatch') = require('../src/app/searchMatch');
const trace: typeof import('../src/engine/residentTrace') = require('../src/engine/residentTrace');

type Identity = import('../src/server/context').Identity;
type Found = import('../src/ipc/search').Found;
const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const EDITOR: Identity = { user: { email: 'eve@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
const QUERIES = ['sales', 'SALES', '  Sales ', 's', 'sal', 'ales', 'west sales', 'sales west', 'board', 'canary', 'inv-20', '2041',
  'west', '›', 'zzz', '%', '_', "o'r", 'rows', 'chart', 'sales 20'];

let req = 0;
const as = <T>(who: Identity, P: string | null, fn: () => Promise<T>): Promise<T> =>
  context.runInContext(who, `r${++req}`, async () => {
    if (P && who !== ADMIN) caller.seedRank(P, who === EDITOR ? 2 : 1); // what the RPC route seeds from `authorize`
    return fn();
  });

function handler(channel: string): (e: unknown, payload: unknown) => Promise<unknown> {
  const h = rpc.handlers.get(channel);
  if (!h) throw new Error('no handler ' + channel);
  return async (e, payload) => h(e, payload) as unknown;
}

/** Both paths for one caller and query, the reference cut to the same 20. */
async function both(who: Identity, P: string, query: string): Promise<{ ref: Found[]; idx: Found[] | null }> {
  return as(who, P, async () => {
    const viewer = await analysis.readsPublishedOnly(P);
    return { ref: (await search.searchNames(P, query)).slice(0, 20), idx: await search.searchIndexed(P, query, viewer, 20) };
  });
}
const indexed = (who: Identity, P: string, query: string) => as(who, P, async () => search.searchIndexed(P, query, await analysis.readsPublishedOnly(P), 20));

function same(a: readonly Found[] | null, b: readonly Found[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i] as Record<string, unknown>;
    const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
    return [...keys].every((k) => Object.is((x as Record<string, unknown>)[k], y[k]));
  });
}

const names = (es: readonly Found[] | null) => (es ?? []).map((e) => e.name);
const outcome = (k: 'resident' | 'failed') => trace.snapshot()['search:names']?.[k] ?? 0;

/** Count rebuilds and list reads while `fn` runs. */
async function counting<T>(fn: () => Promise<T>): Promise<{ out: T; rebuilds: number; lists: number }> {
  const [origRebuild, origList] = [index.rebuild, datasets.listDatasets];
  let rebuilds = 0;
  let lists = 0;
  (index as { rebuild: unknown }).rebuild = (...a: Parameters<typeof index.rebuild>) => { rebuilds++; return origRebuild(...a); };
  (datasets as { listDatasets: unknown }).listDatasets = (p: string) => { lists++; return origList(p); };
  try {
    return { out: await fn(), rebuilds, lists };
  } finally {
    (index as { rebuild: unknown }).rebuild = origRebuild;
    (datasets as { listDatasets: unknown }).listDatasets = origList;
  }
}

const cols = [{ name: 'region', type: 'text' as const }, { name: 'amount', type: 'number' as const }];
async function saveDataset(P: string, name: string): Promise<string> {
  const d = await as(ADMIN, null, () => datasets.saveDataset(P, { name, sourceKind: 'csv', columns: cols, rows: [['West', 1], ['East', 2]] }));
  if (!d) throw new Error('seed ' + name);
  return d.id;
}

async function world(): Promise<{ P: string; dsOld: string; E: string }> {
  const P = await as(ADMIN, null, async () => {
    await projects.init();
    return (await projects.createProject('Search index')).id;
  });
  const sales = await saveDataset(P, 'Sales');
  for (const n of ['Sales 2024', 'Revenue', 'Sales – West', 'INV-2041 ledger']) await saveDataset(P, n);
  const dsOld = await saveDataset(P, 'Old sales backup');
  const E = await as(ADMIN, null, async () => {
    await visuals.saveVisual(P, { name: 'Sales chart', datasetId: sales, chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } } as never);
    await metrics.saveMetric(P, { name: 'Sales total', datasetId: sales, definition: { column: 'amount', aggregation: 'sum' } });
    await alertStore.saveRule(P, { name: 'Sales drop', datasetId: sales, metric: { column: 'amount', aggregation: 'sum' }, compare: 'threshold', threshold: { op: '<', value: 1 }, enabled: true });
    await connections.saveConnection(P, { name: 'Sales DB', connectorId: 'postgres', values: { host: 'db.example.com', port: 5432, database: 'app', user: 'reader' } } as never);
    const call = async (channel: string, payload: unknown) => (await handler(channel)({}, payload)) as { id: string };
    await call('analysis:create', { projectId: P, name: 'Draft canary sales plan' });
    const id = (await call('analysis:create', { projectId: P, name: 'Shown sales board' })).id;
    await call('analysis:view', { projectId: P, id, op: { op: 'create', name: 'West', state: {} } });
    await call('analysis:publish', { projectId: P, id });
    await call('analysis:update', { projectId: P, id, name: 'Edit canary sales board' });
    return id;
  });
  return { P, dsOld, E };
}

function pureRules(): void {
  ok('words: punctuation splits, case folds', match.wordsOf('INV-2041 Sales–West').join(' ') === 'inv 2041 sales west');
  ok('words: accents and marks stay inside a word', match.wordsOf('Café Zürich').join(' ') === 'café zürich');
  ok('words: a word is cut to 64 code points, a name to 64 words', match.wordsOf('x'.repeat(100))[0].length === 64 && match.wordsOf('a '.repeat(100)).length === 64);
  ok('clean: no NUL, no lone surrogate', match.clean('a\u0000b\uD800c') === 'ab�c');
  ok('match: every typed word starts a name word, in any order', match.matches(['sales', 'west'], ['west', 'sal']) && !match.matches(['sales'], ['ales']) && !match.matches(['sales'], []));
  ok('tsquery: quoted prefixes', match.tsqueryOf(['sal', 'west']) === "'sal':* & 'west':*");
}

async function pureLeg(): Promise<void> {
  pureRules();
  const { P } = await world();
  const { ref, idx } = await both(EDITOR, P, 'sales');
  ok('no DB: the index path answers null (the reference runs)', idx === null);
  ok('rank: the whole name first', ref[0]?.name === 'Sales', names(ref));
  const firstOther = names(ref).findIndex((n) => !n.toLowerCase().startsWith('sales'));
  ok('rank: every "starts with" before every other match', firstOther > 0 && names(ref).slice(firstOther).every((n) => !n.toLowerCase().startsWith('sales')), names(ref));
  ok('words: "west sales" finds "Sales – West"; "sal" finds Sales; "ales" finds nothing', names((await both(EDITOR, P, 'west sales')).ref).includes('Sales – West')
    && names((await both(EDITOR, P, 'sal')).ref).includes('Sales') && (await both(EDITOR, P, 'ales')).ref.length === 0);
  ok('words: "inv-20" finds "INV-2041 ledger"', names((await both(EDITOR, P, 'inv-20')).ref).includes('INV-2041 ledger'));
  ok('names only: a detail line ("2 rows") is never searched', (await both(EDITOR, P, 'rows')).ref.length === 0);
  ok('a viewer: no draft dashboard name', (await both(VIEWER, P, 'canary')).ref.length === 0 && names((await both(VIEWER, P, 'board')).ref).includes('Shown sales board'));
  ok('an editor: both drafts and the draft view (the control)', (await both(EDITOR, P, 'canary')).ref.length === 3, names((await both(EDITOR, P, 'canary')).ref));
}

async function dbLeg(pool: Pool): Promise<void> {
  const { P, dsOld, E } = await world();

  // ── 1 + 2. The differential, editor and viewer ─────────────────────────
  const r0 = outcome('resident');
  const unequal: string[] = [];
  for (const who of [EDITOR, VIEWER]) {
    for (const q of QUERIES) {
      const { ref, idx } = await both(who, P, q);
      if (!same(ref, idx)) unequal.push(`${who.user.email} "${q}": ${JSON.stringify(names(ref))} vs ${JSON.stringify(names(idx))}`);
    }
  }
  ok('differential: the index equals the reference for every query, editor and viewer', unequal.length === 0, unequal);
  ok('the index answered each one (resident)', outcome('resident') - r0 === QUERIES.length * 2, outcome('resident') - r0);
  ok('a viewer: no draft name from the index; the published copy and its view are there',
    (await indexed(VIEWER, P, 'canary'))?.length === 0 && names(await indexed(VIEWER, P, 'shown')).join(' | ') === 'Shown sales board | Shown sales board › West');
  ok('an editor: both drafts and the view from the index (the control)', (await indexed(EDITOR, P, 'canary'))?.length === 3);

  // ── 3. On write: no rebuild, no list read ──────────────────────────────
  const still = await counting(() => indexed(EDITOR, P, 'sales'));
  ok('built: a search rebuilds nothing and reads no list', still.rebuilds === 0 && still.lists === 0, still);
  await saveDataset(P, 'Salesforce export');
  const added = await counting(() => indexed(EDITOR, P, 'salesforce'));
  ok('a save is found by the very next search — with no rebuild (the write updated the index)', names(added.out).join() === 'Salesforce export' && added.rebuilds === 0, added);
  await as(ADMIN, null, async () => {
    await handler('analysis:update')({}, { projectId: P, id: E, name: 'Renamed sales board' });
    await datasets.deleteDataset(P, dsOld);
  });
  const moved = await counting(() => both(EDITOR, P, 'sales'));
  ok('a rename and a delete are followed, with no rebuild', names(moved.out.idx).includes('Renamed sales board') && !names(moved.out.idx).includes('Old sales backup')
    && !names(moved.out.idx).includes('Edit canary sales board') && moved.rebuilds === 0, names(moved.out.idx));
  ok('…and the differential still holds', same(moved.out.ref, moved.out.idx));
  const viewed = names(await indexed(VIEWER, P, 'board'));
  ok('a viewer still gets the PUBLISHED name, not the renamed draft', viewed.includes('Shown sales board') && !viewed.some((n) => n.startsWith('Renamed')), viewed);

  // ── 4. A save never fails for the index ────────────────────────────────
  const markers = async (source = 'datasets') => Number((await pool.query('SELECT count(*) FROM search_sources WHERE project_id = $1 AND source = $2', [P, source])).rows[0].count);
  index.useDescriber(() => { throw Object.assign(new Error('describer broke'), { code: 'TEST' }); });
  let saved = '';
  try {
    saved = await saveDataset(P, 'Sales after a broken index');
  } finally {
    index.useDescriber(search.describeRecord);
  }
  ok('a describer that throws: the save still goes through, and the datasets marker is dropped', !!saved && (await markers()) === 0);
  const healed = await counting(() => both(EDITOR, P, 'broken index'));
  ok('…the next search rebuilds that source once and finds it, equal to the reference', healed.rebuilds === 1 && names(healed.out.idx).join() === 'Sales after a broken index' && same(healed.out.ref, healed.out.idx), healed);
  index.useDescriber(null);
  try {
    await saveDataset(P, 'Sales from a script');
  } finally {
    index.useDescriber(search.describeRecord);
  }
  ok('no describer (a script without the stores): the save drops the marker', (await markers()) === 0);
  ok('…and the next search finds it', names(await indexed(EDITOR, P, 'script')).join() === 'Sales from a script');

  // ── 4b. What a record can hold, and what a rebuild must read past ──────
  // A NUL in a detail line (a metric's column) is text Postgres refuses: stored cleaned, on both paths alike.
  const nulDs = await saveDataset(P, 'Nul source');
  await as(ADMIN, null, async () => {
    const m = await metrics.saveMetric(P, { name: 'Nul column metric', datasetId: nulDs, definition: { column: 'amount', aggregation: 'sum' } });
    if (!m) throw new Error('seed the nul metric');
    const file = path.join(appPaths.userData(), 'projects', P, 'metrics', m.id + '.json');
    const body = JSON.parse(await recordFs.readFile(file, 'utf8'));
    body.definition.column = 'am\u0000ount';
    await recordFs.writeFile(file, JSON.stringify(body));
  });
  const nul = await both(EDITOR, P, 'nul column');
  ok('a NUL in a detail line: the write keeps the metrics marker, and the index answers, cleaned, equal to the reference',
    (await markers('metrics')) === 1 && same(nul.ref, nul.idx) && nul.idx?.[0]?.sub === 'sum(amount)', nul);

  // A record past its limits, first in path order: alone in a byte-capped page, it must not end the rebuild.
  const HUGE = `projects/${P}/datasets/00000000-0000-4000-8000-000000000000.json`;
  await pool.query('INSERT INTO records (org_id, path, body) VALUES ($1, $2, $3)',
    ['acme', HUGE, JSON.stringify({ id: '00000000-0000-4000-8000-000000000000', name: 'Huge sales', pad: 'x'.repeat(9 * 1024 * 1024) })]);
  await pool.query(`DELETE FROM search_sources WHERE project_id = $1 AND source = 'datasets'`, [P]);
  const past = await both(EDITOR, P, 'sales');
  ok('a record past its limits: the rebuild pages past it and indexes the rest, equal to the reference', !!past.idx?.length && same(past.ref, past.idx) && !names(past.idx).includes('Huge sales'), names(past.idx));
  const c = await pool.connect();
  try {
    const dir = `projects/${P}/datasets`;
    const pageOf = (after: string, maxBytes: number) => as(ADMIN, null, () => recordFs.rowsUnder(c, 'acme', dir, after, 100, maxBytes));
    const whole = await pageOf('', Number.MAX_SAFE_INTEGER);
    const pages: string[][] = [];
    for (let after = ''; ;) {
      const page = await pageOf(after, 1);
      if (!page.length) break;
      pages.push(page.map((r) => r.rel));
      after = page[page.length - 1].rel;
    }
    ok('rowsUnder: a 1-byte budget reads one record a page, and the pages visit every record once, in order (a skipped one as a null body)',
      whole.length > 1 && pages.every((p) => p.length === 1) && pages.flat().join() === whole.map((r) => r.rel).join() && whole.some((r) => r.rel === HUGE && r.body === null), pages.length);
  } finally {
    c.release();
  }
  await pool.query('DELETE FROM records WHERE org_id = $1 AND path = $2', ['acme', HUGE]);

  // A failed index write keeps the source's shared lock to the end of its transaction, so no rebuild reads past it.
  const sharedLocks = async () => Number((await pool.query(
    `SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND mode = 'ShareLock' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0].count);
  const JUNK = await as(ADMIN, null, async () => path.join(appPaths.userData(), 'projects', P, 'datasets', '11111111-1111-4111-8111-111111111111.json'));
  let during = -1;
  index.useDescriber(() => { throw Object.assign(new Error('describer broke'), { code: 'TEST' }); });
  try {
    await as(ADMIN, null, () => recordFs.locked(JUNK, async () => {
      await recordFs.writeFile(JUNK, '{}');
      during = await sharedLocks();
    }));
  } finally {
    index.useDescriber(search.describeRecord);
    await as(ADMIN, null, () => recordFs.rm(JUNK, { force: true }));
  }
  ok('a failed index write still holds its shared lock until the transaction ends', during === 1 && (await sharedLocks()) === 0, during);
  const relocked = await counting(async () => ({ before: await markers(), found: await indexed(EDITOR, P, 'sales') }));
  ok('…its marker was dropped under that lock, and the next search rebuilds the source once', relocked.out.before === 0 && relocked.rebuilds === 1 && !!relocked.out.found?.length, relocked);

  // ── 5. NEGATIVE CONTROL: a row changed behind the index's back ─────────
  await pool.query(`UPDATE search_entries SET name = 'Sales tampered' WHERE project_id = $1 AND name = 'Sales 2024'`, [P]);
  const tampered = await both(EDITOR, P, 'sales');
  ok('NEGATIVE CONTROL: a tampered row makes the differential fail (the comparison can see a difference)', !same(tampered.ref, tampered.idx) && names(tampered.idx).includes('Sales tampered'));
  await pool.query(`DELETE FROM search_sources WHERE project_id = $1 AND source = 'datasets'`, [P]);
  const rebuilt = await both(EDITOR, P, 'sales');
  ok('…dropping its marker rebuilds it on the next search', same(rebuilt.ref, rebuilt.idx));

  // ── 6. A failing index query: the handler answers from the reference ───
  const realQuery = index.query;
  (index as { query: unknown }).query = async () => { throw Object.assign(new Error('boom'), { code: 'XX000' }); };
  const f0 = outcome('failed');
  try {
    const via = (await as(EDITOR, P, () => handler('search:query')({}, { projectId: P, query: 'sales' }))) as { ok: boolean; results: Array<{ name: string }> };
    const ref = await as(EDITOR, P, () => search.searchNames(P, 'sales'));
    ok('a failing index: the handler answers from the reference, the same names', via.ok === true && via.results.map((h) => h.name).join('|') === names(ref.slice(0, 20)).join('|'), via);
    ok('…counted as failed (the regression signal)', outcome('failed') === f0 + 1);
  } finally {
    (index as { query: unknown }).query = realQuery;
  }

  // ── 7. A deleted project leaves nothing ────────────────────────────────
  const count = async (): Promise<number> =>
    Number((await pool.query('SELECT (SELECT count(*) FROM search_entries WHERE project_id = $1) + (SELECT count(*) FROM search_sources WHERE project_id = $1) AS n', [P])).rows[0].n);
  ok('the project has index rows', (await count()) > 0);
  await as(ADMIN, null, () => projects.deleteProject(P));
  ok('a deleted project: no index rows and no markers left', (await count()) === 0);
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
