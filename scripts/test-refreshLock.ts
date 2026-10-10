// One refresh of a dataset at a time, ACROSS PODS (L0.4) — the advisory lock
// in src/server/jobs/refreshLock.ts and the doors that use it
// (src/data/refreshJob.ts).
//
//   1. No Postgres: the lock is off — `withRefreshLock` just runs, nothing is
//      "held" — and the in-process guards are the whole story.
//   2. Two pools on a scratch database, each behind its OWN copy of the module
//      (two pods' worth of state in one process): 20 rounds of both pods
//      refreshing one dataset at the same instant → exactly one runs, every
//      round; the lock is released after success AND after a throw; the
//      pg_locks probe sees another pod's lock (for a negative and a positive
//      hashtext); another dataset and another org's same id are not blocked;
//      a lock connection killed mid-refresh neither crashes the process nor
//      leaks the lock. NEGATIVE CONTROL: with the lock off on both, both run.
//   3. The doors: with another session holding the lock, `startRefresh` says
//      already_running and starts nothing, and a ↻ job coalesces — it ends
//      `done`, `alreadyRunning`, the dataset untouched. Released: both run.
//   4. Two REAL server processes (scripts/refreshLockPodPreload.ts holds each
//      refresh 2.5 s) asked to refresh the same dataset at once over RPC:
//      exactly one refresh runs, the other pod answers alreadyRunning; again
//      when the refresh fails, after which the lock is free. NEGATIVE CONTROL:
//      two pods with the lock switched off both run it.
//
// The DB half needs a Postgres it may CREATE DATABASE on. Without DATABASE_URL
// it prints one `skip` line and runs only the no-DB checks.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-refreshLock.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Client, Pool } from 'pg';

type LockMod = typeof import('../src/server/jobs/refreshLock');
type Identity = import('../src/server/context').Identity;

const context: typeof import('../src/server/context') = require('../src/server/context');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const LOCK_PATH = require.resolve('../src/server/jobs/refreshLock');
const lockA: LockMod = require('../src/server/jobs/refreshLock'); // the app's own copy: pod A
const refreshJob: typeof import('../src/data/refreshJob') = require('../src/data/refreshJob');

/** A second, independent copy of the lock module: pod B's state (its own pool). */
function freshLockModule(): LockMod {
  const keep = require.cache[LOCK_PATH];
  delete require.cache[LOCK_PATH];
  const mod = require(LOCK_PATH) as LockMod;
  require.cache[LOCK_PATH] = keep; // the app keeps pod A's copy
  return mod;
}

const MAIN = path.join(__dirname, '..', 'src', 'server', 'main.js');
const PRELOAD = path.join(__dirname, 'refreshLockPodPreload.js');
const SLOW_MS = 2500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const who = (org: string): Identity => ({ user: { email: 'dev@local', role: 'admin' }, org: { id: org } });
const inOrg = <T>(org: string, fn: () => Promise<T>): Promise<T> => context.runInContext(who(org), 'test', fn);

/** A refresh that holds `ms`, counting how many are inside at once. */
function probeRun() {
  let inside = 0;
  let max = 0;
  let runs = 0;
  return {
    run: (ms: number, fail = false) => async (): Promise<string> => {
      inside++;
      runs++;
      max = Math.max(max, inside);
      try {
        await sleep(ms);
        if (fail) throw new Error('refresh failed on purpose');
        return 'refreshed';
      } finally {
        inside--;
      }
    },
    get runs() { return runs; },
    get max() { return max; },
    reset() { runs = 0; max = 0; },
  };
}

// ── Pods ──────────────────────────────────────────────────────────────────────

interface Pod { child: ChildProcess; out: () => string; base: Promise<string | null>; exited: Promise<number | null> }

function startPod(env: Record<string, string>): Pod {
  const e: NodeJS.ProcessEnv = { ...process.env, ...env, PORT: '0', ORDINATE_ENV: 'dev', AUTH_MODE: 'dev', LOG_LEVEL: 'info' };
  const child = spawn(process.execPath, ['-r', PRELOAD, MAIN], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const base = new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 30_000);
    const onData = (c: Buffer): void => {
      out += c.toString();
      const m = /"msg":"Server listening at (http:\/\/[^"]+)"/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    void exited.then(() => resolve(null));
  });
  return { child, out: () => out, base, exited };
}

