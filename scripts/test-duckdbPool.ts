// Self-check for T4.3 — per-org DuckDB workers (src/engine/duckdbPool.ts).
//
// 1. ENV: the pool's limits are read and validated like every other variable.
// 2. ISOLATION, inside the worker: org A's worker reads A's Parquet and REFUSES
//    org B's file, a sibling org whose id starts with A's (`a` vs `ab`), a `..`
//    escape, /etc/passwd (read_text, read_csv, glob), COPY TO B, ATTACH, LOAD,
//    and every SET that would undo the lock. Negative control: the same files
//    read fine through an unlocked DuckDB, so a refusal is the lock, not a
//    missing file.
// 3. ROUTING by ctx(): a view made in org A is invisible to org B; a per-run
//    relation runs in the caller's worker; a compute-pool op's queries go down
//    its leased port to the caller's org worker (B's file is refused there —
//    a thread-local DuckDB would have read it).
// 4. STOPPING: a query past the timeout is interrupted and the SAME worker
//    answers next; an aborted request interrupts its query; a cancelled queued
//    call never runs; a compute thread terminated mid-query (a job cancel)
//    interrupts its query in the org worker.
// 5. LIMITS: LRU eviction past maxWorkers, idle eviction, the readiness probe.
//
//   npm run build:ts && node scripts/test-duckdbPool.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { Worker }: typeof import('worker_threads') = require('worker_threads');

