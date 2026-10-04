// The authorization matrix against a real Postgres, over real HTTP (T3.3).
//
// Two orgs (acme, beta), each its own server process-in-a-process (header
// sign-in from a trusted 127.0.0.1 peer, one shared database and DATA_DIR,
// server mode, no Electron). Every caller × channel × project cell goes
// through POST /api/rpc/<channel>; the expected table is asserted in FULL and
// printed. Every real handler is wrapped in a spy: a denied call must never
// reach it, an allowed one must, exactly once. Then: list trimming, the
// creator's grant, sharing, the audit trail (and a canary that no input value
// reaches it), and the measured cost of a decision.
//
// Needs a Postgres it may CREATE DATABASE on; without DATABASE_URL it prints
// one skip line. Every run makes its own scratch database and drops it.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-authz-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { randomUUID }: typeof import('crypto') = require('crypto');
const Module: any = require('module'); // any: the loader hook has no public type

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any { // any: Module._load's own signature
  if (request === 'electron') throw new Error('electron is not available in server mode');
  return origLoad.apply(this, [request, ...rest]);
};

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const authz: typeof import('../src/server/authz/index') = require('../src/server/authz/index');
const api: typeof import('../src/api/index') = require('../src/api/index');

const CANARY = 'c4nary-Z9-audit-must-never-hold-this';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-authz-db-'));