/** POST an RPC to a pod as the dev user, the way the web client does. */
function rpc(base: string, channel: string, payload: unknown): Promise<{ status: number; value: any }> { // any: the reply, read field by field
  const u = new URL(base);
  const body = wire.encode({ args: [payload] });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: Number(u.port), method: 'POST', path: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json', origin: base, 'content-length': String(Buffer.byteLength(body)) }),
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, value: res.statusCode === 200 ? wire.decode(text) : text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

interface Line { pod: number; at: number; kind: string; id: string; ok?: boolean }
const readProbe = (file: string): Line[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line) : [];

(async () => {
  // ── 1. No Postgres ─────────────────────────────────────────────────────────
  ok('no DB: the cross-pod lock is off', !lockA.refreshLockOn());
  const solo = await inOrg('default', () => lockA.withRefreshLock('d1', async () => 42));
  ok('no DB: withRefreshLock just runs', solo.ran === true && solo.ran && solo.value === 42);
  ok('no DB: nothing is ever "held" elsewhere', (await inOrg('default', () => lockA.refreshLockHeld('d1'))) === false);
  ok('the key is org, then dataset', lockA.lockKey('acme', 'd-1') === 'acme:d-1');

  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }

  const dbName = `ordinate_l04_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const mkPool = (): Pool => {
    const p = new Pool({ connectionString: scratch.toString(), max: 4 });
    p.on('error', () => undefined); // an idle client dropped by teardown's DROP … FORCE is not a finding
    return p;
  };
  const poolA = mkPool();
  const poolB = mkPool();
  const watch = mkPool();
  const pods: Pod[] = [];
  const allPods: Pod[] = [];
  // Advisory locks in THIS scratch database only: other suites (live_usage's admission lock,
  // test-liveUsage-db) and other runs share the server, and their locks are not this test's.
  const OWN_ADVISORY = `locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
  const advisory = async (): Promise<number> =>
    Number((await watch.query<{ n: string }>(`SELECT count(*) AS n FROM pg_locks WHERE ${OWN_ADVISORY}`)).rows[0].n);
  try {
    const lockB = freshLockModule();
    ok('two module copies: two pods\' state', lockB !== lockA);
    lockA.useRefreshLockDb(poolA);
    lockB.useRefreshLockDb(poolB);
    ok('with a pool the lock is on', lockA.refreshLockOn() && lockB.refreshLockOn());

    // ── 2. The lock itself ──────────────────────────────────────────────────
    const DS = '3f0c8a52-6b1e-4d2a-9f7e-0a1b2c3d4e5f';
    const p = probeRun();
    const lockMs: number[] = [];
    let onceEach = true;
    for (let round = 0; round < 20; round++) {
      const before = p.runs;
      const t = performance.now();
      const [a, b] = await Promise.all([
        inOrg('default', () => lockA.withRefreshLock(DS, p.run(40))),
        inOrg('default', () => lockB.withRefreshLock(DS, p.run(40))),
      ]);
      lockMs.push(performance.now() - t - 40);
      if (p.runs - before !== 1 || a.ran === b.ran || (await advisory()) !== 0) onceEach = false;
    }
    ok('race: 20 rounds of both pods at once → exactly one refresh each round, the lock released after each', onceEach && p.runs === 20 && p.max === 1,
      `runs ${p.runs}, max at once ${p.max}`);
    const sorted = [...lockMs].sort((x, y) => x - y);
    console.log(`     lock + unlock overhead per refresh (two pods racing): median ${sorted[10].toFixed(1)} ms, max ${sorted[19].toFixed(1)} ms`);

    let threw = '';
    try {
      await inOrg('default', () => lockA.withRefreshLock(DS, p.run(5, true)));
    } catch (err) {
      threw = (err as Error).message;
    }
    ok('failure: the refresh\'s own error passes through', threw === 'refresh failed on purpose');
    ok('failure: …and the lock is released (pg_locks empty)', (await advisory()) === 0);
    ok('failure: …so the other pod can refresh at once', (await inOrg('default', () => lockB.withRefreshLock(DS, async () => 'next'))).ran === true);

    // The probe, for a key whose hashtext is negative and one whose is positive.
    const signs = new Map<string, string>();
    for (let i = 0; signs.size < 2 && i < 200; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const h = (await watch.query<{ h: number }>('SELECT hashtext($1) AS h', [lockA.lockKey('default', id)])).rows[0].h;
      signs.set(h < 0 ? 'negative' : 'positive', signs.get(h < 0 ? 'negative' : 'positive') ?? id);
    }
    for (const [sign, id] of signs) {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const holding = inOrg('default', () => lockA.withRefreshLock(id, () => gate));
      await sleep(50);
      ok(`probe (${sign} hashtext): the other pod sees the lock held`, (await inOrg('default', () => lockB.refreshLockHeld(id))) === true);
      ok(`probe (${sign} hashtext): asking did not take it — the holder is still the only one`, (await advisory()) === 1);
      const other = await inOrg('default', () => lockB.withRefreshLock(id, async () => 'ran'));
      ok(`probe (${sign} hashtext): and its refresh coalesces`, other.ran === false);
      release();
      await holding;
      ok(`probe (${sign} hashtext): released → not held`, (await inOrg('default', () => lockB.refreshLockHeld(id))) === false);
    }

    // Scope: another dataset, and the same id in another org (an import repeats ids).
    {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const holding = inOrg('default', () => lockA.withRefreshLock(DS, () => gate));
      await sleep(50);
      const OTHER = '9c1d2e3f-4a5b-4c6d-8e7f-001122334455';
      const [hDs, hOther] = (await watch.query<{ a: number; b: number }>('SELECT hashtext($1) AS a, hashtext($2) AS b',
        [lockA.lockKey('default', DS), lockA.lockKey('default', OTHER)])).rows.map((r) => [r.a, r.b])[0];
      ok('scope: another dataset is not blocked (distinct hashtext)', hDs !== hOther
        && (await inOrg('default', () => lockB.withRefreshLock(OTHER, async () => 1))).ran === true);
      ok('scope: the same dataset id in ANOTHER org is not blocked', (await inOrg('orgx', () => lockB.withRefreshLock(DS, async () => 1))).ran === true);
      ok('scope (control): the same org and id is', (await inOrg('default', () => lockB.withRefreshLock(DS, async () => 1))).ran === false);
      release();
      await holding;
    }

    // A lock connection killed mid-refresh (a database restart): no crash, no leak.
    {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const holding = inOrg('default', () => lockA.withRefreshLock(DS, () => gate.then(() => 'landed')));
      await sleep(50);
      const pid = (await watch.query<{ pid: number }>(`SELECT pid FROM pg_locks WHERE ${OWN_ADVISORY}`)).rows[0]?.pid;
      await watch.query('SELECT pg_terminate_backend($1)', [pid]);
      await sleep(100);
      ok('killed: the lock went with its session', (await advisory()) === 0);
      release();
      const r = await holding;
      ok('killed: the refresh still finished, and the process is alive', r.ran === true && r.ran && r.value === 'landed');
      ok('killed: the dead client was not returned to the pool', poolA.totalCount === poolA.idleCount);
      ok('killed: …and the next refresh takes the lock normally', (await inOrg('default', () => lockA.withRefreshLock(DS, async () => 1))).ran === true
        && (await advisory()) === 0);
    }
    ok('no client is left checked out on either pool', poolA.totalCount === poolA.idleCount && poolB.totalCount === poolB.idleCount);

    // NEGATIVE CONTROL: the same race with the lock off on both pods.
    lockA.useRefreshLockDb(null);
    lockB.useRefreshLockDb(null);
    p.reset();
    const both = await Promise.all([
      inOrg('default', () => lockA.withRefreshLock(DS, p.run(40))),
      inOrg('default', () => lockB.withRefreshLock(DS, p.run(40))),
    ]);
    ok('negative control: without the lock both pods refresh, at the same time', both.every((r) => r.ran) && p.runs === 2 && p.max === 2,
      `runs ${p.runs}, max ${p.max}`);
    lockA.useRefreshLockDb(poolA);
    lockB.useRefreshLockDb(poolB);

    // ── 3. The doors, with another pod (a raw session) holding the lock ───────
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-l04-'));
    fs.mkdirSync(path.join(data, 'orgs', 'default'), { recursive: true });
    context.enterServerMode(data);
    await mig.migrate(poolA);
    (require('../src/app/recordFs') as typeof import('../src/app/recordFs')).useRecordDb(poolA);
    const projects: typeof import('../src/app/projects') = require('../src/app/projects');
    const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
    const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');
    const cols = [{ name: 'region', type: 'text' as const }, { name: 'revenue', type: 'number' as const }];
    const fx = await inOrg('default', async () => {
      const proj = await projects.createProject('Locked');
      const left = await datasets.saveDataset(proj.id, { name: 'North', sourceKind: 'csv', columns: cols, rows: [['north', 10]] });
      const right = await datasets.saveDataset(proj.id, { name: 'Others', sourceKind: 'csv', columns: cols, rows: [['south', 20]] });
      const d = await datasets.saveDataset(proj.id, {
        name: 'Combined', sourceKind: 'combined', columns: cols, rows: [['north', 10]],
        origin: { kind: 'combined', leftId: left!.id, rightId: right!.id, mode: 'append' },
      });
      return { projectId: proj.id, id: d!.id };
    });
    const rows = async () => (await inOrg('default', () => datasets.getDatasetMeta(fx.projectId, fx.id)))?.rowCount;
    const other = new Client({ connectionString: scratch.toString() });
    await other.connect();
    await other.query('SELECT pg_advisory_lock(hashtext($1))', [lockA.lockKey('default', fx.id)]);
    const s1 = await inOrg('default', () => refreshJob.startRefresh(fx.projectId, fx.id));
    ok('door: another pod holds it → startRefresh says already_running, with no job id here', s1.status === 'already_running' && s1.jobId === undefined, JSON.stringify(s1));
    ok('door: …and queued nothing', jobs.snapshot().active.length === 0);
    const r1 = await inOrg('default', () => refreshJob.refreshAsJob(fx.projectId, fx.id));
    ok('door: a ↻ job that meets the lock coalesces: alreadyRunning, the catalog\'s sentence', !r1.ok && r1.alreadyRunning === true
      && r1.error === JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'en.json'), 'utf8'))['refreshMessages.this_dataset_is_already_being_refreshed'], JSON.stringify(r1));
    const finished = jobs.snapshot().recent[0];
    ok('door: …its job ends DONE (the data is being refreshed), not as an error', finished?.state === 'done' && finished.result?.message === (r1.ok ? '' : r1.error),
      JSON.stringify(finished));
    ok('door: …and the dataset was not touched (1 row)', (await rows()) === 1);
    // The other doors a refresh comes through (scripts/test-refreshOneDoor.ts): the ↻ channels' one function, and the `datasets refresh` command.
    const press = await inOrg('default', () => (require('../src/ipc/datasets') as typeof import('../src/ipc/datasets')).refreshNow(fx.projectId, fx.id)) as { ok: boolean; alreadyRunning?: boolean };
    const cmd = await inOrg('default', () => (require('../src/automation/handlers') as typeof import('../src/automation/handlers'))
      .datasetsRefresh({ projectId: fx.projectId, transport: 'cli', cwd: data, headless: true, progress: () => undefined }, fx.id)).then(() => 'ran', (e: Error) => e.message);
    ok('door: dataset:refresh / connection:refresh and `datasets refresh` meet the lock too — refused, the dataset untouched', press.ok === false && press.alreadyRunning === true
      && cmd === (r1.ok ? '' : r1.error) && (await rows()) === 1, `${JSON.stringify(press)} ${cmd}`);
    await other.query('SELECT pg_advisory_unlock(hashtext($1))', [lockA.lockKey('default', fx.id)]);
    await other.end();
    const s2 = await inOrg('default', () => refreshJob.startRefresh(fx.projectId, fx.id));
    ok('door: released → startRefresh queues it', s2.status === 'queued');
    ok('door: …and it runs (2 rows)', s2.status === 'queued' && (await s2.done).ok && (await rows()) === 2);
    ok('door: the lock was released after the job', (await advisory()) === 0);

    // ── 4. Two real server processes ────────────────────────────────────────
    const probe = path.join(data, 'probe.jsonl');
    const failFlag = path.join(data, 'fail-refreshes');
    const podEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
      DATA_DIR: data, DATABASE_URL: scratch.toString(), REFRESH_TEST_PROBE: probe, REFRESH_TEST_SLOW_MS: String(SLOW_MS),
      REFRESH_TEST_FAIL: failFlag, ...extra,
    });
    if ((process.env.STORAGE_URL ?? '').startsWith('s3://')) {
      const envMod: typeof import('../src/server/env') = require('../src/server/env');
      const s3: typeof import('../src/engine/s3') = require('../src/engine/s3');
      await s3.createBucket(envMod.parseEnv(process.env).storage.s3!);
    }
    const twoPods = async (extra?: Record<string, string>): Promise<string[] | null> => {
      const pair = [startPod(podEnv(extra)), startPod(podEnv(extra))];
      pods.push(...pair);
      allPods.push(...pair);
      const bases = await Promise.all(pair.map((x) => x.base));
      ok(`pods${extra ? ' (lock off)' : ''}: both servers start`, bases.every(Boolean), pair.map((x) => x.out().slice(-1500)).join('\n---\n'));
      if (!bases.every(Boolean)) return null;
      // Warm each pod's request path, so neither reaches the lock late because it was cold.
      for (const b of bases as string[]) await rpc(b, 'dataset:list', { projectId: fx.projectId });
      return bases as string[];
    };
    const starts = () => readProbe(probe).filter((l) => l.kind === 'start' && l.id === fx.id);
    const refreshBoth = (bases: string[]) => Promise.all(bases.map((b) => rpc(b, 'dataset:refresh', { projectId: fx.projectId, id: fx.id })));

    const bases = await twoPods();
    if (bases) {
      for (const round of [1, 2]) {
        const n0 = starts().length;
        const replies = (await refreshBoth(bases)).map((r) => r.value);
        const ran = replies.filter((v) => v?.ok === true);
        const coalesced = replies.filter((v) => v?.ok === false && v.alreadyRunning === true);
        ok(`pods round ${round}: asked on both pods at once → exactly ONE refresh ran`, starts().length - n0 === 1, JSON.stringify(starts().slice(n0)));
        ok(`pods round ${round}: one pod answers ok, the other alreadyRunning`, ran.length === 1 && coalesced.length === 1, JSON.stringify(replies));
        ok(`pods round ${round}: the lock is free afterwards`, (await advisory()) === 0);
      }
      fs.writeFileSync(failFlag, '1');
      const n1 = starts().length;
      const failed = (await refreshBoth(bases)).map((r) => r.value);
      ok('pods, failing: still exactly one refresh ran', starts().length - n1 === 1);
      ok('pods, failing: it failed, the other pod coalesced', failed.filter((v) => v?.ok === false && !v.alreadyRunning).length === 1
        && failed.filter((v) => v?.alreadyRunning === true).length === 1, JSON.stringify(failed));
      ok('pods, failing: the lock was released after the failure', (await advisory()) === 0);
      fs.rmSync(failFlag);
      const n2 = starts().length;
      const again = await Promise.all(bases.map((b) => rpc(b, 'dataset:refresh', { projectId: fx.projectId, id: fx.id }).then((r) => r.value)));
      ok('pods, after the failure: the next refresh runs (once)', starts().length - n2 === 1 && again.some((v) => v?.ok === true), JSON.stringify(again));
      for (const pod of pods.splice(0)) {
        pod.child.kill('SIGTERM');
        await pod.exited;
      }
    }
    // NEGATIVE CONTROL: the same race between two pods that never take the lock.
    const offBases = await twoPods({ REFRESH_TEST_LOCK_OFF: '1' });
    if (offBases) {
      const n3 = starts().length;
      const replies = (await refreshBoth(offBases)).map((r) => r.value);
      const mine = starts().slice(n3);
      ok('negative control: with the lock off, both pods refresh it — and at the same time',
        mine.length === 2 && new Set(mine.map((l) => l.pod)).size === 2 && Math.abs(mine[0].at - mine[1].at) < SLOW_MS && replies.every((v) => v?.ok === true),
        JSON.stringify({ mine, replies }));
    }
    const logs = allPods.map((x) => x.out()).join('\n');
    ok('logs: no error-level line in any pod', !/"level":(50|60)/.test(logs), logs.split('\n').filter((l) => /"level":(50|60)/.test(l)).join('\n').slice(0, 2000));
  } finally {
    for (const pod of pods) pod.child.kill('SIGKILL');
    await Promise.all(pods.map((x) => x.exited));
    lockA.useRefreshLockDb(null);
    (require('../src/app/recordFs') as typeof import('../src/app/recordFs')).useRecordDb(null);
    await Promise.all([poolA.end(), poolB.end(), watch.end()]).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
})()
  .catch((err) => ok('threw', false, err && err.stack))
  .finally(() => finish());
