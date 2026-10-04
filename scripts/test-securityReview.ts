// T6.3 security review — one regression check per finding it fixed
// (docs/phase-7-web/threat-model.md §5). Each section names its finding.
//
//   F1  a dataset `file` origin planted through an imported bundle let
//       `dataset:refresh` read any file the pod can → dropped on the server
//   F2  connection secrets outlived their project, and an imported bundle could
//       reuse a deleted project's connection id → import re-ids connections,
//       delete drops their secrets
//   F3  Postgres connector ran user SQL over the SIMPLE protocol (several
//       statements: `commit; begin read write; …`) and a trailing `--` lifted
//       the row cap → extended protocol, user text on its own line
//   F4  sqlGate missed a file read inside a parenthesised join and
//       `json_execute_serialized_sql`
//   F5  alerts:fired / hub:dataset-refreshed went to every tab of the org →
//       only to members who may read the project
//   F6  dataset:composeSave linked a capture with NO project (no role was ever
//       checked on it) → only the caller's project's captures link
// (The /api/mcp rate limit is in test-webHardening; projects:export → admin in
// test-projects-server's role matrix.)
//
// F3's real-database half and F5 need a Postgres this suite may CREATE DATABASE
// on (DATABASE_URL); without it they print one skip line.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-securityReview.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module'); // any: the loader hook has no public type

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any { // any: Module._load's own signature
  if (request === 'electron') throw new Error('electron is not available in server mode');
  return origLoad.apply(this, [request, ...rest]);
};

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const sse: typeof import('../src/server/sse') = require('../src/server/sse');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const origin: typeof import('../src/data/datasetOrigin') = require('../src/data/datasetOrigin');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const bundle: typeof import('../src/app/bundle') = require('../src/app/bundle');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const configSecrets: typeof import('../src/app/configSecrets') = require('../src/app/configSecrets');
const gate: typeof import('../src/engine/sqlGate') = require('../src/engine/sqlGate');
const history: typeof import('../src/app/history') = require('../src/app/history');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-t63-'));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-t63-outside-'));
const CANARY = 'c4nary-T63-server-file-must-never-load';
const DEV = { user: { email: 'dev@local', role: 'admin' as const }, org: { id: 'default' } };

// any: each channel's own reply shape
type Reply = { status: number; body: any };

function client(base: string) {
  const call = async (channel: string, payload?: unknown): Promise<Reply> => {
    const res = await fetch(`${base}/api/rpc/${channel}`, {
      method: 'POST',
      headers: withCsrf({ 'content-type': 'application/json' }),
      body: wire.encode({ args: payload === undefined ? [] : [payload] }),
    });
    const text = await res.text();
    return { status: res.status, body: res.status === 200 ? wire.decode(text) : text };
  };
  const upload = async (bytes: Buffer, name: string): Promise<string> => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), name);
    const res = await fetch(`${base}/api/files`, { method: 'POST', body: form, headers: withCsrf({}) });
    return ((await res.json()) as { fileToken: string }).fileToken;
  };
  return { call, upload };
}

/** Exports `projectId` as a bundle, lets `edit` rewrite its entries, and returns the re-zipped bytes. */
async function editedBundle(projectId: string, edit: (entries: { name: string; data: Buffer }[]) => void): Promise<Buffer> {
  const out = await context.runInContext(DEV, 'export', () => bundle.exportProject(projectId));
  if (!out) throw new Error('export failed');
  const entries = await bundle.readZipAsync(out.bytes);
  edit(entries);
  return bundle.writeZipAsync(entries);
}

/** An in-memory stand-in for the encrypted store (src/server/secrets/store.ts). */
function memoryStore() {
  const rows = new Map<string, string>();
  const k = (o: string, kind: string, ref: string) => `${o}|${kind}|${ref}`;
  return {
    rows,
    get: async (o: string, kind: string, ref: string) => rows.get(k(o, kind, ref)) ?? null,
    put: async (o: string, kind: string, ref: string, v: string) => void rows.set(k(o, kind, ref), v),
    delete: async (o: string, kind: string, ref: string) => rows.delete(k(o, kind, ref)),
  };
}

