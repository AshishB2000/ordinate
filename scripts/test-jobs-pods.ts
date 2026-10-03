// Self-check for scheduled jobs and cross-pod events (src/server/jobs/, T5.4).
//
// The reason this file exists: TWO REAL SERVER PROCESSES (`node src/server/main.js`,
// PORT=0) on one fresh database must run each scheduled job EXACTLY ONCE, a pod
// killed mid-run must be retaken by the other after its lease expires, and an
// event raised by the job must reach tabs whose event streams are on EITHER
// process — only the tabs its target and binding allow. The pods are observed
// through scripts/jobsPodPreload.ts (test kinds + a tick hook that append to one
// probe file). In-process checks cover the claim itself: the lease is what makes
// it exclusive (negative control), a late finish is fenced, and the claim is timed.
//
// The DB half needs a Postgres it may CREATE DATABASE on. Without DATABASE_URL
// it prints one `skip` line and runs only the no-DB checks.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-jobs-pods.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Client, Pool } from 'pg';

const sse: typeof import('../src/server/sse') = require('../src/server/sse');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const runner: typeof import('../src/server/jobs/runner') = require('../src/server/jobs/runner');
const bus: typeof import('../src/server/jobs/bus') = require('../src/server/jobs/bus');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');

type Identity = import('../src/server/context').Identity;
type Target = import('../src/server/sse').Target;

const MAIN = path.join(__dirname, '..', 'src', 'server', 'main.js');
const PRELOAD = path.join(__dirname, 'jobsPodPreload.js');
const POLL_MS = 100;
const LEASE_MS = 1_500;
const SLOW_MS = 4_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = (): number => performance.timeOrigin + performance.now();
const who = (org: string, user: string): Identity => ({ user: { email: user, role: 'admin' }, org: { id: org } });

async function until(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) return false;
    await sleep(20);
  }
  return true;
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (xs: number[]): string => `median ${pct(xs, 50).toFixed(2)} ms, p95 ${pct(xs, 95).toFixed(2)} ms, max ${Math.max(...xs).toFixed(2)} ms (n=${xs.length})`;

// ── Pods ──────────────────────────────────────────────────────────────────────

interface Pod { child: ChildProcess; pid: number; out: () => string; base: Promise<string | null>; exited: Promise<number | null> }

function startPod(env: Record<string, string>): Pod {
  const e: NodeJS.ProcessEnv = { ...process.env, ...env, PORT: '0', ORDINATE_ENV: 'dev', LOG_LEVEL: 'info' };
  delete e.ELECTRON_RUN_AS_NODE;
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
  return { child, pid: child.pid ?? -1, out: () => out, base, exited };
}

interface Ev { channel: string; data: unknown; at: number }
interface Tab { label: string; key: string; events: Ev[]; close(): void }

/** Opens /api/events on `base` like a browser tab's EventSource, bound to org + user. */
function openTab(label: string, base: string, org: string, user: string, key: string = randomUUID()): Promise<Tab> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: u.hostname, port: Number(u.port), path: `/api/events?client=${key}`,
      headers: { 'x-test-org': org, 'x-test-user': user },
    }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`${label}: /api/events ${res.statusCode}`));
      const tab: Tab = { label, key, events: [], close: () => req.destroy() };
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(':')) continue;
          const ev = /^event: (.*)$/m.exec(block);
          const data = /^data: (.*)$/m.exec(block);
          tab.events.push({ channel: ev ? ev[1] : 'message', data: data ? wire.decode(data[1]) : undefined, at: now() });
        }
      });
      res.on('error', () => { /* a destroyed test socket, or a killed pod */ });
      resolve(tab);
    });
    req.on('error', reject);
  });
}

const count = (t: Tab, channel: string): number => t.events.filter((e) => e.channel === channel).length;

interface Line { pod: number; at: number; kind: string; org?: string }
const readProbe = (file: string): Line[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line) : [];

const quietLog = () => {
  const warns: string[] = [];
  const log = {
    warns,
    warn: (_o: unknown, msg?: string) => void warns.push(String(msg)),
    error: (_o: unknown, msg?: string) => void warns.push(String(msg)),
    info: () => undefined,
  };
  return log;
};

