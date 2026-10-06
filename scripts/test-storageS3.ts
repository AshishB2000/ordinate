// Self-check for T5.2 — Parquet on S3 (src/engine/storage.ts, s3.ts, parquetCache.ts).
//
// 1. ENV: STORAGE_URL / S3_ENDPOINT / S3_REGION / STORAGE_CACHE_MB /
//    STORAGE_GC_GRACE_MINUTES / DUCKDB_EXTENSION_DIR are parsed, and every
//    value that reaches SQL or a URL is refused unless it is plainly safe.
// Against MinIO (STORAGE_URL=s3://…, DATABASE_URL; else one `skip` line):
// 2. ISOLATION inside the worker: org `evil`'s worker cannot read `acme`'s
//    object, a `..` key, or acme's cached copy; acme's cannot read a sibling
//    prefix `orgs/acmex/`. Control: acme's worker reads its own object.
// 3. ATOMIC SWITCH: three readers loop over dataset:page and dashboard:metric
//    while a writer replaces the table six times; every answer is exactly ONE
//    version's (row count and every value agree), never an error.
// 4. GC: only versions that no record names AND that were first seen
//    unreferenced longer than the grace period ago are deleted — the current
//    version, a trashed dataset's, and an in-flight write's are kept;
//    a deleted dataset's and the superseded ones go (gone from S3 too).
// 5. CACHE: hits after a fill, LRU eviction at the byte cap, adoption of the
//    files on disk after a restart.
// 6. WIRING: the real app registers the `storage:gc` job in the jobs table.
//
//   npm run build:ts && STORAGE_URL=s3://ordinate-test S3_ENDPOINT=http://localhost:9000 \
//     AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin DATABASE_URL=… \
//     node scripts/test-storageS3.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-s3-'));
const DATA = path.join(TMP, 'data');
process.env.ORDINATE_LOCAL_DIR = TMP;

const envMod: typeof import('../src/server/env') = require('../src/server/env');
const s3Test: typeof import('./s3TestEnv') = require('./s3TestEnv');

type Cell = import('../src/data/transforms').Cell;
type Identity = import('../src/server/context').Identity;
const who = (org: string): Identity => ({ user: { email: `u@${org}`, role: 'admin' }, org: { id: org } });

function envError(vars: Record<string, string>): string {
  try {
    envMod.parseEnv(vars);
    return 'ACCEPTED';
  } catch (err) {
    return err instanceof envMod.EnvError ? err.message : 'wrong error';
  }
}

function envChecks(): void {
  const d = envMod.parseEnv({}).storage;
  ok('env: default — DATA_DIR storage, 2,048 MB cache, 60 min grace', d.s3 === null && d.cacheBytes === 2048 * 2 ** 20 && d.gcGraceMs === 3_600_000, JSON.stringify(d));
  const db = { DATABASE_URL: 'postgres://u@h/db' };
  const s = envMod.parseEnv({ ...db, STORAGE_URL: 's3://my-bucket/a/b', S3_ENDPOINT: 'http://localhost:9000', STORAGE_CACHE_MB: '0', AWS_REGION: 'eu-west-1' }).storage;
  ok('env: s3://bucket/prefix + a MinIO endpoint', JSON.stringify(s.s3) === JSON.stringify({ bucket: 'my-bucket', prefix: 'a/b', region: 'eu-west-1', endpoint: 'localhost:9000', useSsl: false, extensionDir: null }) && s.cacheBytes === 0, JSON.stringify(s));
  ok('env: plain AWS — no endpoint, TLS, us-east-1', JSON.stringify(envMod.parseEnv({ ...db, STORAGE_URL: 's3://b-1' }).storage.s3) ===
    JSON.stringify({ bucket: 'b-1', prefix: '', region: 'us-east-1', endpoint: null, useSsl: true, extensionDir: null }));
  ok('env: STORAGE_URL=file:///x is DATA_DIR', envMod.parseEnv({ STORAGE_URL: 'file:///srv/ordinate' }).dataDir === path.resolve('/srv/ordinate'));
  ok('env: …and satisfies prod\'s DATA_DIR rule', envMod.parseEnv({ ORDINATE_ENV: 'prod', AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '10.0.0.0/8', ...db,
    ORDINATE_MASTER_KEY: 'a'.repeat(64), STORAGE_URL: 'file:///data' }).dataDir === path.resolve('/data'));
  for (const [label, vars, name] of [
    ['a bucket with a quote', { ...db, STORAGE_URL: "s3://b'x/p" }, 'STORAGE_URL'],
    ['a `..` prefix', { ...db, STORAGE_URL: 's3://bucket/a/../b' }, 'STORAGE_URL'],
    ['a prefix with a quote', { ...db, STORAGE_URL: "s3://bucket/a'; DROP" }, 'STORAGE_URL'],
    ['a query string', { ...db, STORAGE_URL: 's3://bucket/p?x=1' }, 'STORAGE_URL'],
    ['another scheme', { STORAGE_URL: 'gs://bucket/p' }, 'STORAGE_URL'],
    ['file:// and DATA_DIR disagreeing', { STORAGE_URL: 'file:///a', DATA_DIR: '/b' }, 'STORAGE_URL'],
    ['s3 without DATABASE_URL', { STORAGE_URL: 's3://bucket' }, 'DATABASE_URL'],
    ['an endpoint with a path', { ...db, STORAGE_URL: 's3://bucket', S3_ENDPOINT: 'http://h:9000/x' }, 'S3_ENDPOINT'],
    ['an endpoint with credentials', { ...db, STORAGE_URL: 's3://bucket', S3_ENDPOINT: 'http://k:s@h:9000' }, 'S3_ENDPOINT'],
    ['a region with a quote', { ...db, STORAGE_URL: 's3://bucket', S3_REGION: "us'east" }, 'S3_REGION'],
    ['a relative extension dir', { ...db, STORAGE_URL: 's3://bucket', DUCKDB_EXTENSION_DIR: 'ext' }, 'DUCKDB_EXTENSION_DIR'],
    ['a negative cache', { STORAGE_CACHE_MB: '-1' }, 'STORAGE_CACHE_MB'],
    ['a zero grace', { STORAGE_GC_GRACE_MINUTES: '0' }, 'STORAGE_GC_GRACE_MINUTES'],
  ] as Array<[string, Record<string, string>, string]>) {
    const msg = envError(vars);
    ok(`env: ${label} is refused, naming ${name}`, msg.startsWith(name), msg);
  }
}

