// Self-check for the web server skeleton (src/server/): config validation, the
// two probes, log redaction, and — the reason this file exists — that the
// server BOOTS WITHOUT ELECTRON.
//
// The desktop app's main process can import 'electron' anywhere; the server
// cannot, because a pod has no Electron. Nothing in the type system stops a
// handler module from importing it, so this suite spawns the real entry point
// (`node src/server/main.js`) with a preload that makes `require('electron')`
// fail loudly, and hits /healthz. An Electron import anywhere in the server's
// graph — including lazily, in the DuckDB worker, or under a try/catch — fails
// here. A negative control proves the preload actually blocks.
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

const envMod: typeof import('../src/server/env') = require('../src/server/env');
const appMod: typeof import('../src/server/app') = require('../src/server/app');

const MAIN = path.join(__dirname, '..', 'src', 'server', 'main.js');
const MARK = 'ELECTRON-REQUIRED-IN-SERVER';

function envFails(label: string, src: Record<string, string>, needle: string): void {
  try {
    envMod.parseEnv(src);
    ok(`env: ${label} is rejected`, false);
  } catch (err) {
    const e = err as Error;
    ok(`env: ${label} is rejected, naming ${needle}`, e.name === 'EnvError' && e.message.includes(needle), e.message);
  }
}

/** A child env with no Electron on NODE_PATH and no run-as-node switch. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete e.ELECTRON_RUN_AS_NODE;
  // The caller's DATABASE_URL (CI sets one for the DB suites) is not this
  // suite's: it would migrate that shared database, and in prod it trips the
  // master-key check before the sign-in check this suite asserts. The DB boot
  // path is covered by test-db-migrate and test-jobs-pods on scratch databases.
  delete e.DATABASE_URL;
  e.NODE_PATH = (process.env.NODE_PATH ?? '')
    .split(path.delimiter)
    .filter((p) => p && !/electron/i.test(p))
    .join(path.delimiter);
  return e;
}

(async () => {
  // ── Config ────────────────────────────────────────────────────────────────
  const d = envMod.parseEnv({});
  ok('env: defaults are port 8080, dev, info', d.port === 8080 && d.env === 'dev' && d.logLevel === 'info', JSON.stringify(d));
  ok('env: DATA_DIR defaults to an absolute ./data', path.isAbsolute(d.dataDir) && path.basename(d.dataDir) === 'data', d.dataDir);
  ok('env: the config object is frozen', Object.isFrozen(d));
  const p = envMod.parseEnv({ PORT: '0', ORDINATE_ENV: 'prod', DATA_DIR: '/srv/ordinate', LOG_LEVEL: 'warn' });
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
  const app = appMod.buildApp(envMod.parseEnv({ LOG_LEVEL: 'info' }), sink);
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

  // ── Boot without Electron ─────────────────────────────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-server-boot-'));
  const hook = path.join(tmp, 'no-electron.js');
  fs.writeFileSync(hook, `const M = require('module');
const orig = M._resolveFilename;
M._resolveFilename = function (req, ...rest) {
  if (req === 'electron' || req.startsWith('electron/')) {
    process.stderr.write(${JSON.stringify(MARK + '\n')});
    throw new Error('electron is not installed (server boot test)');
  }
  return orig.call(this, req, ...rest);
};
`);

  const control = spawnSync(process.execPath, ['-r', hook, '-e', "require('electron')"], { env: childEnv({}), encoding: 'utf8' });
  ok('control: the preload really blocks require("electron")', control.status !== 0 && control.stderr.includes(MARK), control.stderr);

  const t0 = process.hrtime.bigint();
  const child = spawn(process.execPath, ['-r', hook, MAIN], {
    env: childEnv({ PORT: '0', DATA_DIR: tmp, ORDINATE_ENV: 'dev', LOG_LEVEL: 'info' }),
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
    ok('boot: GET /readyz is 200 (DuckDB up, no Electron)', rz.status === 200, await rz.text());
    // main.ts registered the Home handlers: their whole graph loaded without
    // Electron, and dev auth ran this as org `default` under DATA_DIR.
    const pl = await fetch(base + '/api/rpc/projects:list', { method: 'POST', headers: withCsrf({ 'content-type': 'application/json' }), body: '{"args":[]}' });
    const plBody = await pl.text();
    ok('boot: POST /api/rpc/projects:list is 200 with a list', pl.status === 200 && Array.isArray(JSON.parse(plBody)), plBody);
    ok('boot: …resolved under DATA_DIR/orgs/default', fs.existsSync(path.join(tmp, 'orgs', 'default', 'userData')));
    child.kill('SIGTERM');
    ok('boot: SIGTERM closes cleanly (exit 0)', (await exited) === 0, stderr);
  } else {
    child.kill('SIGKILL');
  }
  ok('boot: nothing in the server graph asked for electron', !stderr.includes(MARK), stderr);

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
  const prod = spawnSync(process.execPath, [MAIN], { env: childEnv({ ORDINATE_ENV: 'prod', DATA_DIR: tmp, PORT: '0', DATABASE_URL: '' }), encoding: 'utf8', timeout: 20_000 });
  const prodOurs = prod.stderr.split('\n').filter((l) => l.startsWith('ordinate: '));
  ok('prod without auth: exits non-zero with one line naming sign-in', prod.status !== 0 && prod.status !== null && prodOurs.length === 1 && prodOurs[0].includes('sign-in'), prod.stderr);

  fs.rmSync(tmp, { recursive: true, force: true });
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
