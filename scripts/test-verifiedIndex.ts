// The Assistant's verified-question lookups: the index (0026_verified_index.sql, src/server/verifiedIndex.ts, kept
// current by every write in recordFs) gives the SAME answer as reading every verified record (src/ipc/verifiedLookup.ts
// referenceHit / referenceExamples), id for id and line for line with Object.is.
//
// Always: examples taken a batch at a time are the examples taken at once (../ai/verifiedPick takeExamples).
// With DATABASE_URL (a scratch database it may CREATE DATABASE on):
//   1. THE DIFFERENTIAL: exact match over questions × scopes × exclude, and examples over questions × open dataset ×
//      agent topic × exclude, index === reference; including a broken first batch, so a second one is read.
//   2. A miss reads NO verified record (no list, no file, no batch read); a hit reads one. NEGATIVE CONTROL: the
//      reference lists them all.
//   3. ON WRITE: a changed phrasing, a trashed and a restored question are found (or not) by the very next lookup,
//      with no rebuild: the write updated the index itself.
//   4. A save never fails for the index: a describer that throws, or none, drops the marker; the save goes through, and
//      the next ask rebuilds and finds it.
//   5. NEGATIVE CONTROL: a key changed behind the index's back makes the differential FAIL.
//   6. A failing index query: the answer comes from the records.
//   7. A deleted project leaves no rows and no marker.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-verifiedIndex.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-verifiedindex-'));
const context: typeof import('../src/server/context') = require('../src/server/context');
context.enterServerMode(DATA);
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const inOrg: typeof import('../src/server/db/inOrg') = require('../src/server/db/inOrg');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const store: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
const pick: typeof import('../src/ai/verifiedPick') = require('../src/ai/verifiedPick');
const index: typeof import('../src/server/verifiedIndex') = require('../src/server/verifiedIndex');
const lookup: typeof import('../src/ipc/verifiedLookup') = require('../src/ipc/verifiedLookup');

type Identity = import('../src/server/context').Identity;
type VerifiedQuestion = import('../src/analysis/verifiedRules').VerifiedQuestion;
type Examples = import('../src/ipc/verifiedLookup').Examples;
const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
let req = 0;
const as = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(ADMIN, `r${++req}`, fn);

const sameList = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
const sameExamples = (a: Examples | null, b: Examples): boolean => !!a && sameList(a.lines, b.lines) && sameList(a.ids, b.ids);

// ── always: a batch at a time is all at once ────────────────────────────
function pureLeg(): void {
  const names = { dataset: () => 'Orders', term: () => '' };
  const q = (i: number, long = false): VerifiedQuestion => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, projectId: 'p', question: (long ? 'x'.repeat(900) : `revenue by region ${i}`), phrasings: [],
    spec: { datasetId: 'd', category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: '' },
    verifiedBy: '', verifiedAt: '', createdAt: '', updatedAt: '', schemaVersion: 1,
  });
  const qs = [q(1), q(2, true), q(3), q(4), q(5), q(6), q(7), q(8)];
  const whole = pick.takeExamples(qs, names);
  for (const size of [1, 2, 3, 7]) {
    let t = pick.NOTHING_TAKEN;
    for (let i = 0; i < qs.length; i += size) t = pick.takeExamples(qs.slice(i, i + size), names, t);
    ok(`examples in batches of ${size} are the examples at once`, sameList(t.ids, whole.ids) && sameList(t.lines, whole.lines) && t.done === whole.done);
  }
  ok('five taken: done, so no later batch is read', whole.done && whole.ids.length === 5);
  ok('NEGATIVE CONTROL: fewer than five is not done', !pick.takeExamples(qs.slice(0, 3), names).done);
  ok('an overlong line is skipped, not counted', !whole.ids.includes(q(2).id));
}

// ── the world: three datasets, 46 questions; Scratch is deleted, so its 24 questions no longer run ──
const WORDS = ['revenue', 'sales', 'region', 'city', 'month', 'profit', 'orders', 'returns', 'west', 'east', 'top', 'year'];
interface World { P: string; orders: string; stores: string; scratch: string; all: VerifiedQuestion[] }