const isPermission = (m: string): boolean => /Permission Error|disabled by configuration/.test(m);
async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'RESOLVED';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function minio(t: import('./s3TestEnv').S3Test): Promise<void> {
  const context: typeof import('../src/server/context') = require('../src/server/context');
  const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
  const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
  const storage: typeof import('../src/engine/storage') = require('../src/engine/storage');
  const cache: typeof import('../src/engine/parquetCache') = require('../src/engine/parquetCache');
  const s3: typeof import('../src/engine/s3') = require('../src/engine/s3');
  const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const trash: typeof import('../src/app/trash') = require('../src/app/trash');
  const handlers: ReadonlyMap<string, (e: unknown, p?: unknown) => Promise<any>> = require('../src/server/rpc').handlers; // any: handler replies
  require('../src/ipc/datasets').register();
  require('../src/ipc/dashboards').register();

  context.enterServerMode(DATA);
  recordFs.useRecordDb(t.pool);
  storage.useStorageDb(t.pool);
  storage.configure(DATA, t.s3, 64 * 2 ** 20);
  const pool = poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 4, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000, s3: t.s3 });
  const inOrg = <T>(org: string, fn: () => Promise<T>): Promise<T> => context.runInContext(who(org), 'r', fn);
  const call = (ch: string, arg: unknown): Promise<any> => handlers.get(ch)!(null, arg); // any: handler replies
  const table = (k: number): Cell[][] => Array.from({ length: 1000 + k * 37 }, (_, i) => [`v${k}`, k, i]);
  const columns = [{ name: 'tag', type: 'text' as const }, { name: 'k', type: 'number' as const }, { name: 'i', type: 'number' as const }];
  const prefix = (org: string): string => storage.orgUrl(t.s3, org);

  try {
    // ── fixtures in acme ─────────────────────────────────────────────────────
    const { pid, d1, d2, d3 } = await inOrg('acme', async () => {
      const p = (await projects.createProject('S3')).id;
      const save = (name: string) => datasets.saveDataset(p, { name, sourceKind: 'csv', columns, rows: table(0) });
      return { pid: p, d1: (await save('one'))!, d2: (await save('two'))!, d3: (await save('three'))! };
    });
    const v0 = (await inOrg('acme', () => datasets.getDatasetMeta(pid, d1.id)))!.storageVersion!;
    const obj = `${prefix('acme')}${pid}/${d1.id}.${v0}.parquet`;

    // ── 2. isolation ────────────────────────────────────────────────────────
    const count = (url: string) => duck.queryAsync(`SELECT count(*)::DOUBLE AS n FROM read_parquet('${url}')`);
    ok('control: acme\'s worker reads its own S3 object', (await inOrg('acme', () => count(obj)))[0]?.n === 1000);
    let m = await refused(inOrg('evil', () => count(obj)));
    ok('org evil\'s worker is refused acme\'s object (inside DuckDB)', isPermission(m), m);
    m = await refused(inOrg('evil', () => count(`${prefix('evil')}../acme/${pid}/${d1.id}.${v0}.parquet`)));
    ok('…and through a `..` key under its own prefix', m !== 'RESOLVED' && !m.includes('"n"'), m);
    m = await refused(inOrg('acme', () => count(`${prefix('acmex')}${pid}/${d1.id}.${v0}.parquet`)));
    ok('acme\'s worker is refused the sibling prefix orgs/acmex/', isPermission(m), m);
    await inOrg('acme', async () => { await datasets.residentSource(pid, d1.id); await cache.settle(); });
    const cached = (await inOrg('acme', () => datasets.residentSource(pid, d1.id)))!.parquetPath;
    ok('acme\'s table is now read from its cache directory', cached.startsWith(cache.dirFor(DATA, 'acme')), cached);
    m = await refused(inOrg('evil', () => count(cached)));
    ok('org evil\'s worker is refused acme\'s cached copy', isPermission(m), m);
    ok('org evil cannot resolve acme\'s dataset at all', (await inOrg('evil', () => datasets.residentSource(pid, d1.id))) === null);

    // ── 3. the version switch is atomic for readers ─────────────────────────
    let writing = true;
    const seen = new Set<number>();
    const bad: string[] = [];
    const reader = async (): Promise<void> => {
      while (writing) {
        const page = await call('dataset:page', { projectId: pid, datasetId: d1.id, offset: 0, limit: 50 });
        const k = page?.rows?.[0]?.[1];
        if (!page?.ok || typeof k !== 'number' || page.total !== 1000 + k * 37 || !page.rows.every((r: Cell[]) => r[0] === `v${k}` && r[1] === k)) {
          bad.push(JSON.stringify(page).slice(0, 160));
        } else seen.add(k);
        const met = await call('dashboard:metric', { projectId: pid, datasetId: d1.id, column: 'k', aggregation: 'avg' });
        if (!met?.ok || !Number.isInteger(met.value)) bad.push('metric ' + JSON.stringify(met));
      }
    };
    await inOrg('acme', async () => {
      const readers = [reader(), reader(), reader()];
      for (let k = 1; k <= 6; k++) await datasets.persist(pid, { ...d1, rows: table(k), rowCount: table(k).length });
      writing = false;
      await Promise.all(readers);
    });
    ok(`readers saw only whole versions across 6 switches (${[...seen].sort().join(',')})`, bad.length === 0 && seen.size >= 2, bad.slice(0, 3).join(' | '));
    const final = await inOrg('acme', () => call('dataset:page', { projectId: pid, datasetId: d1.id, offset: 0, limit: 1 }));
    ok('after the last switch every reader gets version 6', final.total === 1000 + 6 * 37 && final.rows[0][1] === 6, JSON.stringify(final).slice(0, 120));

    // ── 4. garbage collection ───────────────────────────────────────────────
    const inflight = '00000000-0000-4000-8000-0000000000aa';
    await inOrg('acme', async () => {
      const url = await storage.newObject(pid, d1.id, inflight, false);
      await (require('../src/engine/parquetStore') as typeof import('../src/engine/parquetStore')).writeTableAsync(url, columns, table(9), { stageDir: (require('../src/app/paths') as typeof import('../src/app/paths')).temp() });
      await trash.trashRecord(pid, 'dataset', d2.id);
      await datasets.deleteDataset(pid, d3.id);
    });
    const keyOf = (id: string, v: string): string => `${pid}/${id}.${v}.parquet`;
    const versions = async (id: string): Promise<string[]> =>
      (await t.pool.query('SELECT key FROM storage_objects WHERE key LIKE $1 ORDER BY created_at', [`${pid}/${id}.%`])).rows.map((r: { key: string }) => r.key);
    const current = keyOf(d1.id, (await inOrg('acme', () => datasets.getDatasetMeta(pid, d1.id)))!.storageVersion!);
    const d1Keys = await versions(d1.id);
    const superseded = d1Keys.filter((k) => k !== current && !k.includes(inflight));
    const trashed = (await versions(d2.id))[0];
    const removed = (await versions(d3.id))[0];
    ok('fixture: 6 superseded versions, the current one, an in-flight write', superseded.length === 6 && d1Keys.includes(current) && d1Keys.some((k) => k.includes(inflight)), d1Keys.join());

    const pass1 = await inOrg('acme', () => storage.collectGarbage(3_600_000));
    const marks = (await t.pool.query('SELECT key, unreferenced_since IS NOT NULL AS marked FROM storage_objects')).rows as Array<{ key: string; marked: boolean }>;
    const marked = new Set(marks.filter((r) => r.marked).map((r) => r.key));
    ok('GC pass 1 deletes nothing inside the grace period', pass1.length === 0, pass1.join());
    ok('…and stamps exactly the unreferenced versions', superseded.every((k) => marked.has(k)) && marked.has(removed) && [...marked].some((k) => k.includes(inflight))
      && !marked.has(current) && !marked.has(trashed) && marked.size === superseded.length + 2, [...marked].join());

    await t.pool.query("UPDATE storage_objects SET unreferenced_since = now() - interval '2 hours' WHERE unreferenced_since IS NOT NULL AND version <> $1", [inflight]);
    const pass2 = (await inOrg('acme', () => storage.collectGarbage(3_600_000))).sort();
    ok('GC pass 2 deletes exactly the superseded and the deleted dataset\'s versions', JSON.stringify(pass2) === JSON.stringify([...superseded, removed].sort()), pass2.join());
    const onS3 = async (key: string): Promise<boolean> => {
      try {
        await s3.download(t.s3, `${t.s3.prefix}/orgs/acme/${key}`, path.join(TMP, `probe-${Date.now()}-${Math.random()}.parquet`));
        return true;
      } catch {
        return false;
      }
    };
    ok('…they are gone from S3', !(await onS3(superseded[0])) && !(await onS3(removed)));
    ok('the current, trashed and in-flight versions are still on S3',
      (await onS3(current)) && (await onS3(trashed)) && (await onS3(d1Keys.find((k) => k.includes(inflight))!)));
    const after = await inOrg('acme', () => call('dataset:page', { projectId: pid, datasetId: d1.id, offset: 0, limit: 1 }));
    ok('the dataset still reads (version 6) after GC', after.total === 1000 + 6 * 37, JSON.stringify(after).slice(0, 120));
    await inOrg('acme', () => trash.restore(pid, 'dataset', d2.id));
    const back = await inOrg('acme', () => call('dataset:page', { projectId: pid, datasetId: d2.id, offset: 0, limit: 1 }));
    ok('a dataset restored from the trash still reads', back?.ok === true && back.total === 1000, JSON.stringify(back).slice(0, 120));
    const zero = await inOrg('acme', () => storage.collectGarbage(1));
    ok('negative control: a 1 ms grace takes the in-flight object — but never a referenced one',
      zero.length === 1 && zero[0].includes(inflight) && (await onS3(current)) && (await onS3(trashed)), zero.join());

    // ── 5. the cache ────────────────────────────────────────────────────────
    cache.resetCounts();
    const dir = cache.dirFor(DATA, 'acme');
    const one = Math.max(...fs.readdirSync(dir).filter((n) => n.endsWith('.parquet')).map((n) => fs.statSync(path.join(dir, n)).size));
    storage.configure(DATA, t.s3, one + 1); // room for any one file, never two
    const before = cache.stats();
    ok('restart: the cache adopts the files on disk (oldest evicted to the cap)', before.files === 1 && before.bytes <= one + 1, JSON.stringify(before));
    await inOrg('acme', async () => {
      for (const id of [d1.id, d2.id, d1.id, d2.id]) { await datasets.residentSource(pid, id); await cache.settle(); }
    });
    const c = cache.stats();
    ok('LRU: alternating two tables in a one-file cache evicts, stays under the cap', c.evictions >= 2 && c.bytes <= one + 1 && c.fillErrors === 0, JSON.stringify(c));
    storage.configure(DATA, t.s3, 64 * 2 ** 20);
    cache.resetCounts();
    await inOrg('acme', async () => {
      for (let i = 0; i < 10; i++) { await datasets.residentSource(pid, d1.id); await cache.settle(); }
    });
    ok('a hot table: 1 miss then 9 hits', cache.stats().hits === 9 && cache.stats().misses === 1, JSON.stringify(cache.stats()));
  } finally {
    pool.shutdown();
  }

  // ── 6. the real app declares the GC job ────────────────────────────────────
  const appMod: typeof import('../src/server/app') = require('../src/server/app');
  const db = new URL(process.env.DATABASE_URL!);
  db.pathname = (await t.pool.query('SELECT current_database() AS d')).rows[0].d;
  const app = appMod.buildApp(envMod.parseEnv({ ...process.env, DATABASE_URL: db.toString(), DATA_DIR: DATA, LOG_LEVEL: 'silent' }));
  await app.ready();
  let rows: unknown[] = [];
  for (let i = 0; i < 50 && rows.length === 0; i++) {
    rows = (await t.pool.query("SELECT org_id FROM jobs WHERE kind = 'storage:gc' AND org_id = 'acme'")).rows;
    if (!rows.length) await new Promise((r) => setTimeout(r, 100));
  }
  ok('the server declares the storage:gc job for each org', rows.length === 1);
  await app.close();
}

(async () => {
  envChecks();
  const t = await s3Test.setup('s3');
  if (typeof t === 'string') {
    console.log(`skip MinIO checks: ${t}`);
    return;
  }
  try {
    await minio(t);
  } finally {
    await t.teardown();
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    (require('../src/engine/duckdb') as typeof import('../src/engine/duckdb')).shutdown();
    fs.rmSync(TMP, { recursive: true, force: true });
    finish();
  });
