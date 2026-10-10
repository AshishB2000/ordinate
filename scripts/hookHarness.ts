// Two "pods" on one scratch database, for the refresh-URL suites that came
// after scripts/test-refreshHooks-db.ts (a connection's URL, the outcome of a
// call): two apps, each with its own pool, one database and one DATA_DIR,
// header sign-in, a project `P` that carol edits and vic only views.
//
// Needs a Postgres it may CREATE DATABASE on; without DATABASE_URL `withHookPods`
// prints one skip line and runs nothing.

import { withCsrf } from './csrfPair';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');

type Identity = import('../src/server/context').Identity;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export async function until(fn: () => Promise<boolean>, ms = 15_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await fn()) return true;
  return false;
}
export const EN: Record<string, string> = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'en.json'), 'utf8'));

export interface Hit { status: number; text: string; json: any; headers: Headers } // any: the route's small JSON body
export interface HookPods {
  readonly podA: string;
  readonly podB: string;
  readonly pool: Pool;
  /** The scratch database, for a raw session of the suite's own. */
  readonly dbUrl: string;
  /** REFRESH_HOOK_MIN_INTERVAL_SEC on both pods. */
  readonly interval: number;
  readonly P: string;
  /** An RPC as `email` (the proxy's header). */
  call(at: string, email: string, channel: string, payload?: unknown): Promise<{ status: number; body: any }>; // any: each channel's own reply
  /** A call of a refresh URL: POST fires it, GET asks how its last call ended. */
  hit(at: string, token: string, method?: 'POST' | 'GET'): Promise<Hit>;
  q<T extends object>(sql: string, args?: unknown[]): Promise<T[]>;
  /** Server code run as the org's admin, in a request context. */
  asBoss<T>(fn: () => Promise<T>): Promise<T>;
  /** Wait out the interval, so the same URL can be called again. */
  rest(): Promise<void>;
}

export async function withHookPods(tag: string, fn: (h: HookPods) => Promise<void>): Promise<void> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log(`skip ${tag}: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)`);
    return;
  }
  const interval = 2;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-hookpods-'));
  const dbName = `ordinate_hooks_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 4 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  const apps: FastifyInstance[] = [];
  try {
    context.enterServerMode(data);
    appMod.registerHandlers();
    const base: string[] = [];
    for (let i = 0; i < 2; i++) {
      const app = appMod.buildApp(envMod.parseEnv({
        LOG_LEVEL: 'silent', DATA_DIR: data, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32',
        ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test', REFRESH_HOOK_MIN_INTERVAL_SEC: String(interval), RATE_LIMIT_LOGIN_PER_MINUTE: '5000',
      }));
      apps.push(app);
      await app.listen({ port: 0, host: '127.0.0.1' });
      base.push(`http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`);
    }
    const call: HookPods['call'] = async (at, email, channel, payload) => {
      const res = await fetch(`${at}/api/rpc/${channel}`, {
        method: 'POST', headers: withCsrf({ 'content-type': 'application/json', 'x-forwarded-email': email }), body: wire.encode({ args: payload === undefined ? [] : [payload] }),
      });
      const text = await res.text();
      return { status: res.status, body: res.status === 200 ? wire.decode(text) : text };
    };
    const hit: HookPods['hit'] = async (at, token, method = 'POST') => {
      const res = await fetch(`${at}/api/hooks/refresh/${token}`, { method });
      const text = await res.text();
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { /* none */ }
      return { status: res.status, text, json, headers: res.headers };
    };
    const q: HookPods['q'] = async <T extends object>(sql: string, args: unknown[] = []) => (await pool.query<T>(sql, args)).rows;
    for (const p of ['boss', 'carol', 'vic']) await call(base[0], `${p}@acme.test`, 'projects:list');
    await pool.query(`UPDATE users SET role = 'editor' WHERE email = 'carol@acme.test'`);
    const P = (await call(base[0], 'boss@acme.test', 'projects:create', { name: 'Warehouse' })).body.id as string;
    for (const [email, role] of [['carol@acme.test', 'editor'], ['vic@acme.test', 'viewer']]) {
      await pool.query(`INSERT INTO project_grants (org_id, project_id, user_id, role) SELECT 'acme', $1, id, $3 FROM users WHERE email = $2`, [P, email, role]);
    }
    const BOSS: Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
    await fn({
      podA: base[0], podB: base[1], pool, dbUrl: scratch.toString(), interval, P, call, hit, q,
      asBoss: (run) => context.runInContext(BOSS, 'test', run),
      rest: () => sleep(interval * 1000 + 150),
    });
  } finally {
    for (const app of apps) await app.close().catch(() => undefined);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(data, { recursive: true, force: true });
  }
}
