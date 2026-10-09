// Refresh URLs (live data L0.5) across two REAL server processes: one
// database, one DATA_DIR, `node src/server/main.js` twice — the way two pods
// behind an ingress see one URL a dbt run and a retrying Airflow task both call.
//
//   1. Both pods at the same instant, 5 rounds → exactly one 202 and one 429
//      every round (the claim is one conditional UPDATE in Postgres), and the
//      dataset is refreshed.
//   2. One pod, then the other at once → 429 with Retry-After.
//   3. NEGATIVE CONTROL: two DIFFERENT URLs of the same dataset at once → both
//      202 — the interval is the URL's own, not a per-IP or per-dataset limit.
//   4. Neither pod's log holds a token.
//
// Needs a Postgres it may CREATE DATABASE on; without DATABASE_URL it prints
// one skip line.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-refreshHooks-pods.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { spawn, type ChildProcess } from 'child_process';
import { Client, Pool } from 'pg';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const store: typeof import('../src/server/hooks/store') = require('../src/server/hooks/store');

const MAIN = path.join(__dirname, '..', 'src', 'server', 'main.js');
const INTERVAL = 1;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEV = { user: { email: 'dev@local', role: 'admin' as const }, org: { id: 'default' } };

interface Pod { child: ChildProcess; out: () => string; base: Promise<string | null>; exited: Promise<number | null> }

function startPod(env: Record<string, string>): Pod {
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, ...env, PORT: '0', ORDINATE_ENV: 'dev', AUTH_MODE: 'dev', LOG_LEVEL: 'info' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
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

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip refresh-URL pod checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_l05p_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  pool.on('error', () => undefined);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-l05-pods-'));
  const pods: Pod[] = [];
  try {
    // ── The dataset and two URLs, written as a pod would ────────────────────
    fs.mkdirSync(path.join(data, 'orgs', 'default'), { recursive: true });
    context.enterServerMode(data);
    await mig.migrate(pool);
    const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
    recordFs.useRecordDb(pool);
    if ((process.env.STORAGE_URL ?? '').startsWith('s3://')) {
      const envMod: typeof import('../src/server/env') = require('../src/server/env');
      const s3: typeof import('../src/engine/s3') = require('../src/engine/s3');
      await s3.createBucket(envMod.parseEnv(process.env).storage.s3!);
    }
    const projects: typeof import('../src/app/projects') = require('../src/app/projects');
    const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
    const cols = [{ name: 'region', type: 'text' as const }, { name: 'revenue', type: 'number' as const }];
    const fx = await context.runInContext(DEV, 'seed', async () => {
      const p = await projects.createProject('Pods');
      const l = await datasets.saveDataset(p.id, { name: 'North', sourceKind: 'csv', columns: cols, rows: [['north', 10]] });
      const r = await datasets.saveDataset(p.id, { name: 'South', sourceKind: 'csv', columns: cols, rows: [['south', 20]] });
      const d = await datasets.saveDataset(p.id, { name: 'Orders', sourceKind: 'combined', columns: cols, rows: [['north', 10]], origin: { kind: 'combined', leftId: l!.id, rightId: r!.id, mode: 'append' } });
      return { projectId: p.id, id: d!.id };
    });
    const [t1, t2] = [store.newHookToken(), store.newHookToken()];
    for (const t of [t1, t2]) {
      await pool.query(`INSERT INTO refresh_hooks (org_id, project_id, dataset_id, token_hash, prefix, created_by) VALUES ('default', $1, $2, $3, $4, 'dev@local')`,
        [fx.projectId, fx.id, store.hookHash(t), t.slice(0, store.PREFIX_LEN)]);
    }

    // ── Two pods ────────────────────────────────────────────────────────────
    const env = { DATA_DIR: data, DATABASE_URL: scratch.toString(), REFRESH_HOOK_MIN_INTERVAL_SEC: String(INTERVAL) };
    pods.push(startPod(env), startPod(env));
    const bases = await Promise.all(pods.map((p) => p.base));
    ok('pods: both servers start', bases.every(Boolean), pods.map((p) => p.out().slice(-1500)).join('\n---\n'));
    if (!bases.every(Boolean)) return;
    const [a, b] = bases as string[];
    const fire = async (at: string, t: string) => {
      const res = await fetch(`${at}/api/hooks/refresh/${t}`, { method: 'POST' });
      return { status: res.status, body: await res.text(), retryAfter: res.headers.get('retry-after') };
    };

    const rounds: string[] = [];
    for (let i = 0; i < 5; i++) {
      await sleep(INTERVAL * 1000 + 150);
      rounds.push((await Promise.all([fire(a, t1), fire(b, t1)])).map((r) => r.status).sort().join('+'));
    }
    ok('race: two processes at the same instant, 5 rounds → exactly one 202 and one 429 every round', rounds.every((r) => r === '202+429'), rounds.join(' '));
    const rows = () => context.runInContext(DEV, 'read', () => datasets.getDatasetMeta(fx.projectId, fx.id)).then((m) => m?.rowCount);
    let refreshed = false;
    for (let i = 0; i < 100 && !refreshed; i++, await sleep(100)) refreshed = (await rows()) === 2;
    ok('race: …and a pod refreshed the dataset (1 → 2 rows)', refreshed);

    await sleep(INTERVAL * 1000 + 150);
    const first = await fire(a, t1);
    const second = await fire(b, t1);
    ok('sequence: pod A → 202, pod B right after → 429 with Retry-After', first.status === 202 && second.status === 429 && Number(second.retryAfter) >= 1,
      `${first.status} ${second.status} ${second.retryAfter}`);

    await sleep(INTERVAL * 1000 + 150);
    const pair = await Promise.all([fire(a, t1), fire(b, t2)]);
    ok('NEGATIVE CONTROL: two different URLs of the dataset at once → both 202 (the interval is per URL)', pair.every((r) => r.status === 202), pair.map((r) => `${r.status} ${r.body}`).join(' | '));

    for (const pod of pods) pod.child.kill('SIGTERM');
    await Promise.all(pods.map((p) => p.exited));
    const logs = pods.map((p) => p.out()).join('\n');
    ok('logs: neither pod logged a token', [t1, t2].every((t) => !logs.includes(t.slice(5))) && logs.includes('/api/hooks/refresh/[redacted]'));
    ok('logs: no error-level line in either pod', !/"level":(50|60)/.test(logs), logs.split('\n').filter((l) => /"level":(50|60)/.test(l)).join('\n').slice(0, 2000));
  } finally {
    for (const pod of pods) pod.child.kill('SIGKILL');
    await Promise.all(pods.map((p) => p.exited));
    (require('../src/app/recordFs') as typeof import('../src/app/recordFs')).useRecordDb(null);
    await pool.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
    fs.rmSync(data, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
