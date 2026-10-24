// Self-check for the web server skeleton (src/server/): config validation, the
// two probes, log redaction, and that the real entry point (`node
// src/server/main.js`) boots, answers /healthz and /readyz, serves an RPC and
// shuts down cleanly. (Until the T8.1 cutover it also proved the server never
// loaded the desktop runtime or src/cli; both are gone from the repository.)
//
// SIGTERM MID-FLIGHT (docs/pod-lifecycle/00-design.md §3.10): the real server,
// signalled with a query and a job running (×20), with a hung-up query still
// unwinding (×10), and with an idle worker (×10) — every time exit 0, no native
// abort, gone within SHUTDOWN_GRACE_SECONDS + 3 s; with the job, /readyz 503
// meanwhile and the job ending `cancelled` with the restart sentence. Without
// DATABASE_URL in that mode; with it, on a scratch database (and one more run on
// S3 when STORAGE_URL=s3://… is set, the CI env).
//
//   npm run build:ts && node scripts/test-server-boot.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Writable } from 'stream';
import { line, runOnce, type Kind, type Outcome } from './sigtermHarness';

const envMod: typeof import('../src/server/env') = require('../src/server/env');
const appMod: typeof import('../src/server/app') = require('../src/server/app');

const MAIN = path.join(__dirname, '..', 'src', 'server', 'main.js');

function envFails(label: string, src: Record<string, string>, needle: string): void {
  try {
    envMod.parseEnv(src);
    ok(`env: ${label} is rejected`, false);
  } catch (err) {
    const e = err as Error;
    ok(`env: ${label} is rejected, naming ${needle}`, e.name === 'EnvError' && e.message.includes(needle), e.message);
  }
}

