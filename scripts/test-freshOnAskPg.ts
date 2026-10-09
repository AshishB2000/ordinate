// Fresh on ask against a real Postgres (docs/live-data/00-plan.md L3.1): the
// SOURCE is a Postgres table read through the postgres connector, the dataset
// records live in Postgres `records` and the cross-pod locks are Postgres
// advisory locks — the server's own wiring, over the RPC route.
//
//   1. A copy whose first refresh (the one that sets the mark) has not run is
//      never pulled on ask; `dataset:refresh` runs that full refresh.
//   2. Insert rows into the source table, make the copy stale, ask a chart and
//      two KPIs in one dashboard load → the new rows are in the answer, from
//      ONE incremental run with the cursor pushed to Postgres; never a second
//      full one (the run log), and the figure is not "refreshing".
//   3. FRESH_ON_ASK_WAIT_MS=0: the answer at once from the copy, refreshing;
//      the push when the rows land; the next ask shows them.
//   4. Another pod: its claim of the window held (advisory lock) → this pod
//      pulls nothing; its refresh running (the refresh lock held, the window
//      stamped) → this pod waits on the lock and answers fresh when it is let
//      go, or "refreshing" when the wait runs out first.
//   5. Measured: the added latency of a dashboard load on a fresh copy and on
//      a stale one, against the same load on a dataset without fresh on ask.
//
// Needs a Postgres it may CREATE DATABASE on; without DATABASE_URL it prints
// one `skip` line.
//
//   npm run build:ts && DATABASE_URL=postgres://… node scripts/test-freshOnAskPg.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const ADMIN: import('../src/server/context').Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    finish();
    return;
  }
  const context: typeof import('../src/server/context') = require('../src/server/context');
  const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
  const appMod: typeof import('../src/server/app') = require('../src/server/app');
  const envMod: typeof import('../src/server/env') = require('../src/server/env');
  const wire: typeof import('../src/server/wire') = require('../src/server/wire');
  const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
  const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
  const lock: typeof import('../src/server/jobs/refreshLock') = require('../src/server/jobs/refreshLock');
  const configSecrets: typeof import('../src/app/configSecrets') = require('../src/app/configSecrets');
  const schedules: typeof import('../src/server/jobs/schedules') = require('../src/server/jobs/schedules');
  const record: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
  const fresh: typeof import('../src/data/freshOnAsk') = require('../src/data/freshOnAsk');

  const dbName = `ordinate_l31_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  admin.on('error', () => undefined);
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 6 });
  pool.on('error', () => undefined); // an idle client dropped by teardown's DROP … FORCE is not a finding
  const src = new Client({ connectionString: scratch.toString() });
  src.on('error', () => undefined);
  const other = new Client({ connectionString: scratch.toString() }); // "another pod"'s session
  other.on('error', () => undefined);
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-freshpg-'));
  let app: ReturnType<typeof appMod.buildApp> | null = null;
  try {
    await src.connect();
    await other.connect();
    await src.query('create table public.src_orders (id integer primary key, updated_at timestamptz not null, region text, amount numeric(12,2))');
    await src.query(`insert into public.src_orders values (1, '2026-10-01T10:00:00Z', 'North', 10), (2, '2026-10-02T10:00:00Z', 'South', 20), (3, '2026-10-03T10:00:00Z', 'North', 30)`);
    let nextId = 4;
    const insert = async (region: string, amount: number): Promise<void> => {
      await src.query('insert into public.src_orders values ($1, now(), $2, $3)', [nextId++, region, amount]);
    };

    process.env.SSRF_ALLOW = '127.0.0.0/8,::1/128'; // the source is on this machine
    fs.mkdirSync(path.join(DATA, 'orgs', 'acme'), { recursive: true });
    context.enterServerMode(DATA);
    poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
    await mig.migrate(pool);
    recordFs.useRecordDb(pool);
    lock.useRefreshLockDb(pool);
    const kept = new Map<string, string>();
    configSecrets.useSecretStore({
      get: async (o, k, r) => kept.get(`${o}|${k}|${r}`) ?? null,
      put: async (o, k, r, v) => { kept.set(`${o}|${k}|${r}`, v); },
      delete: async (o, k, r) => kept.delete(`${o}|${k}|${r}`),
    });
    const pushes: string[] = [];
    schedules.pushToReaders = ((_p: string, channel: string, payload: unknown) => {
      if (channel === 'hub:dataset-refreshed') pushes.push((payload as { datasetId: string }).datasetId);
    }) as typeof schedules.pushToReaders;
    appMod.registerHandlers();
    const projects: typeof import('../src/app/projects') = require('../src/app/projects');
    const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
    const P = await context.runInContext(ADMIN, 'seed', async () => {
      await projects.init();
      return (await projects.createProject('Fresh on ask, Postgres')).id;
    });
    app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
    const srv = app;
    const post = async (channel: string, payload: unknown) => {
      const t = performance.now();
      const r = await srv.inject({
        method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`,
        headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }),
      });
      return { ms: performance.now() - t, status: r.statusCode, body: r.body, value: (r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body)) as any }; // any: each reply is narrowed by the check that reads it
    };
    const inOrg = <T>(fn: () => Promise<T>) => context.runInContext(ADMIN, 'test', fn);
    const meta = (d: string) => inOrg(() => datasets.getDatasetMeta(P, d));
    const stale = (id: string, at = new Date(Date.now() - 3_600_000).toISOString()) =>
      inOrg(() => record.serialized(record.datasetFilePath(P, id), (raw) => { raw.lastRefreshedAt = at; }));
    const pushed = async (id: string, n: number): Promise<boolean> => {
      for (const end = Date.now() + 10_000; Date.now() < end; await sleep(25)) if (pushes.filter((d) => d === id).length >= n) return true;
      return false;
    };

    const saved = await post('connection:testAndSave', {
      projectId: P, connectorId: 'postgres', name: 'App DB',
      values: { host: scratch.hostname, port: Number(scratch.port || 5432), database: dbName, user: decodeURIComponent(scratch.username), ssl: false },
      secrets: { password: decodeURIComponent(scratch.password) },
    });
    const connId = String(saved.value?.connection?.id ?? '');
    ok('a postgres connection to the source table saves', saved.value?.ok === true && !!connId, saved.body.slice(0, 300));
    const cursor = { enabled: true, cursorColumn: 'updated_at', keyColumn: 'id', lookback: 0, highWater: null, runsSinceFull: 0, log: [] };
    /** A copy of the source table with incremental refresh on (its first, full refresh not run yet), and fresh on ask at 5 min unless `plain`. */
    const copy = async (name: string, plain = false): Promise<string> => {
      const d = (await post('connection:import', { projectId: P, connId, name, table: 'public.src_orders', limit: 100_000 })).value?.dataset?.id as string;
      await inOrg(() => datasets.writeIncremental(P, d, () => cursor));
      if (!plain) {
        const r = await post('dataset:update', { projectId: P, datasetId: d, freshOnAsk: { maxStalenessSec: 300 } });
        if (r.value?.ok !== true) throw new Error(`freshOnAsk not set: ${r.body}`);
      }
      return d;
    };
    /** …with the full refresh that sets the mark run, as the person's first ↻ (or the schedule) does. */
    const marked = async (name: string, plain = false): Promise<string> => {
      const d = await copy(name, plain);
      const r = await post('dataset:refresh', { projectId: P, id: d });
      if (r.value?.ok !== true) throw new Error(`first refresh failed: ${r.body}`);
      return d;
    };
    /** What the source holds now: the KPIs' truth. */
    const truth = async () => {
      const r = await src.query<{ s: string; n: string }>('select sum(amount) as s, count(*) as n from public.src_orders');
      return { sum: Number(r.rows[0].s), count: Number(r.rows[0].n) };
    };
    const items = (d: string) => [
      { kind: 'visual', datasetId: d, encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] } },
      { kind: 'metric', datasetId: d, column: 'amount', aggregation: 'sum' },
      { kind: 'metric', datasetId: d, column: 'id', aggregation: 'count' },
    ];
    const load = (d: string) => post('analysis:tiles', { projectId: P, items: items(d) });
    const regions = (r: any) => Object.fromEntries(r.data.labels.map((l: string, i: number) => [l, r.data.series[0].values[i]])); // any: a visual:data reply
    const runs = async (d: string) => (await meta(d))?.incremental?.log ?? [];

    // ── 1. Before the mark: never pulled ────────────────────────────────────
    process.env.FRESH_ON_ASK_WAIT_MS = '5000';
    const id = await copy('Orders');
    ok('a copy of the source is imported (3 rows) with incremental refresh and fresh on ask on', (await meta(id))?.rowCount === 3 && (await meta(id))?.freshOnAsk?.maxStalenessSec === 300);
    await stale(id);
    await insert('East', 7);
    const first = await load(id);
    ok('before its first (full) refresh the copy is not pulled on ask: the old figures, no run logged',
      first.value[1]?.value === 60 && (await runs(id)).length === 0 && !first.value[1]?.asOf?.refreshing, first.body.slice(0, 300));
    const full = await post('dataset:refresh', { projectId: P, id });
    ok('dataset:refresh runs the full refresh that sets the mark', full.value?.ok === true && (await runs(id))[0]?.mode === 'full' && (await meta(id))?.rowCount === 4, full.body.slice(0, 200));

    // ── 2. Insert, ask, see them ─────────────────────────────────────────────
    await insert('South', 5);
    await insert('West', 11);
    await stale(id);
    const t2 = await load(id);
    const log2 = await runs(id);
    const want2 = await truth();
    ok('the new rows are in the chart (West appears, South grew)', JSON.stringify(regions(t2.value[0])) === '{"North":40,"South":25,"East":7,"West":11}', JSON.stringify(t2.value[0]?.data));
    ok(`…and in both KPIs (sum ${want2.sum}, ${want2.count} rows — the source's own count)`, t2.value[1]?.value === want2.sum && t2.value[2]?.value === want2.count, JSON.stringify(t2.value.slice(1)));
    ok('…from ONE incremental run, the cursor pushed to Postgres', log2[0]?.mode === 'incremental' && log2[0].how === 'server' && log2[0].inserted === 2 && log2.length === 2, JSON.stringify(log2));
    ok('…never a full one (the run log: one full — the mark — then incrementals only)', log2.filter((e) => e.mode === 'full').length === 1);
    ok('…dated now, not "refreshing"', t2.value.every((r: any) => r.asOf && !r.asOf.refreshing && Date.now() - Date.parse(r.asOf.at) < 60_000), JSON.stringify(t2.value.map((r: any) => r.asOf))); // any: tiles
    await insert('North', 3);
    await stale(id);
    const held = await load(id);
    ok('one pull per window: the same copy made stale again inside the window is not pulled again', (await runs(id)).length === 2 && held.value[1]?.value === want2.sum, JSON.stringify(held.value[1]));

    // ── 3. Answer at once, redraw on the push ───────────────────────────────
    process.env.FRESH_ON_ASK_WAIT_MS = '0';
    const quick = await marked('Orders (wait 0)');
    const before3 = await truth();
    await insert('North', 100);
    await stale(quick);
    const pushesBefore = pushes.filter((d) => d === quick).length; // its first ↻ was announced too
    const t3 = await load(quick);
    ok('wait 0: answered from the copy at once, "refreshing"', t3.value[1]?.value === before3.sum && t3.value.every((r: any) => r.asOf?.refreshing === true), JSON.stringify(t3.value.map((r: any) => [r.value, r.asOf]))); // any: tiles
    ok('wait 0: the push arrives when the rows land', await pushed(quick, pushesBefore + 1));
    const t3b = await load(quick);
    ok('wait 0: the next ask shows them', t3b.value[1]?.value === (await truth()).sum && !t3b.value[1]?.asOf?.refreshing, JSON.stringify(t3b.value[1]));

    // ── 4. Another pod ───────────────────────────────────────────────────────
    process.env.FRESH_ON_ASK_WAIT_MS = '1500';
    const shared = await marked('Orders (two pods)');
    const before4 = await truth();
    await insert('East', 1);
    await stale(shared);
    const claimKey = lock.lockKey('acme', fresh.CLAIM_PREFIX + shared);
    await other.query('SELECT pg_advisory_lock(hashtext($1))', [claimKey]);
    const claimed = await load(shared);
    await other.query('SELECT pg_advisory_unlock(hashtext($1))', [claimKey]);
    ok('another pod holding this window\'s claim → this pod pulls nothing (and nothing is refreshing)',
      (await runs(shared)).length === 1 && claimed.value[1]?.value === before4.sum && !claimed.value[1]?.asOf?.refreshing, JSON.stringify(claimed.value[1]));
    // That pod claimed the window and is refreshing: the stamp is recent and the refresh lock is held.
    const stampNow = () => inOrg(() => record.serialized(record.datasetFilePath(P, shared), (raw) => {
      (raw.freshOnAsk as Record<string, unknown>).triggeredAt = new Date().toISOString();
    }));
    await stampNow();
    await other.query('SELECT pg_advisory_lock(hashtext($1))', [lock.lockKey('acme', shared)]);
    const landing = (async () => {
      await sleep(400); // the other pod's refresh lands: its markers, then the lock let go
      await stale(shared, new Date().toISOString());
      await other.query('SELECT pg_advisory_unlock(hashtext($1))', [lock.lockKey('acme', shared)]);
    })();
    const waited = await load(shared);
    await landing;
    ok('another pod refreshing → this pod waits on its lock and answers when it lets go, not refreshing',
      (await runs(shared)).length === 1 && waited.ms >= 350 && waited.ms < 1500 && !waited.value[1]?.asOf?.refreshing, `${waited.ms.toFixed(0)} ms`);
    await stale(shared);
    await stampNow();
    await other.query('SELECT pg_advisory_lock(hashtext($1))', [lock.lockKey('acme', shared)]);
    const outlasted = await load(shared);
    await other.query('SELECT pg_advisory_unlock(hashtext($1))', [lock.lockKey('acme', shared)]);
    ok('…and says "refreshing" when that refresh outlasts the wait', outlasted.value.every((r: any) => r.asOf?.refreshing === true) && outlasted.ms >= 1400, `${outlasted.ms.toFixed(0)} ms`); // any: tiles

    // ── 5. Measured ──────────────────────────────────────────────────────────
    process.env.FRESH_ON_ASK_WAIT_MS = '5000';
    const base = await marked('Orders (no fresh on ask)', true);
    const warm = await marked('Orders (measured, fresh)');
    for (let i = 0; i < 3; i++) await load(base);
    for (let i = 0; i < 3; i++) await load(warm);
    const baseMs: number[] = [];
    const freshMs: number[] = [];
    for (let i = 0; i < 15; i++) {
      baseMs.push((await load(base)).ms);
      freshMs.push((await load(warm)).ms);
    }
    const staleMs: number[] = [];
    let pulledEach = true;
    for (let i = 0; i < 7; i++) {
      const d = await marked(`Orders (measured, stale ${i + 1})`); // a pull is once per window per dataset
      await insert('South', 1);
      await stale(d);
      const r = await load(d);
      staleMs.push(r.ms);
      const log = await runs(d);
      if (log.length !== 2 || log[0].mode !== 'incremental' || r.value[1]?.value !== (await truth()).sum || r.value[1]?.asOf?.refreshing) pulledEach = false;
    }
    ok('measured: each stale load ran exactly one incremental pull and answered with the source\'s figures', pulledEach);
    console.log(`     a dashboard load of 3 tiles, records in Postgres, median of 15: no fresh on ask ${median(baseMs).toFixed(1)} ms; `
      + `fresh on ask on a fresh copy ${median(freshMs).toFixed(1)} ms`);
    console.log(`     …on a stale copy (one incremental pull from the Postgres source, waited for), median of 7: ${median(staleMs).toFixed(1)} ms `
      + `(min ${Math.min(...staleMs).toFixed(1)}, max ${Math.max(...staleMs).toFixed(1)})`);
  } finally {
    await app?.close();
    lock.useRefreshLockDb(null);
    recordFs.useRecordDb(null);
    await src.end().catch(() => undefined);
    await other.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