async function serverPart(base: string): Promise<void> {
  const { call, upload } = client(base);

  // ── F1: a planted file origin never reads a server file ────────────────────
  const planted = path.join(OUTSIDE, 'other-org.csv');
  fs.writeFileSync(planted, `secret\n${CANARY}\n`);
  ok('control: the planted file is readable by this process (a refusal below is the guard)', fs.readFileSync(planted, 'utf8').includes(CANARY));
  ok('F1: server sanitizeOrigin drops a file origin', origin.sanitizeOrigin({ kind: 'file', path: planted }) === undefined);
  ok('F1: …and keeps a URL origin (only files are server-less)', origin.sanitizeOrigin({ kind: 'url', url: 'https://example.com/a.csv' })?.kind === 'url');

  const src = (await call('projects:create', { name: 'Source' })).body.id as string;
  const dsId = await context.runInContext(DEV, 'seed', async () =>
    (await datasets.saveDataset(src, { name: 'Orders', sourceKind: 'csv', columns: [{ name: 'secret', type: 'text' }], rows: [['public']] }))?.id);
  const hostile = await editedBundle(src, (entries) => {
    const e = entries.find((x) => x.name === `datasets/${dsId}.json`);
    if (!e) throw new Error('no dataset entry');
    const rec = JSON.parse(e.data.toString('utf8'));
    rec.origin = { kind: 'file', path: planted };
    e.data = Buffer.from(JSON.stringify(rec));
  });
  const imp = await call('projects:import', { fileToken: await upload(hostile, 'hostile.ordinate') });
  const imported = imp.body?.project?.id as string;
  ok('F1: the crafted bundle imports (the attack path is real)', imp.status === 200 && imp.body.ok === true && !!imported, JSON.stringify(imp.body).slice(0, 200));
  const list = (await call('dataset:list', { projectId: imported })).body as { id: string }[];
  const newDs = list[0]?.id;
  const rf = await call('dataset:refresh', { projectId: imported, id: newDs });
  ok('F1: dataset:refresh of the planted origin is refused', rf.status === 200 && rf.body?.ok === false, JSON.stringify(rf.body));
  const after = await context.runInContext(DEV, 'read', () => datasets.getDataset(imported, newDs));
  ok('F1: …and the table still holds only the bundle\'s own rows', !!after && JSON.stringify(after.rows) === '[["public"]]', JSON.stringify(after?.rows));
  ok('F1: …and the stored record carries no origin', after?.origin === undefined, JSON.stringify(after?.origin));

  // ── F6: a capture links only into its own project ──────────────────────────
  const capSave = async (captureId: string) => {
    const r = await call('dataset:composeSave', { projectId: src, name: 'From a capture ' + captureId, base: { datasetId: dsId }, joins: [], steps: [], origin: { kind: 'capture', captureId } });
    const saved = r.body?.dataset?.id as string;
    const ds = saved ? await context.runInContext(DEV, 'cap', () => datasets.getDataset(src, saved)) : null;
    const thread = await context.runInContext(DEV, 'cap', () => history.loadThread(captureId));
    return { ok: r.body?.ok === true, linked: !!ds?.capture, threadLinked: !!thread?.datasetId };
  };
  await context.runInContext(DEV, 'cap', async () => {
    await history.saveThread({ id: 'cap-own', projectId: src, cropPath: null, createdAt: new Date().toISOString() });
    await history.saveThread({ id: 'cap-orphan', cropPath: null, createdAt: new Date().toISOString() });
  });
  const own = await capSave('cap-own');
  ok('control: a capture of this project links to the saved dataset', own.ok && own.linked && own.threadLinked, JSON.stringify(own));
  const orphan = await capSave('cap-orphan');
  ok('F6: a capture with no project saves as data but links nothing, and is not written to', orphan.ok && !orphan.linked && !orphan.threadLinked, JSON.stringify(orphan));

  // ── F2: connection secrets do not outlive a project, nor move by bundle ────
  const mem = memoryStore();
  configSecrets.useSecretStore(mem);
  try {
    const victim = (await call('projects:create', { name: 'Victim' })).body.id as string;
    const conn = await context.runInContext(DEV, 'conn', async () => {
      const c = await connections.saveConnection(victim, { connectorId: 'postgres', name: 'Warehouse', values: { host: 'db.example.com', port: 5432, database: 'w', user: 'r' } });
      if (c) await configSecrets.saveConnectionSecrets(c.id, { password: 'victim-pw' });
      return c;
    });
    const connId = conn?.id ?? '';
    ok('control: the victim connection holds a stored password', mem.rows.size === 1 && [...mem.rows.keys()][0].endsWith('|' + connId));
    const reuse = await editedBundle(victim, () => undefined);
    const del = await call('projects:delete', { id: victim });
    ok('F2: projects:delete drops its connections\' stored secrets', del.body?.ok === true && mem.rows.size === 0, JSON.stringify([...mem.rows.keys()]));
    // A bundle naming the deleted project's connection id: re-id'd on import, so it can adopt nothing.
    await context.runInContext(DEV, 'replant', () => mem.put('default', 'connection.password', connId, 'victim-pw'));
    const back = await call('projects:import', { fileToken: await upload(reuse, 'reuse.ordinate') });
    const pid = back.body?.project?.id as string;
    const conns = await context.runInContext(DEV, 'list', () => connections.listConnections(pid));
    ok('F2: an imported connection always gets a fresh id', conns.length === 1 && conns[0].id !== connId, JSON.stringify(conns.map((c) => c.id)));
    const held = await context.runInContext(DEV, 'load', () => configSecrets.loadConnectionSecrets(conns[0]?.id));
    ok('F2: …so it holds no secret it was never given', Object.keys(held).length === 0, JSON.stringify(held));
  } finally {
    configSecrets.useSecretStore(null);
  }
}