/** The child's env: this process's, plus `extra`. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, ...extra };
  // The caller's DATABASE_URL (CI sets one for the DB suites) is not this
  // suite's: it would migrate that shared database, and in prod it trips the
  // master-key check before the sign-in check this suite asserts. The DB boot
  // path is covered by test-db-migrate and test-jobs-pods on scratch databases.
  delete e.DATABASE_URL;
  // Same for an S3 STORAGE_URL (it requires a DATABASE_URL); test-storageS3 and
  // test-jobs-pods cover the S3 boot path.
  delete e.STORAGE_URL;
  return e;
}

(async () => {
  // ── Config ────────────────────────────────────────────────────────────────
  const d = envMod.parseEnv({ AUTH_MODE: 'dev' });
  ok('env: defaults are port 8080, dev, info', d.port === 8080 && d.env === 'dev' && d.logLevel === 'info', JSON.stringify(d));
  ok('env: DATA_DIR defaults to an absolute ./data', path.isAbsolute(d.dataDir) && path.basename(d.dataDir) === 'data', d.dataDir);
  ok('env: the config object is frozen', Object.isFrozen(d));
  const p = envMod.parseEnv({ AUTH_MODE: 'dev', PORT: '0', ORDINATE_ENV: 'prod', DATA_DIR: '/srv/ordinate', LOG_LEVEL: 'warn' });
  ok('env: explicit values are taken', p.port === 0 && p.env === 'prod' && p.dataDir === path.resolve('/srv/ordinate') && p.logLevel === 'warn', JSON.stringify(p));
  envFails('PORT=abc', { PORT: 'abc' }, 'PORT');
  envFails('PORT=70000', { PORT: '70000' }, 'PORT');
  envFails('PORT=-1', { PORT: '-1' }, 'PORT');
  envFails('PORT=80.5', { PORT: '80.5' }, 'PORT');
  envFails('ORDINATE_ENV=staging', { ORDINATE_ENV: 'staging' }, 'ORDINATE_ENV');
  envFails('LOG_LEVEL=verbose', { LOG_LEVEL: 'verbose' }, 'LOG_LEVEL');
  envFails('prod without DATA_DIR', { ORDINATE_ENV: 'prod' }, 'DATA_DIR');

  // ── Probes, in process ────────────────────────────────────────────────────
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      cb();
    },
  });
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'info' }), sink);
  // A real request's real headers through the real logger — nothing logs
  // headers yet, but the first handler that does must not leak them.
  app.addHook('onRequest', async (req) => {
    req.log.info({ headers: req.headers }, 'headers seen');
  });

  const h = await app.inject({ method: 'GET', url: '/healthz' });
  ok('healthz: 200', h.statusCode === 200, h.statusCode);
  ok('healthz: body is {ok:true}', h.body === '{"ok":true}', h.body);
  const r = await app.inject({ method: 'GET', url: '/readyz' });
  ok('readyz: 200 with DuckDB available', r.statusCode === 200 && r.json().checks?.duckdb === true, r.body);
  const n = await app.inject({ method: 'GET', url: '/nope' });
  ok('unknown route: 404', n.statusCode === 404, n.statusCode);

  // ── Redaction ─────────────────────────────────────────────────────────────
  const SECRETS = ['s3cr3t-bearer', 's3cr3t-cookie', 's3cr3t-pw', 's3cr3t-token', 's3cr3t-secret', 's3cr3t-key', 's3cr3t-deep', 's3cr3t-apikey'];
  await app.inject({
    method: 'GET',
    url: '/healthz',
    headers: { authorization: 'Bearer s3cr3t-bearer', cookie: 'sid=s3cr3t-cookie', 'x-api-key': 's3cr3t-apikey' },
  });
  app.log.info({
    password: 's3cr3t-pw',
    conn: { token: 's3cr3t-token', options: { secret: 's3cr3t-secret', tls: { key: 's3cr3t-key' } } },
    a: { b: { c: { d: { password: 's3cr3t-deep' } } } },
    host: 'db.internal',
  }, 'connecting');
  await app.close();

  const all = lines.join('\n');
  ok('logs: every line is JSON', lines.length > 0 && lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }), lines.find((l) => !l.startsWith('{')));
  for (const s of SECRETS) ok(`logs: ${s} never reaches the log`, !all.includes(s));
  const hdr = lines.map((l) => JSON.parse(l)).find((o) => o.msg === 'headers seen' && o.headers?.authorization);
  ok('logs: request headers are logged with secrets censored', hdr?.headers.authorization === '[redacted]' && hdr?.headers.cookie === '[redacted]' && typeof hdr?.headers.host === 'string', JSON.stringify(hdr));
  ok('logs: non-secret fields survive', all.includes('db.internal'));

  // ── Boot ──────────────────────────────────────────────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-server-boot-'));
  const t0 = process.hrtime.bigint();
  const child = spawn(process.execPath, [MAIN], {
    env: childEnv({ PORT: '0', DATA_DIR: tmp, ORDINATE_ENV: 'dev', AUTH_MODE: 'dev', LOG_LEVEL: 'info' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const base = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 20_000);
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
      const m = /"msg":"Server listening at (http:\/\/[^"]+)"/.exec(stdout);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    void exited.then(() => resolve(null));
  });
  const coldMs = Number(process.hrtime.bigint() - t0) / 1e6;
  ok('boot: node src/server/main.js listens on an ephemeral port', base !== null, stderr || stdout);
  console.log(`     cold start to listening: ${coldMs.toFixed(0)} ms`);

  if (base) {
    const hz = await fetch(base + '/healthz');
    ok('boot: GET /healthz is 200', hz.status === 200, hz.status);
    const rz = await fetch(base + '/readyz');
    ok('boot: GET /readyz is 200 (DuckDB up)', rz.status === 200, await rz.text());
    // main.ts registered the Home handlers, and dev auth ran this as org
    // `default` under DATA_DIR.
    const pl = await fetch(base + '/api/rpc/projects:list', { method: 'POST', headers: withCsrf({ 'content-type': 'application/json' }), body: '{"args":[]}' });
    const plBody = await pl.text();
    ok('boot: POST /api/rpc/projects:list is 200 with a list', pl.status === 200 && Array.isArray(JSON.parse(plBody)), plBody);
    ok('boot: …resolved under DATA_DIR/orgs/default', fs.existsSync(path.join(tmp, 'orgs', 'default', 'userData')));
    child.kill('SIGTERM');
    ok('boot: SIGTERM closes cleanly (exit 0)', (await exited) === 0, stderr);
  } else {
    child.kill('SIGKILL');
  }

  // ── Bad config stops startup with one line ────────────────────────────────
  const bad = spawnSync(process.execPath, [MAIN], { env: childEnv({ ORDINATE_ENV: 'staging', PORT: '0' }), encoding: 'utf8', timeout: 20_000 });
  ok('bad env: exits non-zero', bad.status !== 0 && bad.status !== null, bad.status);
  // Counted by prefix, not total lines: a sandboxed Node can print its own
  // unrelated warnings (keychain CA trust) on stderr.
  const errLines = bad.stderr.split('\n');
  const ours = errLines.filter((l) => l.startsWith('ordinate: '));
  ok('bad env: exactly one line on stderr, naming the variable', ours.length === 1 && ours[0].includes('ORDINATE_ENV'), bad.stderr);
  ok('bad env: no stack trace', !errLines.some((l) => /^\s+at /.test(l)), bad.stderr);

  // ── prod with no sign-in configured refuses to start ──────────────────────
  // DATABASE_URL blanked: with it inherited (CI, a DB run), prod's
  // ORDINATE_MASTER_KEY check (T5.3) refuses first and this never reaches sign-in.
  // AUTH_MODE unset is password sign-in (never dev), which keeps its accounts in Postgres.
  const prodEnv = childEnv({ ORDINATE_ENV: 'prod', DATA_DIR: tmp, PORT: '0', DATABASE_URL: '' });
  delete prodEnv.AUTH_MODE;
  const prod = spawnSync(process.execPath, [MAIN], { env: prodEnv, encoding: 'utf8', timeout: 20_000 });
  const prodOurs = prod.stderr.split('\n').filter((l) => l.startsWith('ordinate: '));
  ok('prod without auth: exits non-zero with one line naming AUTH_MODE=password and DATABASE_URL',
    prod.status !== 0 && prod.status !== null && prodOurs.length === 1 && prodOurs[0].includes('AUTH_MODE=password') && prodOurs[0].includes('DATABASE_URL'), prod.stderr);
  // …and dev sign-in, asked for, is refused in prod.
  const prodDev = spawnSync(process.execPath, [MAIN], { env: childEnv({ ORDINATE_ENV: 'prod', DATA_DIR: tmp, PORT: '0', DATABASE_URL: '', AUTH_MODE: 'dev' }), encoding: 'utf8', timeout: 20_000 });
  const devOurs = prodDev.stderr.split('\n').filter((l) => l.startsWith('ordinate: '));
  ok('prod with AUTH_MODE=dev: exits non-zero with one line naming sign-in', prodDev.status !== 0 && prodDev.status !== null && devOurs.length === 1 && devOurs[0].includes('sign-in'), prodDev.stderr);

  fs.rmSync(tmp, { recursive: true, force: true });

  await sigtermMidFlight();
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);

/** Every kind of SIGTERM, repeated, in this run's mode (with DATABASE_URL: a scratch database). */
async function sigtermMidFlight(): Promise<void> {
  const GRACE_S = 2;
  const sentence = (require('../src/server/lifecycleMessages') as typeof import('../src/server/lifecycleMessages')).restartedWhileRunning();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-sigterm-'));
  const adminUrl = process.env.DATABASE_URL;
  const mode = adminUrl ? 'with DATABASE_URL' : 'without DATABASE_URL';
  const env = childEnv({ DATA_DIR: data, ORDINATE_ENV: 'dev', AUTH_MODE: 'dev' });
  const { Client }: typeof import('pg') = require('pg');
  let dbName = '';
  if (adminUrl) {
    dbName = `ordinate_boot_${process.pid}_${Date.now()}`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const u = new URL(adminUrl);
    u.pathname = '/' + dbName;
    env.DATABASE_URL = u.toString();
    // The dev identity as a member, so a project it creates gets its creator grant.
    const { Pool }: typeof import('pg') = require('pg');
    const pool = new Pool({ connectionString: env.DATABASE_URL, max: 1 });
    pool.on('error', () => undefined);
    await (require('../src/server/db/migrate') as typeof import('../src/server/db/migrate')).migrate(pool);
    await pool.query("INSERT INTO orgs (id, name) VALUES ('default', 'Default') ON CONFLICT DO NOTHING");
    await pool.query("INSERT INTO users (org_id, email, role, last_login_at) VALUES ('default', 'dev@local', 'admin', now())");
    await pool.end();

    // A SIGTERM that lands while the app boots (review C5): the runner and the bus never start.
    const lifecycle: typeof import('../src/server/lifecycle') = require('../src/server/lifecycle');
    const boot = () => appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: data, DATABASE_URL: env.DATABASE_URL }));
    const normal = boot();
    await normal.ready();
    const started = { ...appMod.background() };
    await normal.close();
    ok('NEGATIVE CONTROL: a normal boot starts the scheduled-job runner and the bus', !!started.runner && !!started.bus);
    lifecycle.startDraining();
    const late = boot();
    await late.ready();
    const none = { ...appMod.background() };
    lifecycle.resetForTest();
    await late.close();
    ok('a boot that finishes while the pod drains starts neither (nothing for the shutdown to stop)', !none.runner && !none.bus, JSON.stringify({ runner: !!none.runner, bus: !!none.bus }));
  }
  try {
    const runs: Outcome[] = [];
    for (const [kind, n] of [['inflight', 20], ['hungup', 10], ['idle', 10]] as Array<[Kind, number]>) {
      for (let i = 0; i < n; i++) {
        const o = await runOnce(kind, env, GRACE_S);
        runs.push(o);
        if (o.setupError || o.aborted || o.overran || o.code !== 0) console.log(`     ${mode} ${kind} #${i + 1}: ${line(o)}\n${o.stderrTail}`);
      }
    }
    const s3 = (process.env.STORAGE_URL ?? '').startsWith('s3://') && adminUrl ? await s3Prefix() : null;
    if (s3) runs.push({ ...(await runOnce('inflight', { ...env, STORAGE_URL: s3 }, GRACE_S, { s3Read: true })), kind: 'inflight' });
    for (const kind of ['inflight', 'hungup', 'idle'] as Kind[]) {
      const of = runs.filter((o) => o.kind === kind);
      const clean = of.filter((o) => !o.setupError && o.code === 0 && !o.aborted && !o.overran && o.goneMs <= (GRACE_S + 3) * 1000);
      console.log(`     SIGTERM ${mode}, ${kind}: ${of.length} runs, ${clean.length} clean, ${of.filter((o) => o.aborted).length} aborts, ${of.filter((o) => o.overran).length} overruns, `
        + `${of.filter((o) => o.setupError).length} setup failures, slowest ${Math.max(0, ...of.map((o) => o.goneMs))} ms`);
      ok(`SIGTERM ${mode}, ${kind}: ${clean.length} of ${of.length} exit 0 with no native abort, within SHUTDOWN_GRACE_SECONDS + 3 s`, of.length > 0 && clean.length === of.length);
    }
    const inflight = runs.filter((o) => o.kind === 'inflight');
    ok(`SIGTERM ${mode}, inflight: /readyz answered 503 (draining) between the signal and the exit, every time`, inflight.every((o) => o.readyz503), inflight.filter((o) => !o.readyz503).map(line).join(' | '));
    ok(`SIGTERM ${mode}, inflight: the job ended cancelled with "${sentence}", pushed to its tab, every time`,
      inflight.every((o) => o.job?.state === 'cancelled' && o.job.error === sentence), inflight.filter((o) => o.job?.error !== sentence).map(line).join(' | '));
    if (s3) ok('SIGTERM on S3 (the main-thread credential instance open): exit 0, no abort', inflight.at(-1)?.code === 0 && !inflight.at(-1)?.aborted, line(inflight.at(-1) as Outcome));
    else console.log('     (no S3 run: STORAGE_URL=s3://… and DATABASE_URL are not both set)');
  } finally {
    fs.rmSync(data, { recursive: true, force: true });
    if (dbName && adminUrl) {
      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  }
}

/** A fresh prefix in the CI bucket (made if need be), as an s3:// URL. The test's own S3 lookup is closed after. */
async function s3Prefix(): Promise<string> {
  const s3: typeof import('../src/engine/s3') = require('../src/engine/s3');
  const base = envMod.parseEnv(process.env).storage.s3!;
  const prefix = `${base.prefix ? base.prefix + '/' : ''}boot-${process.pid}-${Date.now()}`;
  await s3.createBucket({ ...base, prefix });
  await s3.close(Date.now() + 5000);
  return `s3://${base.bucket}/${prefix}`;
}