const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');
const context: typeof import('../src/server/context') = require('../src/server/context');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const computePool: typeof import('../src/engine/computePool') = require('../src/engine/computePool');
const dv: typeof import('../src/engine/datasetView') = require('../src/engine/datasetView');
const rq: typeof import('../src/engine/residentQuery') = require('../src/engine/residentQuery');
const statsSpec: typeof import('../src/analysis/stats/spec') = require('../src/analysis/stats/spec');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-pool-'));
const fileOf = (org: string, name = 't.parquet'): string => path.join(DATA, 'orgs', org, 'userData', name);
const LONG = 'SELECT count(*) AS n FROM range(10000000000) t(x) WHERE x % 7 = 3';
const who = (org: string): import('../src/server/context').Identity => ({ user: { email: `u@${org}`, role: 'admin' }, org: { id: org } });
const inOrg = <T>(org: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> =>
  context.runInContext(who(org), 'r', fn, undefined, signal);
const q = (sql: string): Promise<import('../src/engine/duckdb').DuckRow[]> => duck.queryAsync(sql);

/** The rejection's message, or 'RESOLVED' — refusals must come from DuckDB itself. */
async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'RESOLVED';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
const isPermission = (m: string): boolean => /Permission Error|disabled by configuration|configuration has been locked/.test(m);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'RESOLVED';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

function envChecks(): void {
  const d = envMod.parseEnv({}).duckdb;
  ok('env: defaults — 8 workers, 60 s timeout, 300 s idle, threads ≥ 1, memory in MiB',
    d.maxWorkers === 8 && d.queryTimeoutMs === 60_000 && d.idleMs === 300_000 && d.threads >= 1 && /^\d+MiB$/.test(d.memoryLimit), JSON.stringify(d));
  const s = envMod.parseEnv({ DUCKDB_MAX_WORKERS: '3', DUCKDB_MEMORY_LIMIT: '2GB', DUCKDB_THREADS: '2', DUCKDB_QUERY_TIMEOUT_SECONDS: '5', DUCKDB_IDLE_SECONDS: '9' }).duckdb;
  ok('env: set values are read', s.maxWorkers === 3 && s.memoryLimit === '2GB' && s.threads === 2 && s.queryTimeoutMs === 5000 && s.idleMs === 9000, JSON.stringify(s));
  for (const [name, bad] of [
    ['DUCKDB_MEMORY_LIMIT', "2GB'; SET enable_external_access=true; --"], ['DUCKDB_MEMORY_LIMIT', 'lots'], ['DUCKDB_MEMORY_LIMIT', '2GB\n'],
    ['DUCKDB_MAX_WORKERS', '0'], ['DUCKDB_THREADS', '-1'], ['DUCKDB_QUERY_TIMEOUT_SECONDS', 'abc'], ['DUCKDB_IDLE_SECONDS', '1.5'],
  ]) {
    let msg = '';
    try { envMod.parseEnv({ [name]: bad }); } catch (err) { msg = err instanceof envMod.EnvError ? err.message : 'wrong error'; }
    ok(`env: ${name}=${JSON.stringify(bad)} is refused, naming the variable`, msg.startsWith(name), msg);
  }
}

async function main(): Promise<void> {
  envChecks();

  // ── Fixtures, written through an UNLOCKED DuckDB (the desktop bridge) ──────
  for (const org of ['a', 'ab', 'b']) {
    fs.mkdirSync(path.dirname(fileOf(org)), { recursive: true });
    await duck.execAsync(`COPY (SELECT (range * 10)::VARCHAR AS c0 FROM range(5)) TO '${fileOf(org)}' (FORMAT PARQUET);`);
  }
  const control = await q(`SELECT count(*)::DOUBLE AS n FROM read_parquet('${fileOf('b')}')`);
  ok('negative control: an unlocked DuckDB reads org B\'s file (so a refusal below is the lock)', control[0].n === 5);
  const passwd = await refused(q("SELECT count(*) FROM read_text('/etc/passwd')"));
  ok('negative control: an unlocked DuckDB reads /etc/passwd', passwd === 'RESOLVED', passwd);
  duck.shutdown();

  // ── Server mode, routed ────────────────────────────────────────────────────
  context.enterServerMode(DATA);
  const cfg = { dataDir: DATA, maxWorkers: 8, memoryLimit: '256MiB', threads: 2, queryTimeoutMs: 600, idleMs: 60_000 };
  const pool = poolMod.routeByOrg(cfg);
  ok('routed: isAvailable() answers without starting a worker', duck.isAvailable() === true && pool.orgs().length === 0);
  ok('routed: a sync call throws even off the main-thread guard', (await codeOf(Promise.resolve().then(() => duck.query('SELECT 1')))) === 'sync');
  ok('routed: a call outside a request rejects (no org to act for)', (await refused(q('SELECT 1'))) !== 'RESOLVED');
  ok('readiness probe answers true', (await pool.probe()) === true);

  // ── 2. Isolation inside org A's worker ─────────────────────────────────────
  await inOrg('a', async () => {
    ok('org A reads its own Parquet', (await q(`SELECT count(*)::DOUBLE AS n FROM read_parquet('${fileOf('a')}')`))[0].n === 5);
    const cases: Array<[string, string]> = [
      ["org B's Parquet", `SELECT * FROM read_parquet('${fileOf('b')}')`],
      ["sibling org 'ab' (prefix of the path)", `SELECT * FROM read_parquet('${fileOf('ab')}')`],
      ['a .. escape to org B', `SELECT * FROM read_parquet('${path.join(DATA, 'orgs', 'a', '..', 'b', 'userData', 't.parquet')}')`],
      ['/etc/passwd via read_text', "SELECT * FROM read_text('/etc/passwd')"],
      ['/etc/passwd via read_csv', "SELECT * FROM read_csv('/etc/passwd')"],
      ['glob over org B', `SELECT * FROM glob('${path.join(DATA, 'orgs', 'b')}/**')`],
      ['COPY TO org B', `COPY (SELECT 1 AS x) TO '${fileOf('b', 'planted.parquet')}' (FORMAT PARQUET)`],
      ['ATTACH a file in org B', `ATTACH '${fileOf('b', 'x.duckdb')}' AS x`],
      ['LOAD an extension', 'LOAD httpfs'],
      ['SET allowed_directories back to /', "SET allowed_directories=['/']"],
      ['SET enable_external_access=true', 'SET enable_external_access=true'],
      ['SET memory_limit higher', "SET memory_limit='64GB'"],
    ];
    for (const [label, sql] of cases) {
      const m = await refused(q(sql));
      ok(`org A's worker refuses ${label}`, isPermission(m), m.slice(0, 160));
    }
    ok('…and nothing was planted in org B', !fs.existsSync(fileOf('b', 'planted.parquet')));
    await duck.execAsync(`COPY (SELECT 1 AS x) TO '${fileOf('a', 'written.parquet')}' (FORMAT PARQUET)`);
    ok('org A writes inside its own root (parquetStore\'s temp-then-rename still works)', fs.existsSync(fileOf('a', 'written.parquet')));
    const set = (await q("SELECT current_setting('memory_limit') AS m, current_setting('threads')::DOUBLE AS t"))[0];
    ok(`limits applied: memory_limit ${set.m}, threads ${set.t}`, String(set.m).includes('MiB') && set.t === 2, JSON.stringify(set));
  });
  await inOrg('b', async () => {
    ok('org B reads its own Parquet', (await q(`SELECT count(*)::DOUBLE AS n FROM read_parquet('${fileOf('b')}')`))[0].n === 5);
    ok("org B's worker refuses org A's Parquet", isPermission(await refused(q(`SELECT * FROM read_parquet('${fileOf('a')}')`))));
  });

  // ── 3. Views, relations and compute ops stay with their org ───────────────
  const columns = [{ name: 'c0', type: 'number' as const }];
  ok('a view is created in org A', await inOrg('a', () => dv.ensureView({ name: 'ds_pool_view', parquetPath: fileOf('a'), columns })));
  ok('…org A reads it', (await inOrg('a', () => q('SELECT sum(c0)::DOUBLE AS s FROM ds_pool_view')))[0].s === 100);
  const viewB = await inOrg('b', () => refused(q('SELECT * FROM ds_pool_view')));
  ok("…org B's worker has no such view", /does not exist|not found/i.test(viewB), viewB.slice(0, 120));
  const rel = `(SELECT row_number() OVER () AS __ord, * FROM read_parquet('${fileOf('a')}'))`;
  const viaRel = (): Promise<import('../src/engine/duckdb').DuckRow[]> =>
    rq.withRelationAsync('join-key', rel, () => q(`SELECT count(*)::DOUBLE AS n FROM ${rq.plainFrom('join-key')}`));
  ok('a per-run relation runs in the caller\'s worker (org A: 5 rows)', (await inOrg('a', viaRel))[0].n === 5);
  ok('…the same relation from org B is refused in B\'s worker', isPermission(await inOrg('b', () => refused(viaRel()))));

  const spec = statsSpec.sanitizeStatsSpec({ kind: 'distribution', datasetId: '00000000-0000-4000-8000-000000000000', columns: ['c0'] });
  const need = spec && statsSpec.vectorNeeds(spec, columns);
  if (!spec || !need || 'error' in need) {
    ok('stats spec fixture', false);
  } else {
    const run = (file: string): Promise<unknown> =>
      computePool.run('stats', { src: { parquetPath: file, columns }, spec, needs: need.needs, filters: [] });
    const own = (await inOrg('a', () => run(fileOf('a')))) as { ok?: boolean } | null;
    ok('compute op in org A answers off its own Parquet (through the leased port)', !!own && own.ok === true, JSON.stringify(own).slice(0, 200));
    const other = await inOrg('a', () => run(fileOf('b')));
    ok("compute op in org A cannot read org B's Parquet (the thread has no DuckDB of its own)", other === null, JSON.stringify(other).slice(0, 200));
    ok('compute op outside a request is refused (no org to lease for)', (await refused(run(fileOf('a')))) !== 'RESOLVED');
  }

  // ── 4. Timeout, cancel, queued cancel, compute-thread death ───────────────
  await inOrg('a', async () => {
    await duck.execAsync('CREATE OR REPLACE TABLE marker AS SELECT 1 AS x');
    let t0 = Date.now();
    const code = await codeOf(q(LONG));
    const took = Date.now() - t0;
    ok(`a query past the 600 ms limit rejects 'timeout' (${took} ms)`, code === 'timeout' && took < 3000, code);
    t0 = Date.now();
    const after = await q('SELECT count(*)::DOUBLE AS n FROM marker');
    ok(`…and the SAME worker answers next (marker table still there, ${Date.now() - t0} ms)`, after[0].n === 1 && Date.now() - t0 < 1000);
  });

  const ac = new AbortController();
  let t0 = Date.now();
  const cancelled = inOrg('a', () => codeOf(q(LONG)), ac.signal);
  setTimeout(() => ac.abort(), 150);
  const cCode = await cancelled;
  ok(`an aborted request rejects 'cancelled' at once (${Date.now() - t0} ms)`, cCode === 'cancelled' && Date.now() - t0 < 500, cCode);
  t0 = Date.now();
  await inOrg('a', () => q('SELECT 1 AS x'));
  ok(`…its query was interrupted: the next one answers in ${Date.now() - t0} ms`, Date.now() - t0 < 300);

  const first = new AbortController();
  const second = new AbortController();
  const running = inOrg('a', () => codeOf(q(LONG)), first.signal);
  const queued = inOrg('a', () => codeOf(duck.execAsync('CREATE TABLE never_made AS SELECT 1 AS x')), second.signal);
  await new Promise((r) => setTimeout(r, 50));
  second.abort();
  first.abort();
  ok('a queued call cancelled before its turn rejects cancelled', (await queued) === 'cancelled' && (await running) === 'cancelled');
  const never = await inOrg('a', () => refused(q('SELECT * FROM never_made')));
  ok('…and never ran (its table does not exist)', /does not exist|not found/i.test(never), never.slice(0, 120));

  // A compute thread killed mid-query (computePool's cancel terminates it): the
  // port closes and the org worker interrupts what that port was running.
  const lease = inOrg('a', async () => pool.lease('a'));
  const l = await lease;
  const clientJs = require.resolve('../src/engine/duckdbClient');
  const w = new Worker(
    `const { parentPort, workerData } = require('worker_threads'); const { DuckClient } = require(${JSON.stringify(clientJs)});` +
      `const c = new DuckClient(workerData.port, 60000); parentPort.postMessage('started'); c.call('query', ${JSON.stringify(LONG)}, []).catch(() => {});`,
    { eval: true, workerData: { port: l.port }, transferList: [l.port] },
  );
  await new Promise((r) => w.once('message', r));
  await new Promise((r) => setTimeout(r, 150));
  await w.terminate();
  l.release();
  t0 = Date.now();
  await inOrg('a', () => q('SELECT 1 AS x'));
  ok(`a terminated compute thread's query is interrupted: the org answers in ${Date.now() - t0} ms`, Date.now() - t0 < 1000);

  // ── 5. Limits ───────────────────────────────────────────────────────────────
  const small = new poolMod.DuckPool({ ...cfg, maxWorkers: 2, idleMs: 300 });
  await small.call('a', 'query', 'SELECT 1', []);
  await small.call('b', 'query', 'SELECT 1', []);
  await small.call('a', 'query', 'SELECT 1', []);
  await small.call('ab', 'query', 'SELECT 1', []);
  ok('LRU: past maxWorkers the least recently used idle org is closed', JSON.stringify(small.orgs()) === '["a","ab"]', JSON.stringify(small.orgs()));
  const reopened = await small.call('b', 'query', `SELECT count(*)::DOUBLE AS n FROM read_parquet('${fileOf('b')}')`, []);
  ok('…and a closed org gets a fresh, still-locked worker', JSON.parse(reopened).rows[0][0] === 5
    && isPermission(await refused(small.call('b', 'query', `SELECT * FROM read_parquet('${fileOf('a')}')`, []))));
  await new Promise((r) => setTimeout(r, 900));
  ok('idle workers are closed after idleMs', small.orgs().length === 0, JSON.stringify(small.orgs()));
  ok('an invalid org id never reaches a path', (await refused(small.call('../x', 'query', 'SELECT 1', []))) === 'invalid org id');
  small.shutdown();

  // ── 6. Over real HTTP: a caller that goes away mid-query ──────────────────
  // app.ts aborts the request's signal when the socket closes before the reply;
  // the query is interrupted in the org worker. A long time limit here, so only
  // the abort can explain a prompt next answer.
  duck.shutdown();
  poolMod.routeByOrg({ ...cfg, queryTimeoutMs: 60_000 });
  const appMod: typeof import('../src/server/app') = require('../src/server/app');
  const wire: typeof import('../src/server/wire') = require('../src/server/wire');
  const { contracts }: typeof import('../src/api/index') = require('../src/api/index');
  const { rpc }: typeof import('../src/api/contract') = require('../src/api/contract');
  const { z }: typeof import('zod') = require('zod');
  (contracts as Record<string, unknown>)['test:slow'] = rpc({ access: 'read', org: true, input: z.undefined() });
  (require('../src/ipc/bus') as typeof import('../src/ipc/bus')).ipcMain.handle('test:slow', () => duck.queryAsync(LONG));
  const app = appMod.buildApp(envMod.parseEnv({ LOG_LEVEL: 'silent', DATA_DIR: DATA })); // dev sign-in: org `default`
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as import('net').AddressInfo;
  const gone = new AbortController();
  const slow = fetch(`http://127.0.0.1:${port}/api/rpc/test:slow`, {
    method: 'POST', body: wire.encode({ args: [] }), headers: withCsrf({ 'content-type': 'application/json' }), signal: gone.signal,
  }).catch(() => null);
  await new Promise((r) => setTimeout(r, 300));
  gone.abort();
  await slow;
  t0 = Date.now();
  await inOrg('default', () => q('SELECT 1 AS x'));
  ok(`HTTP: a client that hangs up mid-query has it interrupted — the org answers next in ${Date.now() - t0} ms`, Date.now() - t0 < 1000);
  await app.close();
}

main()
  .catch((err) => ok('threw: ' + String(err && (err as Error).stack), false))
  .finally(() => {
    duck.shutdown();
    void computePool.shutdown().finally(() => {
      try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* best effort */ }
      finish();
    });
  });
