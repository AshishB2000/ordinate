// Measures a mapping change on a large org (docs/sso-lifecycle §3.13, review S-M1/C6). NOT a suite (no
// `test-` prefix): run it by hand.
//
// N members with stored groups; a map change re-applies every one of them under the exclusive people lock
// while, on the same 10-connection pool the server uses, 30 header-mode syncs arrive (a few page loads)
// and an unrelated `SELECT 1` runs. Prints how long the lock was held, how the syncs ended, and how long
// `SELECT 1` waited.
//
//   npm run build:ts && DATABASE_URL=… node scripts/measure-idpReapply.js [members=15000]

export {}; // module scope — sibling scripts share top-level names
import { Client } from 'pg';

const envMod: typeof import('../src/server/env') = require('../src/server/env');
const poolMod: typeof import('../src/server/db/pool') = require('../src/server/db/pool');
const migrate: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const store: typeof import('../src/server/auth/store') = require('../src/server/auth/store');
const idp: typeof import('../src/server/auth/idpGroups') = require('../src/server/auth/idpGroups');
const reapply: typeof import('../src/server/auth/idpReapply') = require('../src/server/auth/idpReapply');

const N = Number(process.argv[2] ?? 15_000);
const silent = { warn: () => undefined, error: () => undefined };

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error('DATABASE_URL is required');
  const dbName = `ordinate_measure_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = poolMod.createPool(scratch.toString(), () => undefined);
  try {
    await migrate.migrate(pool);
    const org = 'big';
    const auth = { ...envMod.parseEnv({ LOG_LEVEL: 'silent', DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', TRUSTED_GROUPS_HEADER: 'x-groups' }).auth, org };
    await pool.query(`INSERT INTO orgs (id, name) VALUES ($1, $1)`, [org]);
    const team = (await pool.query<{ id: string }>(`INSERT INTO teams (org_id, name) VALUES ($1, 'Sales') RETURNING id::text`, [org])).rows[0].id;
    await pool.query(
      `INSERT INTO users (org_id, email, role, last_login_at, idp_groups, idp_groups_at)
       SELECT $1, 'u' || g || '@big.test', CASE WHEN g = 1 THEN 'admin' ELSE 'viewer' END, now(),
              ARRAY[CASE WHEN g % 2 = 0 THEN 'sales' ELSE 'ops' END], now()
         FROM generate_series(1, $2) g`,
      [org, N],
    );
    await pool.query(`INSERT INTO idp_groups (org_id, group_name, role) VALUES ($1, 'admins', 'admin')`, [org]);
    const ids = (await pool.query<{ id: string; email: string }>(`SELECT id::text, email FROM users WHERE org_id = $1 ORDER BY email LIMIT 30`, [org])).rows;

    // The map change: sales → editor + the Sales team, every member re-applied.
    let held = 0;
    const change = (async () => {
      const t0 = performance.now();
      await store.withPeopleLock(pool, org, 'exclusive', async (c) => {
        await c.query(`INSERT INTO idp_groups (org_id, group_name, role, team_id) VALUES ($1, 'sales', 'editor', $2)`, [org, team]);
        await reapply.reapplyAll(c, auth, org);
      });
      held = performance.now() - t0;
    })();
    await new Promise((r) => setTimeout(r, 50)); // the lock is taken
    const outcomes = new Map<string, number>();
    const syncs = ids.map((u) =>
      idp.applyIdpGroups(pool, auth, { userId: u.id, email: u.email }, ['sales', 'extra'], { compare: true, log: silent })
        .then(() => 'applied', (err: unknown) => ((err as { code?: string }).code ?? (err as Error).message))
        .then((o) => void outcomes.set(o, (outcomes.get(o) ?? 0) + 1)));
    const s0 = performance.now();
    let select1: string;
    try {
      await Promise.race([pool.query('SELECT 1'), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 3000))]);
      select1 = `${Math.round(performance.now() - s0)} ms`;
    } catch {
      select1 = 'timed out at 3 s';
    }
    await change;
    await Promise.all(syncs);
    const editors = (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM users WHERE org_id = $1 AND role = 'editor'`, [org])).rows[0].n;
    console.log(JSON.stringify({ members: N, lockHeldMs: Math.round(held), select1, syncs: Object.fromEntries(outcomes), editors: Number(editors) }));
  } finally {
    await pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