async function world(): Promise<World> {
  return as(async () => {
    await projects.init();
    const P = (await projects.createProject('Verified index'))!.id;
    const make = async (name: string, cols: Array<[string, 'text' | 'number']>) =>
      (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns: cols.map(([n, type]) => ({ name: n, type })), rows: [['West', 1]] }))!.id;
    const orders = await make('Orders', [['region', 'text'], ['amount', 'number']]);
    const stores = await make('Stores', [['city', 'text'], ['sales', 'number']]);
    const scratch = await make('Scratch', [['k', 'text'], ['v', 'number']]);
    const spec = (ds: string) => ds === orders
      ? { datasetId: ds, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' as const }], filters: [], chartType: 'column', title: '' }
      : ds === stores
        ? { datasetId: ds, category: 'city', measures: [{ column: 'sales', aggregation: 'sum' as const }], filters: [], chartType: 'column', title: '' }
        : { datasetId: ds, category: 'k', measures: [{ column: 'v', aggregation: 'sum' as const }], filters: [], chartType: 'column', title: '' };
    const all: VerifiedQuestion[] = [];
    const put = async (question: string, ds: string, updatedAt: string, phrasings: string[] = []) => {
      const q: VerifiedQuestion = {
        id: crypto.randomUUID(), projectId: P, question, phrasings, spec: spec(ds), verifiedBy: 'ana@acme.test', verifiedAt: updatedAt,
        createdAt: updatedAt, updatedAt, schemaVersion: 1,
      };
      const saved = await store.writeVerified(P, q);
      if (!saved) throw new Error('seed ' + question);
      all.push(saved);
    };
    for (let i = 0; i < 22; i++) {
      const ds = i % 2 ? stores : orders;
      const w = (k: number) => WORDS[(i * 7 + k * 5) % WORDS.length];
      await put(`${w(0)} by ${w(1)} ${w(2)} n${i}`, ds, `2026-11-0${1 + (i % 3)}T10:00:00.000Z`, i % 4 === 0 ? [`${w(3)} per ${w(1)} n${i}`] : []);
    }
    for (let i = 0; i < 24; i++) await put(`revenue by region scratch s${i}`, scratch, '2026-11-09T10:00:00.000Z'); // the context's dataset, all broken
    await put('Revenue by region', orders, '2026-11-05T10:00:00.000Z', ['revenue per region', 'sales by region']);
    await put('Sales by city', stores, '2026-11-05T10:00:00.000Z');
    await datasets.deleteDataset(P, scratch);
    return { P, orders, stores, scratch, all };
  });
}

/** Count verified-record reads while `fn` runs: listings, single reads (or records read by a listing's page) and paths in batch reads. */
async function reads<T>(fn: () => Promise<T>): Promise<{ out: T; lists: number; files: number; batched: number }> {
  const [list, readFile, readMany, listRecords] = [store.listTagged, recordFs.readFile, recordFs.readMany, recordFs.listRecords];
  let lists = 0, files = 0, batched = 0;
  const verifiedPath = (p: unknown) => typeof p === 'string' && /[\\/]verified[\\/]/.test(p);
  (store as { listTagged: unknown }).listTagged = (p: string) => { lists++; return list(p); };
  (recordFs as { readFile: unknown }).readFile = (p: string, enc?: BufferEncoding) => { if (verifiedPath(p)) files++; return (readFile as (p: string, e?: BufferEncoding) => Promise<unknown>)(p, enc); };
  (recordFs as { readMany: unknown }).readMany = (ps: readonly string[]) => { batched += ps.filter(verifiedPath).length; return readMany(ps); };
  (recordFs as { listRecords: unknown }).listRecords = async (dir: string) => {
    const it = await listRecords(dir);
    return (async function* () { for await (const r of it) { if (verifiedPath(path.join(dir, r.name))) files++; yield r; } })();
  };
  try {
    return { out: await fn(), lists, files, batched };
  } finally {
    (store as { listTagged: unknown }).listTagged = list;
    (recordFs as { readFile: unknown }).readFile = readFile;
    (recordFs as { readMany: unknown }).readMany = readMany;
    (recordFs as { listRecords: unknown }).listRecords = listRecords;
  }
}

