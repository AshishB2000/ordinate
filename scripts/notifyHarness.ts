// The notifications suites' bench (scripts/test-alertInbox.ts,
// test-alertDelivery.ts, test-mentions.ts) — a helper, not a suite: a scratch
// Postgres database, the real app in header sign-in (X-Forwarded-Email from a
// trusted 127.0.0.1 peer, so each member is one header away), org `acme` whose
// admin is boss@acme.test, and RPC over real HTTP. Without DATABASE_URL
// `withServer` prints one skip line and runs nothing.

import { randomBytes } from 'crypto';
import { Writable } from 'stream';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import * as B from './subscriptionHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');

export type Identity = B.Identity;
export const ORG = 'acme';
export const BOSS: Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: ORG } };
export const JOBS: Identity = { user: { email: 'jobs@system', role: 'admin' }, org: { id: ORG } };
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const show = (v: unknown): string => JSON.stringify(v).slice(0, 500);

/** Until `fn` holds, or `ms` passes. */
export async function until(fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await fn()) return true;
  return await fn();
}

export interface Bench {
  readonly app: FastifyInstance;
  readonly base: string;
  readonly pool: Pool;
  /** The scratch database's URL, for an ordinary role's connection. */
  readonly dbUrl: string;
  /** The server's log lines (JSON). */
  readonly log: string[];
  /** RPC as `who` (a local part of @acme.test, or a whole address). */
  as(who: string): ReturnType<typeof B.client>;
  /** The users row id of `who`. */
  uid(who: string): Promise<string>;
  /** Server code as `who`, in a request context of org acme. */
  run<T>(who: Identity, fn: () => Promise<T>): Promise<T>;
  /** Sign each one in once (header mode provisions an org viewer on the first request). */
  provision(...who: string[]): Promise<void>;
  /** A grant on `projectId` (null removes it), by the org admin. */
  share(projectId: string, who: string | { teamId: string }, role: 'viewer' | 'editor' | 'admin' | null): Promise<void>;
}

const roles: string[] = []; // ordinary roles made by a suite: dropped with its database

const email = (who: string): string => (who.includes('@') ? who : `${who}@acme.test`);

/** A scratch database and the app on it; `env` adds to the server's environment. */
export async function withServer(name: string, env: Record<string, string>, fn: (b: Bench) => Promise<void>): Promise<void> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log(`skip ${name} DB suite: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)`);
    return;
  }
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), `ordinate-${name}-`));
  const dbName = `ordinate_${name.replace(/\W/g, '_').toLowerCase()}_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 4 });
  pool.on('error', () => undefined);
  B.context.enterServerMode(DATA);
  appMod.registerHandlers();
  const log: string[] = [];
  const cfg = envMod.parseEnv({
    LOG_LEVEL: 'info', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', ORDINATE_MASTER_KEY: randomBytes(32).toString('base64'),
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: ORG, ORDINATE_ADMIN_EMAIL: BOSS.user.email, ...env,
  });
  const app = appMod.buildApp(cfg, new Writable({ write(chunk, _enc, done) { log.push(String(chunk)); done(); } }));
  try {
    const base = await B.listen(app);
    const as = (who: string) => B.client(base, { 'x-forwarded-email': email(who) });
    const uid = async (who: string): Promise<string> => (await pool.query<{ id: string }>('SELECT id::text FROM users WHERE org_id = $1 AND email = $2', [ORG, email(who)])).rows[0].id;
    const bench: Bench = {
      app, base, pool, dbUrl: scratch.toString(), log, as, uid,
      run: (who, f) => B.context.runInContext(who, `t:${Math.random()}`, f),
      provision: async (...who) => { for (const w of who) await as(w).call('projects:list'); },
      share: async (projectId, who, role) => {
        const member = typeof who === 'string' ? { userId: await uid(who) } : who;
        const r = await as('boss').call('project:share', { projectId, member, role });
        if (r.status !== 200) throw new Error(`share: ${r.status} ${r.text.slice(0, 200)}`);
      },
    };
    await fn(bench);
  } finally {
    await app.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    for (const r of roles.splice(0)) await root.query(`DROP ROLE IF EXISTS ${r}`).catch(() => undefined);
    await root.end().catch(() => undefined);
    fs.rmSync(DATA, { recursive: true, force: true });
  }
}

/** An ordinary (non-superuser) role on the scratch database with `grants` on `tables`: RLS applies to it. */
export async function ordinaryRole(b: Bench, tables: string[], grants = 'SELECT, INSERT, UPDATE, DELETE'): Promise<Pool> {
  const role = `notify_role_${process.pid}_${roles.length}`;
  roles.push(role);
  const pw = randomBytes(12).toString('hex');
  await b.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}'`);
  for (const t of tables) await b.pool.query(`GRANT ${grants} ON ${t} TO ${role}`);
  const url = new URL(b.dbUrl);
  url.username = role;
  url.password = pw;
  const p = new Pool({ connectionString: url.toString(), max: 2 });
  p.on('error', () => undefined);
  return p;
}

/** Rows of `table` an ordinary role sees as `org` (null: no setting). */
export async function seenAs(p: Pool, table: string, org: string | null): Promise<Array<{ org_id: string }>> {
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    if (org) await c.query(`SELECT set_config('ordinate.org', $1, true)`, [org]);
    const r = await c.query<{ org_id: string }>(`SELECT org_id FROM ${table}`);
    await c.query('COMMIT');
    return r.rows;
  } finally {
    c.release();
  }
}

/** Does an ordinary role's write of `sql` as `org` fail the policy (WITH CHECK)? */
export async function refusedAs(p: Pool, org: string, sql: string, args: unknown[]): Promise<boolean> {
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('ordinate.org', $1, true)`, [org]);
    await c.query(sql, args);
    return false;
  } catch (e) {
    return /row-level security/.test((e as Error).message);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