function gatePart(): void {
  // ── F4: sqlGate ────────────────────────────────────────────────────────────
  const refused = [
    "SELECT * FROM ('/abs/x.csv' CROSS JOIN range(1))",
    'FROM ("/abs/x.parquet" NATURAL JOIN range(1))',
    'SELECT * FROM (SELECT 1) t, ("/abs/x.parquet" CROSS JOIN (SELECT 2))',
    "SELECT * FROM orders o JOIN ('/etc/passwd' CROSS JOIN range(1)) ON true",
    "SELECT * FROM json_execute_serialized_sql(json_serialize_sql('SELECT 1'))",
  ];
  for (const sql of refused) ok(`F4: gate refuses ${sql}`, gate.readOnlyError(sql, new Set(['orders'])) !== null);
  const allowed = [
    'SELECT * FROM (SELECT a, b FROM orders) t',
    'SELECT * FROM (orders JOIN regions USING (region))',
    "SELECT * FROM (VALUES (1, 'x.csv'), (2, 'y')) v(n, s)",
    "SELECT json_extract(payload, '$.a') FROM orders",
  ];
  for (const sql of allowed) ok(`F4: gate still allows ${sql}`, gate.readOnlyError(sql, new Set(['orders', 'regions'])) === null, gate.readOnlyError(sql, new Set(['orders', 'regions'])));
}

