// Disable is final, on every pod (docs/sso-lifecycle/00-design.md §3.8, §3.9, R5).
//
// Part A — TWO REAL SERVER PROCESSES (`node src/server/main.js`, header sign-in)
// on one fresh database. Carol has an event stream open on each pod; an admin
// disables her through pod A: BOTH streams end within a second (pod B's over the
// Postgres bus), and her reconnect is refused. NEGATIVE CONTROL: Dave's stream
// stays open — until he signs out everywhere through pod A, which ends it on B.
//
// Part B — the sweep (./src/server/streamSweep.ts), in-process under OIDC with
// sessions: a stream whose session is gone, or whose user was disabled with no
// bus message at all, is closed by one pass; a live one is not (control). A
// close that keeps one session keeps exactly that session's stream.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-disable-pods.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { Writable } from 'stream';
import { Client, Pool } from 'pg';
import { startMockOidc } from './mockOidc';

const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const context: typeof import('../src/server/context') = require('../src/server/context');
const store: typeof import('../src/server/auth/store') = require('../src/server/auth/store');
const sse: typeof import('../src/server/sse') = require('../src/server/sse');
const sweep: typeof import('../src/server/streamSweep') = require('../src/server/streamSweep');

const MAIN = path.join(__dirname, '..', 'src', 'server', 'main.js');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = (): number => performance.now();

interface Pod { child: ChildProcess; base: Promise<string | null> }

function startPod(env: Record<string, string>): Pod {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-disable-pod-'));
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, ...env, DATA_DIR: data, PORT: '0', ORDINATE_ENV: 'dev', LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
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
    child.on('exit', () => resolve(null));
  });
  return { child, base };
}

interface Stream { status: number; ended: Promise<number>; close(): void }