async function differential(w: World, label: string): Promise<boolean> {
  return as(async () => {
    let all = true;
    const scopes: Array<ReadonlySet<string> | null> = [null, new Set([w.orders]), new Set([w.stores]), new Set(), new Set([w.orders, w.stores])];
    const asked = ['Revenue by region', 'REVENUE  per region?', 'sales by region', 'sales by city', 'revenue by region last year', '???', '', 'nope',
      w.all[0].question, w.all[4].phrasings[0] ?? 'x', w.all[23].question];
    for (const q of asked) for (const scope of scopes) for (const exclude of [undefined, w.all.at(-2)!.id]) {
      const idx = await lookup.indexedHit(w.P, q, scope, exclude);
      const ref = await lookup.referenceHit(w.P, q, scope, exclude);
      if (!idx || !Object.is(idx.q?.id ?? null, ref?.id ?? null)) { all = false; console.log(`  ${label} hit differs:`, q, scope ? [...scope] : null, exclude, idx?.q?.id, ref?.id); }
    }
    const questions = ['revenue by region', 'sales by city last month', 'profit east west top', 'zzz', ''];
    for (const question of questions) for (const datasetId of [undefined, w.orders, w.scratch]) for (const first of [undefined, new Set([w.stores])]) for (const exclude of [undefined, w.all.at(-2)!.id]) {
      const a = { question, datasetId, first, exclude };
      const idx = await lookup.indexedExamples(w.P, a);
      const ref = await lookup.referenceExamples(w.P, a);
      if (!sameExamples(idx, ref)) { all = false; console.log(`  ${label} examples differ:`, JSON.stringify(a), idx?.ids, ref.ids); }
    }
    return all;
  });
}

const builtAt = async (pool: Pool, P: string): Promise<string | null> =>
  (await pool.query('SELECT built_at::text AS t FROM verified_built WHERE project_id = $1', [P])).rows[0]?.t ?? null;

