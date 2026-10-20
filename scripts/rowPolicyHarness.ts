// The world the row access suites share (docs/row-policy/00-design.md, Tests):
// a scratch Postgres database, the server in header sign-in, real people and
// grants, and one project whose dataset *Orders* has rules — plus PHYSICAL
// subsets *East* and *West* (the same columns and steps, only that region's
// rows), so a viewer's figure is compared with what the engine computes over
// the rows they may see, never with a hand-written value.
//
// Not a test file itself (no `test-` prefix): the suites import it.

import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

export const context: typeof import('../src/server/context') = require('../src/server/context');
export const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');

type Cell = import('../src/data/transforms').Cell;
type Identity = import('../src/server/context').Identity;

/** West-only values: no reply to East may carry one. */
export const W_CANARY = 'W_CANARY_7f19';
/** A value only the WEST RULE names: the rules themselves never reach a viewer. */
export const POLICY_CANARY = 'WEST_POLICY_CANARY';

export const COLUMNS = [
  { name: 'region', type: 'text' as const },
  { name: 'sales', type: 'number' as const },
  { name: 'day', type: 'date' as const },
  { name: 'customer', type: 'text' as const },
  { name: 'qty', type: 'number' as const },
];
const REGIONS = ['East', 'West', 'North', 'East', 'West', 'east', null] as const;
/** 126 rows: East, West, North, a lowercase `east` (no one's), and an empty region (no one's). */
export const ROWS: Cell[][] = Array.from({ length: 126 }, (_, i) => {
  const region = REGIONS[i % REGIONS.length];
  const customer = region === 'West' ? `${W_CANARY}_${i % 5}` : `c${i % 9}`;
  return [region, (i * 37) % 101, `2024-${String(1 + (i % 9)).padStart(2, '0')}-1${i % 9}`, customer, (i * 7) % 13];
});
export const only = (region: string): Cell[][] => ROWS.filter((r) => r[0] === region);