type Cell = 'allow' | 'deny';

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip authz DB matrix: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_t33_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  const apps: FastifyInstance[] = [];
  try {
    context.enterServerMode(DATA);
    appMod.registerHandlers();

    // A spy around EVERY contracted handler: counts, then delegates to the real one.
    const calls = new Map<string, number>();
    for (const ch of Object.keys(api.contracts)) {
      const real = rpc.handlers.get(ch);
      if (!real) continue;
      rpc.registry.removeHandler(ch);
      rpc.registry.handle(ch, (e, ...args) => {
        calls.set(ch, (calls.get(ch) ?? 0) + 1);
        return real(e, ...args);
      });
    }
    const ran = (ch: string) => calls.get(ch) ?? 0;

    const base: Record<string, string> = {};
    for (const org of ['acme', 'beta']) {
      const app = appMod.buildApp(envMod.parseEnv({
        LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header',
        TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: org, ORDINATE_ADMIN_EMAIL: `boss@${org}.test`,
      }));
      apps.push(app);
      await app.listen({ port: 0, host: '127.0.0.1' });
      base[org] = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
    }
    const tables = await pool.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`);
    ok('schema: 0006 created project_grants and audit_log', ['project_grants', 'audit_log'].every((t) => tables.rows.some((r) => r.t === t)));

    const call = async (org: string, email: string, channel: string, payload?: unknown) => {
      const res = await fetch(`${base[org]}/api/rpc/${channel}`, {
        method: 'POST',
        headers: withCsrf({ 'content-type': 'application/json', 'x-forwarded-email': email }),
        body: wire.encode({ args: payload === undefined ? [] : [payload] }),
      });
      const text = await res.text();
      return { status: res.status, body: (res.status === 200 ? wire.decode(text) : text) as any }; // any: each channel's own reply
    };

    // ── People: org roles set the way T3.4's admin will (rows), teams too ──
    // A header-mode first request provisions a member as viewer.
    const people = ['boss', 'alice', 'bob', 'carol', 'dave'];
    for (const p of people) await call('acme', `${p}@acme.test`, 'projects:list');
    await call('beta', 'boss@beta.test', 'projects:list');
    await pool.query(`UPDATE users SET role = 'editor' WHERE email = 'carol@acme.test'`);
    const uid = async (email: string) => (await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
    const team = (await pool.query<{ id: string }>(`INSERT INTO teams (org_id, name) VALUES ('acme', 'Analysts') RETURNING id`)).rows[0].id;
    await pool.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)', [team, await uid('bob@acme.test')]);
    ok('people: boss is org admin by ORDINATE_ADMIN_EMAIL, the rest viewers except carol (editor)',
      (await pool.query(`SELECT string_agg(split_part(email, '@', 1) || ':' || role, ',' ORDER BY email) AS s FROM users WHERE org_id = 'acme'`)).rows[0].s
        === 'alice:viewer,bob:viewer,boss:admin,carol:editor,dave:viewer');

    // ── Projects, created over RPC: the creator's grant ───────────────────
    const created = async (org: string, email: string, name: string) => {
      const r = await call(org, email, 'projects:create', { name });
      if (r.status !== 200) throw new Error(`projects:create ${r.status} ${r.body}`);
      return (r.body as { id: string }).id;
    };
    const own = await created('acme', 'boss@acme.test', CANARY);
    const other = await created('acme', 'boss@acme.test', 'Other');
    const foreign = await created('beta', 'boss@beta.test', 'Beta');
    const carols = await created('acme', 'carol@acme.test', 'Carol\'s');
    const grantOf = async (pid: string, email: string) =>
      (await pool.query<{ role: string }>('SELECT g.role FROM project_grants g JOIN users u ON u.id = g.user_id WHERE g.project_id = $1 AND u.email = $2', [pid, email])).rows[0]?.role;
    ok('creation: the creator is granted admin on the new project', (await grantOf(own, 'boss@acme.test')) === 'admin' && (await grantOf(carols, 'carol@acme.test')) === 'admin');
    ok('creation: an org viewer may not create a project (403, handler never ran)', await (async () => {
      const n = ran('projects:create');
      return (await call('acme', 'alice@acme.test', 'projects:create', { name: 'nope' })).status === 403 && ran('projects:create') === n;
    })());
    ok('creation: carol (org editor) reads her own project', (await call('acme', 'carol@acme.test', 'dataset:list', { projectId: carols })).status === 200);

    // ── Sharing over RPC (project admin), viewer / team editor / user admin ──
    const share = (email: string, projectId: string, member: unknown, role: string | null) => call('acme', email, 'project:share', { projectId, member, role });
    const shares = [
      await share('boss@acme.test', own, { userId: await uid('alice@acme.test') }, 'viewer'),
      await share('boss@acme.test', own, { teamId: team }, 'editor'),
      await share('boss@acme.test', own, { userId: await uid('carol@acme.test') }, 'admin'),
    ];
    ok('share: three grants written', shares.every((s) => s.status === 200 && s.body.ok === true), JSON.stringify(shares));
    const acc = await call('acme', 'alice@acme.test', 'project:access', { projectId: own });
    ok('project:access: a viewer sees who holds which role', acc.status === 200 && acc.body.length === 4 && acc.body.some((g: { kind: string; label: string; role: string }) => g.kind === 'team' && g.label === 'Analysts' && g.role === 'editor'), JSON.stringify(acc.body));
    const betaUser = await uid('boss@beta.test');
    ok('share: a user of ANOTHER org is refused as unknown', (await share('boss@acme.test', own, { userId: betaUser }, 'viewer')).body.ok === false);
    ok('share: the DB refuses a cross-org grant row outright', await pool.query(`INSERT INTO project_grants (org_id, project_id, user_id, role) VALUES ('acme', $1, $2, 'viewer')`, [own, betaUser]).then(() => false, () => true));

    // ── The matrix ─────────────────────────────────────────────────────────
    const dave = await uid('dave@acme.test');
    const channels = {
      read: (projectId: string) => ['dataset:list', { projectId }] as const,
      write: (projectId: string) => ['quality:run', { projectId, datasetId: randomUUID() }] as const,
      admin: (projectId: string) => ['project:share', { projectId, member: { userId: dave }, role: 'viewer' }] as const,
    };
    const targets = { own, 'other project': other, 'other org': foreign };
    const callers: [string, string][] = [
      ['viewer (user grant)', 'alice@acme.test'],
      ['editor (team grant)', 'bob@acme.test'],
      ['admin (project grant)', 'carol@acme.test'],
      ['org admin', 'boss@acme.test'],
    ];
    // Expected, in full: a project role reaches only its own project; an org
    // admin reaches every project of ITS org and nothing of another.
    const expected: Record<string, Cell[]> = {
      'viewer (user grant)':   ['allow', 'deny', 'deny',   'deny', 'deny', 'deny',   'deny', 'deny', 'deny'],
      'editor (team grant)':   ['allow', 'allow', 'deny',  'deny', 'deny', 'deny',   'deny', 'deny', 'deny'],
      'admin (project grant)': ['allow', 'allow', 'allow', 'deny', 'deny', 'deny',   'deny', 'deny', 'deny'],
      'org admin':             ['allow', 'allow', 'allow', 'allow', 'allow', 'allow', 'deny', 'deny', 'deny'],
    };
    const got: Record<string, Cell[]> = {};
    const header: string[] = [];
    let unexpectedAllows = 0;
    let leaks = 0;
    let misses = 0;
    for (const [label, email] of callers) {
      got[label] = [];
      for (const [tname, pid] of Object.entries(targets)) {
        for (const [access, mk] of Object.entries(channels)) {
          if (got[label].length < 9 && header.length < 9) header.push(`${tname}/${access}`);
          const [ch, payload] = mk(pid);
          const n = ran(ch);
          const r = await call('acme', email, ch, payload);
          const cell: Cell = r.status === 403 ? 'deny' : 'allow';
          got[label].push(cell);
          const want = expected[label][got[label].length - 1];
          if (cell === 'allow' && want === 'deny') unexpectedAllows++;
          if (cell === 'deny' && ran(ch) !== n) leaks++;
          if (cell === 'allow' && (ran(ch) !== n + 1 || r.status !== 200)) misses++;
          if (r.status !== 200 && r.status !== 403) misses++;
        }
      }
    }
    const w = Math.max(...callers.map(([l]) => l.length));
    console.log('\n     ' + ''.padEnd(w) + ' | ' + header.map((h) => h.padEnd(20)).join(''));
    for (const [label] of callers) console.log('     ' + label.padEnd(w) + ' | ' + got[label].map((c) => (c === 'allow' ? 'ALLOW' : 'deny').padEnd(20)).join(''));
    console.log('');
    ok('matrix: ZERO unexpected allows', unexpectedAllows === 0, unexpectedAllows);
    ok('matrix: every cell equals the expected table', JSON.stringify(got) === JSON.stringify(expected), JSON.stringify(got));
    ok('matrix: a denied call never reached its handler (spy)', leaks === 0, leaks);
    ok('matrix: an allowed call reached its handler exactly once, with a 200', misses === 0, misses);

    // The other direction: beta's org admin, every access level, acme's projects.
    for (const [access, mk] of Object.entries(channels)) {
      const [ch, payload] = mk(own);
      const n = ran(ch);
      const r = await call('beta', 'boss@beta.test', ch, payload);
      ok(`other org: beta's org admin, ${access} on acme's project → 403, handler never ran`, r.status === 403 && ran(ch) === n, r.status);
    }

    // ── Org-level channels by org role ────────────────────────────────────
    const orgExpected: Record<string, [number, number]> = { 'alice@acme.test': [200, 403], 'carol@acme.test': [200, 200], 'boss@acme.test': [200, 200] };
    for (const [email, [wantList, wantCreate]] of Object.entries(orgExpected)) {
      const l = await call('acme', email, 'projects:list');
      const c = await call('acme', email, 'projects:create', { name: 'org-level' });
      ok(`org level: ${email.split('@')[0]} projects:list ${wantList}, projects:create ${wantCreate}`, l.status === wantList && c.status === wantCreate, `${l.status} ${c.status}`);
    }

    // ── Lists trimmed to what the caller may read ─────────────────────────
    const listOf = async (org: string, email: string) => ((await call(org, email, 'projects:list')).body as { id: string }[]).map((p) => p.id);
    const aliceSees = await listOf('acme', 'alice@acme.test');
    ok('projects:list: alice sees only the project shared with her', aliceSees.length === 1 && aliceSees[0] === own, aliceSees.join());
    ok('projects:list: bob sees it through his team', (await listOf('acme', 'bob@acme.test')).join() === own);
    ok('projects:list: dave (granted viewer by the matrix) sees exactly own and other', (await listOf('acme', 'dave@acme.test')).sort().join() === [own, other].sort().join());
    const bossSees = await listOf('acme', 'boss@acme.test');
    ok('projects:list: the org admin sees every acme project and no beta one', [own, other, carols].every((p) => bossSees.includes(p)) && !bossSees.includes(foreign));
    ok('projects:list: beta sees only beta', (await listOf('beta', 'boss@beta.test')).every((p) => p !== own && p !== other));
    const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
    const ident = (org: string): import('../src/server/context').Identity => ({ user: { email: `boss@${org}.test`, role: 'admin' }, org: { id: org } });
    await context.runInContext(ident('acme'), 'seed', async () => {
      for (const [pid, name] of [[own, 'Shared rows'], [other, 'Hidden rows']]) {
        await datasets.saveDataset(pid, { name, sourceKind: 'csv', columns: [{ name: 'a', type: 'number' }], rows: [[1]] });
      }
    });
    const rec = (await call('acme', 'alice@acme.test', 'recent:list', { limit: 50 })).body as { projectId: string; name: string }[];
    ok('recent:list: alice gets her project\'s records and none of another\'s', rec.some((r) => r.name === 'Shared rows') && rec.every((r) => r.projectId === own), JSON.stringify(rec));

    // ── Audit trail ───────────────────────────────────────────────────────
    const trail = await pool.query<{ channel: string; actor: string; outcome: string; project_id: string | null; target_ids: string[]; request_id: string | null; j: string }>(
      `SELECT channel, actor, outcome, project_id, target_ids, request_id, row_to_json(a)::text AS j FROM audit_log a WHERE action = 'rpc' ORDER BY id`);
    const rows = trail.rows;
    console.log(`     audit: ${rows.length} rpc rows, e.g. ${JSON.stringify((({ j: _j, ...r }) => r)(rows.find((r) => r.channel === 'quality:run' && r.outcome === 'ok') ?? rows[0]))}`);
    ok('audit: every allowed write in the matrix has an ok row naming its project and dataset',
      rows.filter((r) => r.channel === 'quality:run' && r.outcome === 'ok').length === 4
        && rows.filter((r) => r.channel === 'quality:run' && r.outcome === 'ok').every((r) => r.project_id !== null && r.target_ids.length === 2));
    ok('audit: denied writes and admin calls are rows too (outcome denied)', rows.filter((r) => r.outcome === 'denied').length >= 15, rows.filter((r) => r.outcome === 'denied').length);
    ok('audit: role changes (project:share) are rows naming the member id', rows.some((r) => r.channel === 'project:share' && r.outcome === 'ok' && r.target_ids.includes(team)));
    ok('audit: a project creation names the created project', rows.some((r) => r.channel === 'projects:create' && r.outcome === 'ok' && r.target_ids.includes(own) && r.actor === 'boss@acme.test'));
    ok('audit: reads are not audited', !rows.some((r) => ['dataset:list', 'projects:list', 'recent:list', 'project:access'].includes(r.channel)));
    ok('audit: each row carries the request id', rows.every((r) => !!r.request_id));
    ok('audit (canary): no input value in any row — the project name was only ever a value', !rows.some((r) => r.j.includes(CANARY) || r.j.includes('c4nary')), rows.find((r) => r.j.includes('c4nary'))?.j);
    const dump = (await pool.query<{ j: string }>(`SELECT json_agg(a)::text AS j FROM audit_log a`)).rows[0].j;
    ok('audit (canary): the whole table, dumped, holds no input value', !dump.includes('c4nary'));

    // ── Measured: the cost of one decision ────────────────────────────────
    const readC = api.contractFor('dataset:list')!;
    const N = 400;
    const time = async (email: string, role: 'viewer' | 'admin', allowed: boolean) => {
      const who: import('../src/server/context').Identity = { user: { email, role }, org: { id: 'acme' } };
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) {
        const d = await context.runInContext(who, 'bench', () => authz.authorize(readC, { projectId: own }, who, pool));
        if (d.ok !== allowed) throw new Error('bench decision changed');
      }
      return Number(process.hrtime.bigint() - t0) / N / 1e3;
    };
    const asMember = await time('alice@acme.test', 'viewer', true);
    const asAdmin = await time('boss@acme.test', 'admin', true);
    console.log(`     authorize(): member (project.json read + 1 grant query) ${asMember.toFixed(0)} µs, org admin (project.json read only) ${asAdmin.toFixed(0)} µs, mean of ${N}`);
    // The timing above is printed, not asserted: a wall-clock bound fails on a loaded runner
    // (20 ms at load 31, ~330 µs idle). What must not regress is the WORK per decision: one
    // grant query for a member, none for an org admin. Counted through a wrapping pool.
    const queriesFor = async (email: string, role: 'viewer' | 'admin'): Promise<number> => {
      let n = 0;
      const counting = { query: (...a: unknown[]) => { n++; return (pool.query as (...x: unknown[]) => unknown)(...a); } } as unknown as typeof pool;
      const who: import('../src/server/context').Identity = { user: { email, role }, org: { id: 'acme' } };
      await context.runInContext(who, 'count', () => authz.authorize(readC, { projectId: own }, who, counting));
      return n;
    };
    const memberQ = await queriesFor('alice@acme.test', 'viewer');
    const adminQ = await queriesFor('boss@acme.test', 'admin');
    ok('measured: a member decision is exactly one query, an org admin\'s none', memberQ === 1 && adminQ === 0, `${memberQ} ${adminQ}`);
  } finally {
    for (const a of apps) await a.close().catch(() => undefined);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