async function dbLeg(pool: Pool): Promise<void> {
  const w = await world();
  const { P } = w;

  // ── 1. the differential ─────────────────────────────────────────────────
  ok('the index is built on first use', (await builtAt(pool, P)) === null && (await differential(w, 'first')) && (await builtAt(pool, P)) !== null);
  ok('THE DIFFERENTIAL: every hit and every example list, index === reference', await differential(w, 'built'));
  const broken = await as(() => lookup.indexedExamples(P, { question: 'revenue by region', datasetId: w.scratch }));
  ok('a first batch that no longer runs: the examples come from the next one', !!broken && broken.ids.length === 5 && !broken.ids.some((id) => w.all.find((q) => q.id === id)!.spec.datasetId === w.scratch));

  // ── 2. a miss reads no record ──────────────────────────────────────────
  const miss = await as(() => reads(() => lookup.indexedHit(P, 'revenue by region last year', null)));
  ok('a miss: no verified record read (no list, no file, no batch)', miss.out?.q === null && miss.lists === 0 && miss.files === 0 && miss.batched === 0, JSON.stringify(miss));
  const hit = await as(() => reads(() => lookup.indexedHit(P, 'revenue per region', null)));
  ok('a hit: that one record read, and nothing listed', hit.out?.q?.question === 'Revenue by region' && hit.lists === 0 && hit.batched === 1 && hit.files === 0, JSON.stringify({ ...hit, out: hit.out?.q?.id }));
  const ex = await as(() => reads(() => lookup.indexedExamples(P, { question: 'revenue by region', datasetId: w.orders })));
  ok('examples: one batch of 20 read, out of 48', ex.lists === 0 && ex.batched === 20 && ex.out?.ids.length === 5, JSON.stringify({ ...ex, out: ex.out?.ids.length }));
  const ref = await as(() => reads(() => lookup.referenceHit(P, 'revenue by region last year', null)));
  ok('NEGATIVE CONTROL: the reference lists and reads every one', ref.lists === 1 && ref.files === w.all.length, JSON.stringify({ ...ref, out: null }));
  const viaAsk = await as(() => reads(() => lookup.verifiedHit(P, 'sales by city?', null)));
  ok('verifiedHit (what copilot:ask calls) takes the index', viaAsk.out?.question === 'Sales by city' && viaAsk.lists === 0 && viaAsk.batched === 1);

  // ── 3. on write: found by the next lookup, no rebuild ──────────────────
  const before = await builtAt(pool, P);
  const rev = w.all.find((q) => q.question === 'Revenue by region')!;
  await as(() => store.writeVerified(P, { ...rev, phrasings: ['takings by area'], updatedAt: '2026-11-10T10:00:00.000Z' }));
  const moved = await as(async () => [await lookup.indexedHit(P, 'takings by area', null), await lookup.indexedHit(P, 'sales by region', null)]);
  ok('a saved phrasing is found, and the dropped one is not', moved[0]?.q?.id === rev.id && moved[1]?.q === null);
  const binned = await as(() => trash.trashRecord(P, 'verified', rev.id));
  const gone = await as(() => lookup.indexedHit(P, 'Revenue by region', null));
  ok('a trashed question no longer matches', binned.ok && gone?.q === null);
  const back = await as(() => trash.restore(P, 'verified', rev.id));
  const again = await as(() => lookup.indexedHit(P, 'takings by area', null));
  ok('a restored one matches again', back.ok && again?.q?.id === rev.id, JSON.stringify(back));
  ok('none of that rebuilt the index', (await builtAt(pool, P)) === before);
  ok('THE DIFFERENTIAL after the writes', await differential(w, 'written'));

  // ── 3b. an older pod's write (no `ordinate.verified_index`): the trigger drops the marker ──
  const oldPodQ: VerifiedQuestion = { ...rev, id: crypto.randomUUID(), question: 'Margin by region', phrasings: [], updatedAt: '2026-11-11T10:00:00.000Z' };
  const c = await pool.connect();
  try {
    await c.query("BEGIN; SELECT set_config('ordinate.org', 'acme', true)");
    await c.query('INSERT INTO records (org_id, path, body) VALUES ($1, $2, $3)', ['acme', `projects/${P}/verified/${oldPodQ.id}.json`, JSON.stringify(oldPodQ)]);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  ok('a write that does not keep the index (an older pod) drops the marker', (await builtAt(pool, P)) === null);
  const seen = await as(() => lookup.indexedHit(P, 'margin by region', null));
  ok('and the next ask rebuilds and finds what it wrote', seen?.q?.id === oldPodQ.id && (await builtAt(pool, P)) !== null);
  w.all.push(oldPodQ);

  // ── 4. a save never fails for the index ────────────────────────────────
  const sales = w.all.find((q) => q.question === 'Sales by city')!;
  index.useVerifiedDescriber(() => { throw new Error('describer down'); });
  const savedAnyway = await as(() => store.writeVerified(P, { ...sales, phrasings: ['takings by town'] }));
  ok('a describer that throws: the save goes through, and the marker is dropped', !!savedAnyway && (await builtAt(pool, P)) === null);
  index.useVerifiedDescriber(null);
  await as(() => store.writeVerified(P, { ...sales, phrasings: ['takings by town', 'income by town'] }));
  ok('no describer: the save goes through, marker still dropped', (await builtAt(pool, P)) === null);
  index.useVerifiedDescriber(lookup.describeVerified);
  const rebuilt = await as(() => lookup.indexedHit(P, 'income by town', null));
  ok('the next ask rebuilds and finds what was saved meanwhile', rebuilt?.q?.id === sales.id && (await builtAt(pool, P)) !== null);

  // ── 5. NEGATIVE CONTROL: the differential catches a stale index ────────
  await pool.query("UPDATE verified_keys SET key = 'zzzz' WHERE project_id = $1 AND id = $2 AND ord = 0", [P, sales.id]);
  ok('NEGATIVE CONTROL: a key changed behind the index makes the differential FAIL', !(await differential(w, 'tampered (expected)')));
  await pool.query('DELETE FROM verified_built WHERE project_id = $1', [P]);
  ok('dropping the marker rebuilds it right', await differential(w, 'repaired'));

  // ── 6. a failing index: the records answer ─────────────────────────────
  const real = index.keyHits;
  (index as { keyHits: unknown }).keyHits = async () => { throw Object.assign(new Error('index down'), { code: '57P01' }); };
  try {
    const fell = await as(() => lookup.verifiedHit(P, 'sales by city', null));
    ok('a failing index query: the reference answers', fell?.id === sales.id);
  } finally {
    (index as { keyHits: unknown }).keyHits = real;
  }

  // ── 7. a deleted project leaves nothing ────────────────────────────────
  const count = async (): Promise<number> =>
    Number((await pool.query('SELECT (SELECT count(*) FROM verified_keys WHERE project_id = $1) + (SELECT count(*) FROM verified_built WHERE project_id = $1) AS n', [P])).rows[0].n);
  ok('the project has index rows', (await count()) > 0);
  await as(() => projects.deleteProject(P));
  ok('a deleted project: no index rows and no marker left', (await count()) === 0);
}

(async () => {
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  pureLeg();

  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip the Postgres leg: DATABASE_URL is unset');
    return;
  }
  const dbName = `ordinate_verifiedindex_${process.pid}_${Date.now()}`;
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
  .catch((e) => ok('verified index suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