(async () => {
  // ── No DB: remote clients (sse.clientFor with a fan-out) ───────────────────
  const dev = who('default', 'dev@local');
  const k = randomUUID();
  ok('remote: without a fan-out an unknown client id is no client (T0.5 behaviour)', sse.clientFor(k, dev) === null);
  const sent: Array<{ t: Target; c: string; d: string }> = [];
  sse.setFanOut((t, c, d) => void sent.push({ t, c, d }));
  const rc = sse.clientFor(k, dev);
  ok('remote: with a fan-out a valid id with no local stream is a remote client', rc !== null && rc.id > 0);
  ok('remote: the same caller and id get the same remote client (jobs keep its number)', sse.clientFor(k, dev) === rc);
  ok('remote: another user naming that id gets a different client', sse.clientFor(k, who('default', 'eve@local')) !== rc);
  ok('remote: an invalid id is still no client', sse.clientFor('not-a-uuid', dev) === null);
  rc?.send('jobs:finished', { n: NaN });
  const s0 = sent.at(-1);
  ok('remote: send fans out targeted at org + user + client, wire-encoded',
    !!s0 && s0.c === 'jobs:finished' && s0.t.org === 'default' && s0.t.user === 'dev@local' && s0.t.client === k
      && Number.isNaN((wire.decode(s0.d) as { n: number }).n), JSON.stringify(s0));
  sse.setFanOut(null);
  ok('remote: removing the fan-out restores T0.5 behaviour', sse.clientFor(randomUUID(), dev) === null);
  ok('migration: 0005_jobs.sql is shipped', mig.loadMigrations().some((m) => m.name === '0005_jobs.sql'));

  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }

  const dbName = `ordinate_t54_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 4 });
  // An idle client dropped under load or by teardown's DROP … FORCE is not a finding; unhandled it would kill the suite.
  pool.on('error', () => undefined);
  const pods: Pod[] = [];
  const tabs: Tab[] = [];
  try {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-jobs-'));
    for (const org of ['default', 'orgx']) fs.mkdirSync(path.join(data, 'orgs', org), { recursive: true });
    const probe = path.join(data, 'probe.jsonl');

    // A REAL scheduled dataset in org `default`: a file origin, refreshed hourly,
    // never run — so the first tick finds it due. Written in this process
    // through the app's own modules, as the org's request would.
    const context: typeof import('../src/server/context') = require('../src/server/context');
    const projects: typeof import('../src/app/projects') = require('../src/app/projects');
    const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
    context.enterServerMode(data);
    // With DATABASE_URL a record is a row (T5.1): the fixture goes where the pods read it.
    await mig.migrate(pool);
    (require('../src/app/recordFs') as typeof import('../src/app/recordFs')).useRecordDb(pool);
    const csv = path.join(data, 'source.csv');
    fs.writeFileSync(csv, 'region,revenue\nnorth,10\n');
    const fixture = await context.runInContext(who('default', 'dev@local'), 'fixture', async () => {
      const p = await projects.createProject('Scheduled');
      const d = await datasets.saveDataset(p.id, {
        name: 'Nightly', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }],
        rows: [['north', 10]], origin: { kind: 'file', path: csv },
      });
      if (d) await datasets.setAutoRefresh(p.id, d.id, { every: 'hourly' });
      return { projectId: p.id, datasetId: d?.id ?? '' };
    });
    ok('fixture: a scheduled dataset exists in org default', !!fixture.datasetId);
    const metaOf = () => context.runInContext(who('default', 'dev@local'), 'fixture', () => datasets.getDatasetMeta(fixture.projectId, fixture.datasetId));
    const devKeys = [randomUUID(), randomUUID()]; // the dev@local tabs, one per pod — published to as `client` targets
    const podEnv = (): Record<string, string> => ({
      DATA_DIR: data, DATABASE_URL: scratch.toString(), JOBS_TEST_PROBE: probe,
      JOBS_TEST_POLL_MS: String(POLL_MS), JOBS_TEST_LEASE_MS: String(LEASE_MS), JOBS_TEST_SLOW_MS: String(SLOW_MS),
      JOBS_TEST_CLIENTS: devKeys.join(','),
    });
    pods.push(startPod(podEnv()), startPod(podEnv()));
    const bases = await Promise.all(pods.map((p) => p.base));
    ok('pods: both servers start and listen', bases.every(Boolean), pods.map((p) => p.out()).join('\n---\n'));
    if (!bases[0] || !bases[1]) return;

    const rowCount = async (): Promise<number> => Number((await pool.query<{ n: string }>('SELECT count(*) AS n FROM jobs')).rows[0].n);
    // An S3 STORAGE_URL in the environment (T5.2) gives every org a fourth kind, storage:gc.
    const kinds = 3 + ((process.env.STORAGE_URL ?? '').startsWith('s3://') ? 1 : 0);
    ok(`rows: both pods insert their schedules; each (org, kind) exists once (2 orgs × ${kinds} kinds)`,
      await until(async () => (await rowCount()) === 2 * kinds, 5000) && (await rowCount()) === 2 * kinds, await rowCount());
    const first = await pool.query<{ due: boolean }>(`SELECT bool_and(next_run_at > now()) AS due FROM jobs`);
    ok('rows: a new schedule is first due one interval from now (no run at boot)', first.rows[0].due === true);

    // One tab per (pod × binding). The dev tabs use the ids the probe targets.
    const mk = async (label: string, pod: 0 | 1, org: string, user: string, key?: string): Promise<Tab> => {
      const t = await openTab(label, bases[pod]!, org, user, key);
      tabs.push(t);
      return t;
    };
    const devA = await mk('devA', 0, 'default', 'dev@local', devKeys[0]);
    const devB = await mk('devB', 1, 'default', 'dev@local', devKeys[1]);
    const otherA = await mk('otherA', 0, 'default', 'other@local');
    const otherB = await mk('otherB', 1, 'default', 'other@local');
    const orgxA = await mk('orgxA', 0, 'orgx', 'dev@local');
    const orgxB = await mk('orgxB', 1, 'orgx', 'dev@local');

    // ── Exactly once, five rounds ───────────────────────────────────────────
    const probeRuns = () => readProbe(probe).filter((l) => l.kind === 'probe');
    const dueLatency: number[] = [];
    let onceEachRound = true;
    for (let round = 1; round <= 5; round++) {
      const t0 = now();
      await pool.query(`UPDATE jobs SET next_run_at = now() WHERE org_id = 'default' AND kind = 'test:probe'`);
      const ran = await until(() => probeRuns().length >= round, 5000);
      if (ran) dueLatency.push(probeRuns()[round - 1].at - t0);
      await sleep(10 * POLL_MS); // ten more polls on each pod: room for a duplicate to show up
      if (probeRuns().length !== round) onceEachRound = false;
    }
    const runs = probeRuns();
    ok('once: 5 due rounds → exactly 5 probe runs across both pods (never a duplicate)', runs.length === 5 && onceEachRound, JSON.stringify(runs));
    const dbRuns = await pool.query<{ runs: string; lease_owner: string | null; later: boolean }>(
      `SELECT runs, lease_owner, next_run_at > now() + interval '50 minutes' AS later FROM jobs WHERE org_id = 'default' AND kind = 'test:probe'`);
    ok('once: the row counts 5 finished runs, lease cleared, next run an interval away',
      dbRuns.rows[0].runs === '5' && dbRuns.rows[0].lease_owner === null && dbRuns.rows[0].later, JSON.stringify(dbRuns.rows));
    const ranOn = new Set(runs.map((r) => r.pod));
    console.log(`     probe runs per pod: ${JSON.stringify(pods.map((p) => runs.filter((r) => r.pod === p.pid).length))}`);
    ok('once: the runs happened on pod processes of this test', [...ranOn].every((pid) => pods.some((p) => p.pid === pid)));

    // ── Events: who got what (per run: org, user, client, spoof, big, 50 lat) ─
    await until(() => [devA, devB, otherA, otherB].every((t) => count(t, 'test:lat') >= 250), 5000);
    await sleep(300);
    const expect = (t: Tab, channel: string, n: number): void =>
      ok(`events: ${t.label} got ${channel} ×${n}`, count(t, channel) === n, `${count(t, channel)} — ${JSON.stringify(t.events.map((e) => e.channel))}`.slice(0, 600));
    for (const t of [devA, devB, otherA, otherB]) {
      expect(t, 'test:org', 5);
      expect(t, 'test:big', 5);
      expect(t, 'test:lat', 250);
      expect(t, 'test:spoof', 0);
    }
    expect(devA, 'test:user', 5);
    expect(devB, 'test:user', 5);
    expect(otherA, 'test:user', 0);
    expect(otherB, 'test:user', 0);
    expect(devA, 'test:client', 5);
    expect(devB, 'test:client', 5);
    expect(otherA, 'test:client', 0);
    expect(otherB, 'test:client', 0);
    ok('events: each dev tab got only the client event naming ITS id',
      devA.events.filter((e) => e.channel === 'test:client').every((e) => (e.data as { client: string }).client === devA.key)
        && devB.events.filter((e) => e.channel === 'test:client').every((e) => (e.data as { client: string }).client === devB.key));
    ok('events: another org\'s tabs (both pods) got nothing', orgxA.events.length === 0 && orgxB.events.length === 0,
      JSON.stringify([...orgxA.events, ...orgxB.events].map((e) => e.channel)));
    // Publish order survives the trip, including the by-reference body (read before delivery).
    const lat50 = Array.from({ length: 50 }, (_, i) => `test:lat#${i}`);
    const seqOf = (t: Tab): string => t.events.map((e) => e.channel === 'test:lat' ? `test:lat#${(e.data as { i: number }).i}` : e.channel).join();
    const devRun = ['test:org', 'test:user', 'test:client', 'test:big', ...lat50];
    const otherRun = ['test:org', 'test:big', ...lat50];
    for (const [t, run] of [[devA, devRun], [devB, devRun], [otherA, otherRun], [otherB, otherRun]] as const) {
      ok(`events: ${t.label} received every run's events in publish order`, seqOf(t) === Array.from({ length: 5 }, () => run).flat().join(), seqOf(t).slice(0, 400));
    }
    const big = devA.events.find((e) => e.channel === 'test:big')?.data as { blob?: string } | undefined;
    ok('events: a 20,000-byte payload arrives whole (NOTIFY by reference)', big?.blob?.length === 20_000);
    // Cross-pod proof: a run on pod X reached the tab on the OTHER pod.
    const crossed = runs.some((r) => {
      const other = r.pod === pods[0].pid ? devB : devA;
      return other.events.some((e) => e.channel === 'test:org' && (e.data as { pod: number }).pod === r.pod);
    });
    ok('events: an event raised on one pod reached a tab whose stream is on the other pod', crossed);
    // Latency only over the cross-pod path: events a tab got from the OTHER pod.
    const lat: number[] = [];
    for (const [tab, from] of [[devA, pods[1].pid], [devB, pods[0].pid]] as const) {
      for (const e of tab.events) {
        const d = e.data as { pod?: number; sentAt?: number };
        if (e.channel === 'test:lat' && d.pod === from && typeof d.sentAt === 'number') lat.push(e.at - d.sentAt);
      }
    }
    ok('events: NOTIFY latency measured on the cross-pod path', lat.length >= 50, lat.length);
    if (lat.length) console.log(`     NOTIFY end-to-end, publish on pod → tab on the other pod: ${fmt(lat)}`);
    console.log(`     due → running on a pod (poll ${POLL_MS} ms): ${fmt(dueLatency)}`);

    // ── The real scheduler tick runs once per org ──────────────────────────
    fs.writeFileSync(csv, 'region,revenue\nnorth,10\nsouth,20\neast,30\n'); // the source moved on
    await pool.query(`UPDATE jobs SET next_run_at = now() WHERE kind = 'tick'`);
    const ticks = () => readProbe(probe).filter((l) => l.kind === 'tick');
    await until(() => ticks().length >= 2, 10_000);
    await sleep(10 * POLL_MS);
    const tk = ticks();
    ok('tick: the real refresh tick ran exactly once per org across both pods',
      tk.length === 2 && tk.some((l) => l.org === 'default') && tk.some((l) => l.org === 'orgx'), JSON.stringify(tk));
    const tickRows = await pool.query<{ runs: string; last_error: string | null }>(`SELECT runs, last_error FROM jobs WHERE kind = 'tick' ORDER BY org_id`);
    await until(() => count(devA, 'hub:dataset-refreshed') + count(devB, 'hub:dataset-refreshed') >= 2, 3000);
    await sleep(300);
    for (const t of [devA, devB, otherA, otherB]) {
      const evs = t.events.filter((e) => e.channel === 'hub:dataset-refreshed');
      const o = evs[0]?.data as { ok?: boolean; datasetId?: string; rowsBefore?: number; rowsAfter?: number } | undefined;
      ok(`tick: ${t.label} got the real refresh's hub:dataset-refreshed exactly once (1 → 3 rows)`,
        evs.length === 1 && o?.ok === true && o.datasetId === fixture.datasetId && o.rowsBefore === 1 && o.rowsAfter === 3, JSON.stringify(evs.map((e) => e.data)));
    }
    ok('tick: another org\'s tabs got no refresh event', count(orgxA, 'hub:dataset-refreshed') + count(orgxB, 'hub:dataset-refreshed') === 0);
    const meta = await metaOf();
    ok('tick: the dataset was refreshed once, on disk (3 rows, lastAutoAt stamped)', meta?.rowCount === 3 && !!meta?.autoRefresh?.lastAutoAt, JSON.stringify(meta?.autoRefresh));
    ok('tick: both rows count one run with no error', tickRows.rows.every((r) => r.runs === '1' && r.last_error === null), JSON.stringify(tickRows.rows));

    // ── Kill a pod mid-run; the other retakes after the lease expires ──────
    await pool.query(`UPDATE jobs SET next_run_at = now() WHERE org_id = 'default' AND kind = 'test:slow'`);
    const slow = (kind: string) => readProbe(probe).filter((l) => l.kind === kind);
    await until(() => slow('slow-start').length >= 1, 5000);
    const victimPid = slow('slow-start')[0]?.pod;
    const victim = pods.find((p) => p.pid === victimPid);
    const survivor = pods.find((p) => p.pid !== victimPid);
    await sleep(LEASE_MS + 1000); // well past ONE lease: only the heartbeat keeps it
    ok('kill: a run outliving its lease is not retaken while its pod heartbeats', slow('slow-start').length === 1, JSON.stringify(slow('slow-start')));
    const killedAt = now();
    victim?.child.kill('SIGKILL');
    await victim?.exited;
    const retaken = await until(() => slow('slow-end').length >= 1, LEASE_MS + SLOW_MS + 5000);
    const starts = slow('slow-start');
    const ends = slow('slow-end');
    ok('kill: the other pod retook the killed run and finished it', retaken && starts.length === 2 && starts[1].pod === survivor?.pid
      && ends.length === 1 && ends[0].pod === survivor?.pid, JSON.stringify({ starts, ends }));
    if (starts[1]) console.log(`     SIGKILL → retaken on the other pod: ${(starts[1].at - killedAt).toFixed(0)} ms (lease ${LEASE_MS} ms, poll ${POLL_MS} ms)`);
    // The last heartbeat (every LEASE_MS/3) left at least 2/3 of a lease to run.
    ok('kill: the retake waited for the lease to expire', !!starts[1] && starts[1].at - killedAt >= (LEASE_MS * 2) / 3 - 50,
      starts[1] ? starts[1].at - killedAt : -1);
    await sleep(5 * POLL_MS);
    const slowRow = await pool.query<{ runs: string; lease_owner: string | null }>(`SELECT runs, lease_owner FROM jobs WHERE org_id = 'default' AND kind = 'test:slow'`);
    ok('kill: the row counts ONE finished run, lease cleared', slowRow.rows[0].runs === '1' && slowRow.rows[0].lease_owner === null, JSON.stringify(slowRow.rows));

    survivor?.child.kill('SIGTERM');
    ok('kill: the survivor closes cleanly on SIGTERM (exit 0)', (await survivor?.exited) === 0, survivor?.out().slice(-2000));
    const logs = pods.map((p) => p.out()).join('\n');
    ok('logs: no error-level line in either pod', !/"level":(50|60)/.test(logs), logs.split('\n').filter((l) => /"level":(50|60)/.test(l)).join('\n').slice(0, 2000));
    for (const t of tabs) t.close();

    // ── In-process: the claim itself ──────────────────────────────────────
    const log = quietLog();
    const fl = log as unknown as import('fastify').FastifyBaseLogger;
    await pool.query(`DELETE FROM jobs`);
    await pool.query(`INSERT INTO jobs (org_id, kind, next_run_at) SELECT 'o' || g, 'bench', now() + interval '1 hour' FROM generate_series(1, 1000) g`);
    const emptyMs: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      await runner.claimOne(pool, ['bench']);
      emptyMs.push(performance.now() - t);
    }
    console.log(`     claim, nothing due (1,000 rows): ${fmt(emptyMs)}`);
    await pool.query(`UPDATE jobs SET next_run_at = now() - interval '1 second' WHERE org_id IN (SELECT 'o' || g FROM generate_series(1, 200) g)`);
    const dueMs: number[] = [];
    const owners = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const t = performance.now();
      const c = await runner.claimOne(pool, ['bench']);
      dueMs.push(performance.now() - t);
      if (c) owners.add(c.orgId);
    }
    console.log(`     claim, a row due (1,000 rows): ${fmt(dueMs)}`);
    ok('claim: 200 due rows → 200 distinct claims, then nothing', owners.size === 200 && (await runner.claimOne(pool, ['bench'])) === null);
    ok('claim: an unknown kind is never claimed', (await runner.claimOne(pool, ['other'])) === null);

    // 20 concurrent claimers race for one due row.
    await pool.query(`DELETE FROM jobs`);
    await pool.query(`INSERT INTO jobs (org_id, kind, next_run_at) VALUES ('race', 'bench', now())`);
    const race = await Promise.all(Array.from({ length: 20 }, () => runner.claimOne(pool, ['bench'])));
    ok('claim: 20 concurrent claimers, one due row → exactly one claim', race.filter(Boolean).length === 1, race.filter(Boolean).length);
    // Negative control: a lease that has already expired protects nothing.
    await pool.query(`UPDATE jobs SET lease_owner = NULL, lease_until = NULL`);
    const noLease: unknown[] = [];
    for (let i = 0; i < 5; i++) noLease.push(await runner.claimOne(pool, ['bench'], -1000));
    ok('claim (negative control): with the lease removed the same row is claimed every time', noLease.filter(Boolean).length === 5, noLease.filter(Boolean).length);

    // Fencing: a run whose lease is retaken mid-run cannot reschedule the row.
    await pool.query(`DELETE FROM jobs`);
    await pool.query(`INSERT INTO jobs (org_id, kind, next_run_at) VALUES ('fence', 'bench:fence', now())`);
    let retakenBy: import('../src/server/jobs/runner').Claim | null = null;
    runner.defineJob('bench:fence', {
      everyMs: 3_600_000,
      run: async () => {
        await pool.query(`UPDATE jobs SET lease_until = now() - interval '1 second'`); // the lease runs out…
        retakenBy = await runner.claimOne(pool, ['bench:fence']); // …and another pod takes the row
      },
    });
    const mine = await runner.claimOne(pool, ['bench:fence']);
    if (mine) await runner.runClaim(pool, mine, fl);
    const fenced = await pool.query<{ runs: string; lease_owner: string | null }>(`SELECT runs, lease_owner FROM jobs WHERE kind = 'bench:fence'`);
    ok('fence: the late finish does not reschedule or count — the retaker still holds the row',
      !!retakenBy && fenced.rows[0].runs === '0' && fenced.rows[0].lease_owner === (retakenBy as import('../src/server/jobs/runner').Claim).owner,
      JSON.stringify(fenced.rows));
    ok('fence: the late finish is logged', log.warns.some((w) => w.includes('lease was retaken')), JSON.stringify(log.warns));

    // A notification over the cap goes by reference; the table is the size limit's answer.
    ok('bus: the inline cap is below Postgres\'s 8000-byte NOTIFY limit', bus.MAX_NOTIFY_BYTES < 8000);
  } finally {
    for (const t of tabs) t.close();
    for (const p of pods) if (p.child.exitCode === null) p.child.kill('SIGKILL');
    await Promise.all(pods.map((p) => p.exited));
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((err: unknown) => ok('suite ran without throwing', false, err instanceof Error ? err.stack : String(err)))
  .finally(finish);