export interface Reply { status: number; body: any; text: string } // any: each channel's own reply
export interface World {
  P: string;
  orders: string;
  east: string;
  west: string;
  /** A dataset WITHOUT rules, for controls. */
  plain: string;
  team: string;
  uid: Record<string, string>;
  pool: Pool;
  app: FastifyInstance;
  /** POST /api/rpc/<channel> as `who` (boss, ed, east, west, nobody). */
  call(who: string, channel: string, payload?: unknown): Promise<Reply>;
  /** Runs `fn` in the org's context as `who` (an org role and the email: the rest is the grants). */
  as<T>(who: string, fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const RULES = (team: string, west: string) => [{ teamId: team, values: ['East'] }, { userId: west, values: ['West', POLICY_CANARY] }];

/** Null (with a skip line) without DATABASE_URL. */
export async function world(label: string): Promise<World | null> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log(`skip ${label}: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)`);
    return null;
  }
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-rowpolicy-'));
  const dbName = `ordinate_rowp_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 3 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown

  context.enterServerMode(DATA);
  poolMod.routeByOrg({ dataDir: DATA, maxWorkers: 2, memoryLimit: '512MiB', threads: 2, queryTimeoutMs: 60_000, idleMs: 60_000 });
  appMod.registerHandlers();
  const app = appMod.buildApp(envMod.parseEnv({
    LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
  }));
  await app.ready();
  const call = async (who: string, channel: string, payload?: unknown): Promise<Reply> => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json', 'x-forwarded-email': `${who}@acme.test` }),
      payload: wire.encode({ args: payload === undefined ? [] : [payload] }),
      remoteAddress: '127.0.0.1',
    });
    let body: unknown = null;
    try {
      body = r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body);
    } catch {
      body = null;
    }
    return { status: r.statusCode, body, text: r.body };
  };
  for (const p of ['boss', 'ed', 'east', 'west', 'nobody']) await call(p, 'projects:list');
  const uid: Record<string, string> = {};
  for (const p of ['boss', 'ed', 'east', 'west', 'nobody']) {
    uid[p] = (await pool.query<{ id: string }>('SELECT id::text FROM users WHERE email = $1', [`${p}@acme.test`])).rows[0].id;
  }
  const team = (await pool.query<{ id: string }>(`INSERT INTO teams (org_id, name) VALUES ('acme', 'East') RETURNING id::text`)).rows[0].id;
  await pool.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)', [team, uid.east]);
  const P: string = (await call('boss', 'projects:create', { name: 'Row access' })).body.id;
  for (const [member, role] of [[{ userId: uid.ed }, 'editor'], [{ teamId: team }, 'viewer'], [{ userId: uid.west }, 'viewer'], [{ userId: uid.nobody }, 'viewer']] as const) {
    const r = await call('boss', 'project:share', { projectId: P, member, role });
    if (r.body?.ok !== true) throw new Error(`share failed: ${r.text}`);
  }
  const ROLE: Record<string, Identity['user']['role']> = { boss: 'admin', ed: 'viewer', east: 'viewer', west: 'viewer', nobody: 'viewer' };
  const as = <T>(who: string, fn: () => Promise<T>): Promise<T> =>
    context.runInContext({ user: { email: `${who}@acme.test`, role: ROLE[who] ?? 'viewer' }, org: { id: 'acme' } }, `as-${who}`, fn);
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const save = (name: string, rows: Cell[][]) => as('boss', async () => (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns: COLUMNS, rows }))!.id);
  const orders = await save('Orders', ROWS);
  const east = await save('Orders', only('East'));
  const west = await save('Orders', only('West'));
  const plain = await save('Plain', ROWS.map((r) => r.map((c) => (typeof c === 'string' ? c.replace(W_CANARY, 'w') : c))));
  // The subsets are in the same project: each gets rules too, so West's rows are reachable by no viewer but West.
  for (const [d, rules] of [[orders, RULES(team, uid.west)], [east, [{ teamId: team, values: ['East'] }]], [west, [{ userId: uid.west, values: ['West'] }]]] as const) {
    const set = await call('boss', 'dataset:setRowPolicy', { projectId: P, datasetId: d, policy: { column: 'region', rules } });
    if (set.body?.ok !== true) throw new Error(`setRowPolicy failed: ${set.text}`);
  }
  return {
    P, orders, east, west, plain, team, uid, pool, app, call, as,
    async close() {
      await app.close();
      await pool.end();
      await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await root.end();
      fs.rmSync(DATA, { recursive: true, force: true });
    },
  };
}

/** A typed refusal: 409 `row_policy`, or a reply (or every item of a batch) `{ok:false, code:'row_policy'}`. */
export function refused(r: Reply, reason?: string): boolean {
  const typed = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.length > 0 && v.every(typed);
    const o = (v ?? {}) as Record<string, unknown>;
    return o.ok === false && o.code === 'row_policy' && typeof o.error === 'string' && (!reason || o.reason === reason);
  };
  if (r.status === 409) return r.body?.code === 'row_policy' && typeof r.body.message === 'string' && (!reason || r.body.reason === reason);
  return r.status === 200 && typed(r.body);
}

/** Does the reply carry anything of West's? (rows, values, or the West rule's own value) */
export function leaks(text: string): boolean {
  return text.includes(W_CANARY) || text.includes(POLICY_CANARY);
}

/** Keys that differ between two runs of the same question: times, and record or turn ids (figures never sit under them). */
const VOLATILE = new Set(['asOf', 'computedAt', 'generatedAt', 'threadId', 'turnId', 'askId', 'createdAt', 'updatedAt', 'downloadToken', 'token', 'at', 'id']);

/**
 * The first difference between two replies, after mapping `swap`'s ids onto each
 * other and dropping volatile keys — numbers compared with Object.is. '' when equal.
 */
export function diff(a: unknown, b: unknown, swap: Record<string, string>, at = '$'): string {
  const s = (v: unknown): unknown => (typeof v === 'string' ? Object.entries(swap).reduce((x, [from, to]) => x.split(from).join(to), v) : v);
  const x = s(a);
  const y = s(b);
  if (Array.isArray(x) || Array.isArray(y)) {
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return `${at}: length ${Array.isArray(x) ? x.length : typeof x} vs ${Array.isArray(y) ? y.length : typeof y}`;
    for (let i = 0; i < x.length; i++) {
      const d = diff(x[i], y[i], swap, `${at}[${i}]`);
      if (d) return d;
    }
    return '';
  }
  if (x && y && typeof x === 'object' && typeof y === 'object') {
    const keys = new Set([...Object.keys(x), ...Object.keys(y)].filter((k) => !VOLATILE.has(k)));
    for (const k of keys) {
      const d = diff((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], swap, `${at}.${k}`);
      if (d) return d;
    }
    return '';
  }
  return Object.is(x, y) ? '' : `${at}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`;
}
