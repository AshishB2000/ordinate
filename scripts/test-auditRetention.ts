// Audit retention (docs/server/audit-retention.md): AUDIT_RETENTION_DAYS,
// pruneAudit, its place on the shared sweep, and the `audit` log line.
//
// The env parse runs everywhere. The rest needs a Postgres it may CREATE
// DATABASE on; without DATABASE_URL it prints one skip line. Every run makes
// its own scratch database and drops it.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-auditRetention.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Client, Pool } from 'pg';

const envMod: typeof import('../src/server/env') = require('../src/server/env');
const auditMod: typeof import('../src/server/authz/audit') = require('../src/server/authz/audit');
const migrateMod: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
const logger: typeof import('../src/app/logger') = require('../src/app/logger');
const context: typeof import('../src/server/context') = require('../src/server/context');
const shared: typeof import('../src/server/sharedState') = require('../src/server/sharedState');

const BASE = { AUTH_MODE: 'dev', DATA_DIR: '/tmp/ordinate-audit-retention' };
const days = (raw: string | undefined) => envMod.parseEnv({ ...BASE, AUDIT_RETENTION_DAYS: raw }).auditRetentionDays;
const refused = (raw: string) => {
  try { days(raw); return false; } catch (e) { return e instanceof envMod.EnvError && e.message.includes('AUDIT_RETENTION_DAYS'); }
};

(async () => {
  ok('env: unset keeps every row (null)', days(undefined) === null);
  ok('env: 0 keeps every row (null)', days('0') === null);
  ok('env: 30 and 365 are days', days('30') === 30 && days('365') === 365);
  for (const bad of ['29', '1', '-5', '1.5', 'abc', '365d', '100000']) ok(`env: ${JSON.stringify(bad)} is refused, naming the variable`, refused(bad));

  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip audit retention DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_auditret_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  try {
    await migrateMod.migrate(pool);
    const count = async (where: string, args: unknown[] = []) =>
      (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE ${where}`, args)).rows[0].n;
    // `n` rows for `org`, each `age` days old.
    const seed = (org: string, n: number, age: number) => pool.query(
      `INSERT INTO audit_log (org_id, actor, action, channel, outcome, at)
       SELECT $1, 'a@x.test', 'rpc', 'dataset:delete', 'ok', now() - $3 * interval '1 day' FROM generate_series(1, $2)`,
      [org, n, age],
    );

    // Two batches and a remainder of old rows, so one pass must loop; recent rows; another org's old rows.
    const old = auditMod.PRUNE_BATCH * 2 + 7;
    await seed('acme', old, 400);
    await seed('acme', 5, 10);
    await seed('acme', 3, 364);
    await seed('beta', 11, 400);

    ok('prune: null days deletes nothing (control)', (await auditMod.pruneAudit(pool, 'acme', null)) === 0 && (await count(`org_id = 'acme'`)) === old + 8);
    ok('prune: 0 days deletes nothing (control)', (await auditMod.pruneAudit(pool, 'acme', 0)) === 0);
    const n = await auditMod.pruneAudit(pool, 'acme', 365);
    ok(`prune: one pass deletes all ${old} rows older than 365 days, over several batches`, n === old, n);
    ok('prune: rows inside the window stay (10 and 364 days old)', (await count(`org_id = 'acme'`)) === 8);
    ok('prune: another org\'s old rows are untouched', (await count(`org_id = 'beta'`)) === 11);
    ok('prune: a second pass finds nothing', (await auditMod.pruneAudit(pool, 'acme', 365)) === 0);

    // The shared sweep runs it for the job's org with the configured days (its other parts need server mode).
    context.enterServerMode(require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ordinate-audit-ret-')));
    shared.wireSharedState(pool, { warn: () => undefined, error: () => undefined } as never, 365);
    await context.runInContext({ user: { email: 'jobs@system', role: 'admin' }, org: { id: 'beta' } }, 'job:shared:sweep:beta', () => shared.sweepOrg(pool));
    ok('sweep: the shared sweep prunes its org with AUDIT_RETENTION_DAYS', (await count(`org_id = 'beta'`)) === 0 && (await count(`org_id = 'acme'`)) === 8);
    shared.wireSharedState(pool, { warn: () => undefined, error: () => undefined } as never, null);
    await seed('beta', 4, 400);
    await context.runInContext({ user: { email: 'jobs@system', role: 'admin' }, org: { id: 'beta' } }, 'job:shared:sweep:beta', () => shared.sweepOrg(pool));
    ok('sweep: unset retention keeps every row (control)', (await count(`org_id = 'beta'`)) === 4);
    shared.unwireSharedState();

    // The log line carries exactly the stored row's fields (differential: the row, read back, against the line).
    const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const sink: import('../src/app/logger').LogSink = {
      debug: () => undefined, warn: () => undefined, error: () => undefined,
      info: (obj, msg) => { lines.push({ obj: obj as Record<string, unknown>, msg }); },
      child: () => sink,
    };
    const prev = logger.useLogger(sink);
    const entry = { org: 'acme', actor: 'ana@acme.test', action: 'rpc', channel: 'dataset:delete', projectId: '87c88b78-c91c-49c9-abf7-bd9b6cbf422b', targets: ['929646dd-e6e0-4f79-a4ad-9fda9c61448d'], outcome: 'ok', requestId: 'req-bu' } as const;
    await auditMod.audit(pool, entry);
    await auditMod.auditMany(pool, [{ org: 'acme', actor: null, action: 'login', outcome: 'denied' }]);
    logger.useLogger(prev);
    const rows = (await pool.query<{ org: string; actor: string | null; action: string; channel: string | null; projectId: string | null; targets: string[]; outcome: string; requestId: string | null }>(
      `SELECT org_id AS org, actor, action, channel, project_id::text AS "projectId", target_ids::text[] AS targets, outcome, request_id AS "requestId"
         FROM audit_log WHERE org_id = 'acme' AND at > now() - interval '1 minute' ORDER BY id`,
    )).rows;
    const logged = lines.filter((l) => l.msg === 'audit').map((l) => l.obj.audit);
    ok('log: one `audit` line per row, audit() and auditMany() alike', logged.length === 2 && rows.length === 2, { logged: logged.length, rows: rows.length });
    ok('log: each line holds exactly its row\'s fields', JSON.stringify(logged) === JSON.stringify(rows), { logged, rows });
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})().catch((e: unknown) => ok('audit retention suite ran', false, e)).finally(finish);