async function dbPart(adminUrl: string): Promise<void> {
  const dbName = `ordinate_t63_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  try {
    // ── F3: the Postgres connector against a real server ─────────────────────
    const pg = (require('../src/connectors/postgres') as typeof import('../src/connectors/postgres')).CONNECTORS.find((c) => c.id === 'postgres');
    if (!pg || !pg.run) throw new Error('no postgres connector');
    process.env.SSRF_ALLOW = '127.0.0.1/32,::1/128';
    const ctxFor = (rowLimit: number) => ({
      values: { host: scratch.hostname === 'localhost' ? '127.0.0.1' : scratch.hostname, port: Number(scratch.port || 5432), database: dbName, user: decodeURIComponent(scratch.username), ssl: false, sslInsecure: false },
      secrets: { password: decodeURIComponent(scratch.password) },
      rowLimit,
      timeoutMs: 15_000,
    });
    // The tail re-opens a sub-select so the wrapper's own `) as _ord_wrap limit N` closes it: valid SQL.
    const escape = await context.runInContext(DEV, 'pg', () =>
      pg.run!(ctxFor(10), 'select 1 ) x; commit; begin read write; create table t63_pwned (x int); commit; select * from (select 1'));
    const made = await pool.query("SELECT to_regclass('public.t63_pwned') AS t");
    ok('F3: `select 1 ) x; commit; begin read write; create table …; select * from (select 1` is refused', escape.ok === false, JSON.stringify(escape).slice(0, 200));
    ok('F3: …and nothing was written on the source database', made.rows[0].t === null, JSON.stringify(made.rows));
    const capped = await context.runInContext(DEV, 'pg', () => pg.run!(ctxFor(5), 'select * from generate_series(1, 50) ) x --'));
    ok('F3: a trailing -- cannot lift the row cap (refused or capped at 5)', capped.ok === false || (capped.rows.length <= 5 && capped.truncated === true), JSON.stringify(capped).slice(0, 200));
    const plain = await context.runInContext(DEV, 'pg', () => pg.run!(ctxFor(5), 'select n from generate_series(1, 50) n -- trailing note'));
    ok('control: an ordinary query with a trailing comment still runs, capped', plain.ok === true && plain.rows.length === 5 && plain.truncated === true, JSON.stringify(plain).slice(0, 200));

    // ── F5: tick pushes reach only the project's readers ─────────────────────
    const migrate = (require('../src/server/db/migrate') as typeof import('../src/server/db/migrate')).migrate;
    await migrate(pool);
    const project = '11111111-2222-4333-8444-555555555555';
    await pool.query("INSERT INTO orgs (id, name) VALUES ('default', 'default')");
    const ids = (await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (org_id, email, role) VALUES ('default', 'boss@x.test', 'admin'), ('default', 'reader@x.test', 'viewer'),
              ('default', 'teamed@x.test', 'viewer'), ('default', 'outsider@x.test', 'editor') RETURNING id, email`)).rows;
    const id = (e: string) => ids.find((r) => r.email === e)?.id;
    await pool.query("INSERT INTO project_grants (org_id, project_id, user_id, role) VALUES ('default', $1, $2, 'viewer')", [project, id('reader@x.test')]);
    const team = (await pool.query<{ id: string }>("INSERT INTO teams (org_id, name) VALUES ('default', 'Ops') RETURNING id")).rows[0].id;
    await pool.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)', [team, id('teamed@x.test')]);
    await pool.query("INSERT INTO project_grants (org_id, project_id, team_id, role) VALUES ('default', $1, $2, 'viewer')", [project, team]);
    const schedules = require('../src/server/jobs/schedules') as typeof import('../src/server/jobs/schedules');
    const sent: { user?: string; channel: string }[] = [];
    sse.setFanOut((t, channel) => sent.push({ user: t.user, channel }));
    await context.runInContext(DEV, 'tick', () => schedules.toReaders(pool, false, project, 'alerts:fired', { projectId: project, events: [] }));
    const to = sent.map((s) => s.user).sort().join();
    ok('F5: alerts:fired goes to the org admin, the grantee and the team member — not the org editor without a grant',
      to === 'boss@x.test,reader@x.test,teamed@x.test' && sent.every((s) => s.channel === 'alerts:fired'), to);
    sent.length = 0;
    await context.runInContext(DEV, 'tick', () => schedules.toReaders(pool, true, project, 'alerts:fired', {}));
    ok('F5: dev sign-in (one identity, an admin) still gets it org-wide', sent.length === 1 && sent[0].user === undefined, JSON.stringify(sent));
    sse.setFanOut(null);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
}

(async () => {
  ok('desktop control: a file origin is kept before server mode (the desktop re-reads its own file)', origin.sanitizeOrigin({ kind: 'file', path: path.join(OUTSIDE, 'x.csv') })?.kind === 'file');
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  gatePart();
  const app: FastifyInstance = appMod.buildApp(envMod.parseEnv({ LOG_LEVEL: 'silent', DATA_DIR: DATA, ORDINATE_ENV: 'dev' }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  try {
    await serverPart(`http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`);
  } finally {
    await app.close();
  }
  if (process.env.DATABASE_URL) await dbPart(process.env.DATABASE_URL);
  else console.log('skip T6.3 DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
})()
  .catch((err) => ok('threw: ' + String(err && (err as Error).stack), false))
  .finally(() => {
    duck.shutdown();
    for (const dir of [DATA, OUTSIDE]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    finish();
  });