/** Opens /api/events like a tab's EventSource; `ended` resolves with the time the server ended it. */
function openStream(base: string, headers: Record<string, string>): Promise<Stream> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.get({ host: u.hostname, port: Number(u.port), path: `/api/events?client=${randomUUID()}`, headers }, (res) => {
      const ended = new Promise<number>((r) => res.on('close', () => r(now())));
      res.on('data', () => undefined);
      res.on('error', () => undefined);
      resolve({ status: res.statusCode ?? 0, ended, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

const within = (p: Promise<number>, ms: number): Promise<number | null> => Promise.race([p, sleep(ms).then(() => null)]);

async function post(base: string, url: string, email: string, body?: unknown): Promise<{ status: number; body: any }> { // any: a channel's reply
  const r = await fetch(base + url, {
    method: 'POST',
    headers: withCsrf({ ...(body === undefined ? {} : { 'content-type': 'application/json' }), 'x-forwarded-email': email }),
    body: body === undefined ? undefined : wire.encode({ args: [body] }),
  });
  const text = await r.text();
  let parsed: unknown = null;
  try {
    parsed = r.status === 200 && url.startsWith('/api/rpc/') ? wire.decode(text) : JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

async function partA(url: string, pool: Pool): Promise<void> {
  const env = { DATABASE_URL: url, AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test' };
  const a = startPod(env);
  const A = await a.base;
  const b = startPod(env);
  const B = await b.base;
  try {
    ok('pods: two real server processes are listening', !!A && !!B, `${A} ${B}`);
    if (!A || !B) return;
    const as = (email: string) => ({ 'x-forwarded-email': email });
    for (const p of ['boss', 'carol', 'dave']) await fetch(`${A}/api/auth/me`, { headers: as(`${p}@acme.test`) });
    const carolA = await openStream(A, as('carol@acme.test'));
    const carolB = await openStream(B, as('carol@acme.test'));
    const daveB = await openStream(B, as('dave@acme.test'));
    ok('streams: open on both pods', [carolA, carolB, daveB].every((s) => s.status === 200));
    await sleep(300); // both pods' LISTEN connections are up (startBus awaits its LISTEN before listen())
    const carol = (await pool.query<{ id: string }>(`SELECT id::text FROM users WHERE email = 'carol@acme.test'`)).rows[0].id;
    const t0 = now();
    const off = await post(A, '/api/rpc/admin:setDisabled', 'boss@acme.test', { userId: carol, disabled: true });
    const [endA, endB] = await Promise.all([within(carolA.ended, 3000), within(carolB.ended, 3000)]);
    ok('disable: answered ok on pod A', off.status === 200 && off.body?.ok === true, JSON.stringify(off));
    ok(`disable: carol's stream on pod A ends within a second (${endA === null ? 'never' : Math.round(endA - t0) + ' ms'})`, endA !== null && endA - t0 < 1000);
    ok(`disable: …and on pod B, over the bus (${endB === null ? 'never' : Math.round(endB - t0) + ' ms'})`, endB !== null && endB - t0 < 1000);
    ok('NEGATIVE CONTROL: dave\'s stream on pod B stays open', (await within(daveB.ended, 500)) === null);
    const againA = await openStream(A, as('carol@acme.test'));
    const againB = await openStream(B, as('carol@acme.test'));
    ok('disable: carol\'s reconnect is refused (401) on pod A AND on pod B', againA.status === 401 && againB.status === 401, `${againA.status} ${againB.status}`);
    againA.close();
    againB.close();
    const t1 = now();
    const out = await post(A, '/api/auth/logout-everywhere', 'dave@acme.test');
    const endDave = await within(daveB.ended, 3000);
    ok(`logout-everywhere through pod A ends dave's stream on pod B within a second (${endDave === null ? 'never' : Math.round(endDave - t1) + ' ms'})`,
      out.status === 200 && endDave !== null && endDave - t1 < 1000, JSON.stringify(out));
  } finally {
    for (const p of [a, b]) p.child.kill('SIGTERM');
    await sleep(500);
  }
}

async function partB(url: string, pool: Pool): Promise<void> {
  const idp = await startMockOidc({ clientId: 'ordinate-test', clientSecret: 'sweep-secret' });
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-sweep-'));
  context.enterServerMode(data);
  const cfg = envMod.parseEnv({
    LOG_LEVEL: 'silent', DATA_DIR: data, DATABASE_URL: url, AUTH_MODE: 'oidc', OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'ordinate-test',
    OIDC_CLIENT_SECRET: 'sweep-secret', OIDC_REDIRECT_URL: 'http://127.0.0.1:1/api/auth/callback', ORDINATE_ORG: 'acme',
  });
  const app = appMod.buildApp(cfg, new Writable({ write: (_c, _e, cb) => cb() }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
  try {
    const signIn = async (email: string): Promise<string> => {
      const login = await app.inject({ method: 'GET', url: '/api/auth/login' });
      const tx = login.cookies.find((c) => c.name === 'ordinate_login');
      const back = new URL(await idp.approve(String(login.headers.location), email));
      const cb = await app.inject({ method: 'GET', url: back.pathname + back.search, headers: tx ? { cookie: `ordinate_login=${tx.value}` } : {} });
      return cb.cookies.find((c) => c.name === 'ordinate_session' && c.value)?.value ?? '';
    };
    const asSession = (sid: string) => ({ cookie: `ordinate_session=${sid}` });
    const s1 = await signIn('erin@acme.test');
    const s2 = await signIn('erin@acme.test');
    const f1 = await signIn('frank@acme.test');
    const e1 = await openStream(base, asSession(s1));
    const e2 = await openStream(base, asSession(s2));
    const fr = await openStream(base, asSession(f1));
    ok('sweep: three session-bound streams open', [e1, e2, fr].every((s) => s.status === 200));
    ok('NEGATIVE CONTROL: a pass over live sessions closes nothing', (await sweep.sweepStreams(pool, cfg.auth.sessionIdleMs)) === 0);
    sse.closeStreamsOf('acme', 'erin@acme.test', store.hashId(s1));
    ok('keep: a close that keeps a session ends the other session\'s stream…', (await within(e2.ended, 2000)) !== null);
    ok('keep: …and keeps exactly that session\'s stream', (await within(e1.ended, 300)) === null);
    await pool.query('DELETE FROM sessions WHERE id_hash = $1', [store.hashId(s1)]); // signed out, no message to any stream
    await pool.query(`UPDATE users SET disabled_at = now() WHERE email = 'frank@acme.test'`); // disabled, no bus message
    const closed = await sweep.sweepStreams(pool, cfg.auth.sessionIdleMs);
    ok('sweep: one pass closes the stream whose session is gone and the disabled user\'s', closed === 2 && (await within(e1.ended, 2000)) !== null && (await within(fr.ended, 2000)) !== null, String(closed));
    ok('sweep: nothing left open on this pod', sse.streamCount() === 0, String(sse.streamCount()));
  } finally {
    await app.close();
    await idp.close();
    fs.rmSync(data, { recursive: true, force: true });
  }
}

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip disable-pods checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_disable_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 3 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  try {
    await partA(scratch.toString(), pool);
    await partB(scratch.toString(), pool);
  } finally {
    await pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
