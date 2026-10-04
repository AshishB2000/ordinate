// Connections on the server (T2.5), over real HTTP.
//
// The proof this file exists for (T5.3's required follow-up): a canary password
// saved through the UI's path — `connection:testAndSave` → src/ipc/connections
// → the encrypted store — appears NOWHERE: not in any file under DATA_DIR
// (config.json included), not in a dump of the database (every table, and
// pg_dump), not in the server's trace-level log or this process's output, not
// in any RPC reply. And it IS used: the Postgres connector receives it on every
// run. A server WITHOUT the store refuses the secret and writes nothing.
//
// Also: the three local-file sources are gone from the registry on the server
// (and present on the desktop); a secret is replaced only after a test passes;
// one project cannot delete another project's connection secret; every channel
// the web screen calls has a contract and a handler.
//
// The Postgres part needs a server it may CREATE DATABASE on (DATABASE_URL);
// without it this prints one skip line and runs the rest.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-connections-server.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { execFileSync } from 'child_process';
import { createSecretKey, randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Writable } from 'stream';
import { Client, Pool } from 'pg';

// ── Capture every byte this process prints ─────────────────────────────────
let captured = '';
for (const s of [process.stdout, process.stderr]) {
  const orig = s.write.bind(s) as (...a: unknown[]) => boolean;
  (s as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    captured += String(chunk);
    return orig(chunk, ...rest);
  };
}

// The desktop half runs first against a stubbed Electron; then Electron is
// made unloadable, as on a server.
const desktopUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-t25-desk-'));
let electronOk = true;
const Module = require('module') as { _load: (req: string, ...rest: unknown[]) => unknown };
const origLoad = Module._load;
Module._load = function (request: string, ...rest: unknown[]): unknown {
  if (request === 'electron') {
    if (!electronOk) throw new Error('electron is not available in server mode');
    return { app: { getPath: () => desktopUserData } };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const registry: typeof import('../src/connectors/index') = require('../src/connectors/index');
const configSecrets: typeof import('../src/app/configSecrets') = require('../src/app/configSecrets');
const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const store: typeof import('../src/server/secrets/store') = require('../src/server/secrets/store');
const api: typeof import('../src/api/index') = require('../src/api/index');
const connApi: typeof import('../src/api/connections') = require('../src/api/connections');

const LOCAL = ['duckdb-file', 'parquet-folder', 'csv-folder'];
const CANARY = `Canary/pw+${randomBytes(6).toString('hex')}=x y`;
const CANARY2 = `Second/pw+${randomBytes(6).toString('hex')}`;
const MASTER = randomBytes(32);

/** Every spelling a leak could take: plain, URL-encoded, hex, base64/base64url at all 3 alignments (as test-secrets). */
function spellings(v: string): string[] {
  const b = Buffer.from(v);
  const out = new Set<string>([v, encodeURIComponent(v), encodeURI(v), v.replace(/ /g, '+'), b.toString('hex')]);
  for (let off = 0; off < 3; off++) {
    const sub = b.subarray(off);
    const whole = sub.subarray(0, sub.length - (sub.length % 3));
    out.add(whole.toString('base64'));
    out.add(whole.toString('base64url'));
  }
  return [...out].filter((x) => x.length >= 8).map((x) => x.toLowerCase());
}
const NEEDLES = [...spellings(CANARY), ...spellings(CANARY2)];
const leaks = (hay: string): boolean => {
  const h = hay.toLowerCase();
  return NEEDLES.some((n) => h.includes(n));
};

/** Every file under `dir`, concatenated (binary as latin1, so a byte-for-byte match still shows). */
function readTree(dir: string): string {
  let out = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out += readTree(p);
    else if (e.isFile()) out += p + '\n' + fs.readFileSync(p).toString('latin1') + '\n';
  }
  return out;
}

type Reply = { status: number; body: any }; // any: each channel's own reply shape
let replies = '';
let appLog = '';
const logStream = () => new Writable({ write(c: Buffer, _e, cb) { appLog += c.toString(); cb(); } });

/** Header sign-in for the Postgres half (dev auth has no users row to grant a project to). */
let signIn: Record<string, string> = {};

async function call(base: string, channel: string, payload?: unknown): Promise<Reply> {
  const res = await fetch(`${base}/api/rpc/${channel}`, {
    method: 'POST',
    headers: withCsrf({ 'content-type': 'application/json', ...signIn }),
    body: wire.encode({ args: payload === undefined ? [] : [payload] }),
  });
  const text = await res.text();
  replies += text + '\n';
  return { status: res.status, body: res.status === 200 ? wire.decode(text) : text };
}

async function listen(env: Record<string, string>): Promise<{ base: string; close: () => Promise<void> }> {
  const app = appMod.buildApp(envMod.parseEnv({ LOG_LEVEL: 'trace', ...env }), logStream());
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as import('net').AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, close: () => app.close() };
}

(async () => {
  // ── The grep sees what it is looking for (negative control) ───────────────
  const b = Buffer.from(CANARY);
  ok('grep: planted spellings of the canary are found', [CANARY, encodeURIComponent(CANARY), b.toString('hex'), b.subarray(1).toString('base64url')].every((p) => leaks(`x ${p} y`)));
  ok('grep: an unrelated string is clean', !leaks('nothing ' + randomBytes(24).toString('base64')));

  // ── Desktop: every source, and secrets in config.json as before ───────────
  ok('desktop: capabilities().localFiles', registry.capabilities().localFiles === true);
  ok('desktop: the three local-file sources are offered', LOCAL.every((id) => registry.getConnector(id) !== null && registry.connectorCatalog().some((c) => c.id === id)));
  const deskId = randomUUID();
  await configSecrets.saveConnectionSecrets(deskId, { password: 'desk-pw' });
  ok('desktop: saveConnectionSecrets still writes config.json (unchanged)', configSecrets.getConnectionSecret(deskId).password === 'desk-pw'
    && (await configSecrets.loadConnectionSecrets(deskId)).password === 'desk-pw');
  await configSecrets.dropConnectionSecrets(deskId);
  ok('desktop: dropConnectionSecrets removes it', !configSecrets.getConnectionSecret(deskId).password);

  // ── Server mode ───────────────────────────────────────────────────────────
  electronOk = false;
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-t25-srv-'));
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  // The source Postgres is on localhost, which the SSRF guard refuses on a server
  // (T6.1); an operator opens an internal database the same way.
  process.env.SSRF_ALLOW = '127.0.0.1/32,::1/128';

  ok('server: capabilities().localFiles is false', registry.capabilities().localFiles === false);
  ok('server: no local-file source in the catalog, listConnectors or getConnector',
    LOCAL.every((id) => registry.getConnector(id) === null && !registry.connectorCatalog().some((c) => c.id === id) && !registry.listConnectors().some((d) => d.id === id)));
  ok('server: URL stays', registry.getConnector('url') !== null && registry.connectorCatalog().some((c) => c.id === 'url'));

  const channels = Object.keys(connApi.connections);
  ok(`contracts: all ${channels.length} connection channels are in the merged contracts`, channels.every((c) => api.contractFor(c) !== undefined));
  ok('contracts: every connection channel has a server handler', [...channels, 'dataset:update', 'dataset:list'].every((c) => rpc.handlers.has(c)),
    channels.filter((c) => !rpc.handlers.has(c)).join());
  const readOnly = new Set(['connectors:catalog', 'connectors:logos', 'connections:list']);
  ok('contracts: everything that uses or changes a connection needs write; only the lists are read',
    channels.every((c) => api.contractFor(c)!.access === (readOnly.has(c) ? 'read' : 'write')) && api.contractFor('dataset:update')!.access === 'write');

  // ── Without a database the secret is refused, and nothing is written ──────
  {
    const srv = await listen({ DATA_DIR: DATA });
    const project = (await call(srv.base, 'projects:create', { name: 'No DB' })).body.id as string;
    const r = await call(srv.base, 'connection:testAndSave', {
      projectId: project, connectorId: 'postgres', values: { host: '127.0.0.1', port: 1, database: 'x' }, secrets: { password: CANARY },
    });
    ok('no store: a secret is refused with the clear error', r.status === 200 && r.body.ok === false && r.body.error === configSecrets.NO_SECRET_STORE, JSON.stringify(r.body));
    ok('no store: no connection was saved', (await call(srv.base, 'connections:list', { projectId: project })).body.length === 0);
    const local = await call(srv.base, 'connection:testAndSave', { projectId: project, connectorId: 'csv-folder', values: { path: '/etc' } });
    ok('no store: a local-file source is an unknown kind on the server', local.body.ok === false && /Unknown connection kind/.test(local.body.error), JSON.stringify(local.body));
    const big = await call(srv.base, 'connection:run', { projectId: project, connId: randomUUID(), limit: 2_000_000 });
    ok('contract: a row limit above the app cap is a 400 at the door', big.status === 400, big.status);
    ok('no store: the canary is in no file under DATA_DIR (config.json included)', !leaks(readTree(DATA)));
    await srv.close();
  }

  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip Postgres checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    ok('log/output: no canary anywhere', !leaks(appLog + captured + replies));
    fs.rmSync(DATA, { recursive: true, force: true });
    return;
  }

  // ── With Postgres + a master key: the encrypted store ─────────────────────
  const stamp = `${process.pid}_${Date.now()}`;
  const appDb = `ordinate_t25_${stamp}`;
  const srcDb = `ordinate_t25_src_${stamp}`;
  const at = (db: string): string => { const u = new URL(adminUrl); u.pathname = '/' + db; return u.toString(); };
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${appDb}`);
  await root.query(`CREATE DATABASE ${srcDb}`);
  const pool = new Pool({ connectionString: at(appDb), max: 2 });
  try {
    const src = new Client({ connectionString: at(srcDb) });
    await src.connect();
    await src.query(`CREATE SCHEMA sales; CREATE TABLE sales.orders (id int, region text, amount numeric);
      INSERT INTO sales.orders SELECT g, (ARRAY['North','South','East'])[1 + g % 3], g * 1.5 FROM generate_series(1, 40) g;`);
    await src.end();

    // The Postgres connector, watched: what secret does each socket it opens carry?
    const pg = registry.getConnector('postgres')!;
    const seen: string[] = [];
    const origList = pg.listTables.bind(pg);
    const origRun = pg.run.bind(pg);
    pg.listTables = (ctx) => { seen.push(ctx.secrets.password ?? ''); return origList(ctx); };
    pg.run = (ctx, sql) => { seen.push(ctx.secrets.password ?? ''); return origRun(ctx, sql); };

    const ADMIN = 'owner@acme.test';
    signIn = { 'x-forwarded-email': ADMIN };
    const srv = await listen({
      DATA_DIR: DATA, DATABASE_URL: at(appDb), ORDINATE_MASTER_KEY: MASTER.toString('base64'),
      AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ADMIN_EMAIL: ADMIN,
    });
    const project = (await call(srv.base, 'projects:create', { name: 'Warehouse' })).body.id as string;
    const other = (await call(srv.base, 'projects:create', { name: 'Elsewhere' })).body.id as string;
    const u = new URL(adminUrl);
    const values = { host: u.hostname, port: Number(u.port || 5432), database: srcDb, user: decodeURIComponent(u.username) };

    const saved = await call(srv.base, 'connection:testAndSave', { projectId: project, connectorId: 'postgres', name: 'Orders DB', values, secrets: { password: CANARY } });
    ok('testAndSave: tested and saved with the canary password', saved.status === 200 && saved.body.ok === true, JSON.stringify(saved.body));
    const connId = saved.body.connection?.id as string;
    ok('testAndSave: the reply says the password is set — as a boolean', saved.body.connection?.secretSet?.password === true);
    ok('testAndSave: the connector received the canary', seen.length > 0 && seen.every((p) => p === CANARY), seen.length);

    const enc = store.createSecretStore(pool, createSecretKey(MASTER));
    ok('store: the password is in the encrypted store under (org, connection.password, connId)', (await enc.get('default', 'connection.password', connId)) === CANARY);

    const list = await call(srv.base, 'connections:list', { projectId: project });
    ok('list: one connection, password set, no value', list.body.length === 1 && list.body[0].secretSet.password === true && !('password' in list.body[0].values));

    seen.length = 0;
    const tables = await call(srv.base, 'connection:listTables', { projectId: project, connId });
    ok('listTables: sales.orders, run with the stored canary', tables.body.ok && tables.body.tables.some((t: { schema?: string; name: string }) => t.schema === 'sales' && t.name === 'orders') && seen.every((p) => p === CANARY) && seen.length > 0, JSON.stringify(tables.body));
    const desc = await call(srv.base, 'connection:describe', { projectId: project, connId, table: 'sales.orders' });
    ok('describe: three columns', desc.body.ok && desc.body.schema.columns.length === 3, JSON.stringify(desc.body));
    const sample = await call(srv.base, 'connection:sample', { projectId: project, connId, table: 'sales.orders', limit: 500 });
    ok('sample: 40 rows', sample.body.ok && sample.body.preview.rows.length === 40);
    const bounded = await call(srv.base, 'connection:run', { projectId: project, connId, tableOrQuery: { query: 'select * from sales.orders' }, limit: 7 });
    ok('run: the row bound is applied server side (7 of 40)', bounded.body.ok && bounded.body.preview.rows.length === 7, JSON.stringify(bounded.body).slice(0, 200));
    const explain = await call(srv.base, 'connection:explain', { projectId: project, connId, sql: 'select region, amount from sales.orders' });
    ok('explain: two columns, no rows', explain.body.ok && explain.body.columns.length === 2);
    const write = await call(srv.base, 'connection:run', { projectId: project, connId, tableOrQuery: { query: 'delete from sales.orders' } });
    ok('run: a write statement is refused (read-only connector)', write.body.ok === false, JSON.stringify(write.body));
    const qs = await call(srv.base, 'connection:saveQuery', { projectId: project, connId, name: 'By region', sql: 'select region, count(*) as n from sales.orders group by region order by region' });
    ok('saveQuery: the whole list back', qs.body.ok && qs.body.queries.length === 1);
    const imp = await call(srv.base, 'connection:import', { projectId: project, connId, name: 'Regions', sql: qs.body.queries[0].sql, queryId: qs.body.queries[0].id, limit: 100_000 });
    ok('import: a dataset of 3 rows', imp.body.ok && imp.body.dataset.rowCount === 3, JSON.stringify(imp.body).slice(0, 300));
    const ds = (await call(srv.base, 'dataset:list', { projectId: project })).body as { id: string; originConnId?: string }[];
    ok('import: the dataset lists as from this connection', ds.some((d) => d.id === imp.body.dataset.id && d.originConnId === connId));
    const counted = (await call(srv.base, 'connections:list', { projectId: project })).body[0];
    ok('list: datasetCount counts it (server side)', counted.datasetCount === 1, JSON.stringify(counted.datasetCount));
    const sched = await call(srv.base, 'dataset:update', { projectId: project, datasetId: imp.body.dataset.id, autoRefresh: 'daily' });
    ok('dataset:update: the schedule is set', sched.body.ok === true, JSON.stringify(sched.body).slice(0, 200));
    const refresh = await call(srv.base, 'connection:refresh', { projectId: project, connId, datasetId: imp.body.dataset.id });
    ok('refresh: re-runs the dataset\'s own statement', refresh.body.ok && refresh.body.dataset.rowCount === 3, JSON.stringify(refresh.body).slice(0, 200));

    // Replace: a failing test keeps the old secret; a passing one stores the new.
    const badHost = await call(srv.base, 'connection:replaceSecret', { projectId: project, connId, key: 'host', value: 'x' });
    ok('replaceSecret: only a declared secret field', badHost.body.ok === false);
    seen.length = 0;
    const rep = await call(srv.base, 'connection:replaceSecret', { projectId: project, connId, key: 'password', value: CANARY2 });
    ok('replaceSecret: tested with the new value, stored, never echoed', rep.body.ok && rep.body.connection.secretSet.password === true
      && seen.includes(CANARY2) && (await enc.get('default', 'connection.password', connId)) === CANARY2, JSON.stringify(rep.body).slice(0, 200));

    // One project cannot reach another's connection — run or delete.
    const crossRun = await call(srv.base, 'connection:listTables', { projectId: other, connId });
    const crossDel = await call(srv.base, 'connection:delete', { projectId: other, connId });
    ok('cross-project: another project\'s id finds no connection, and its secret survives', crossRun.body.ok === false && crossDel.body.ok === false
      && (await enc.get('default', 'connection.password', connId)) === CANARY2);

    // Every surface, while the secret is stored.
    const dumpTables = async (): Promise<string> => {
      const names = (await pool.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map((r) => r.t);
      let out = '';
      for (const t of names) for (const r of (await pool.query<{ j: string }>(`SELECT row_to_json(x)::text AS j FROM "${t}" x`)).rows) out += r.j + '\n';
      return out;
    };
    const dump = await dumpTables();
    ok('dump: the secrets table holds the connection rows (the dump is not vacuous)', dump.includes('connection.password') && dump.includes(connId));
    ok('dump: no canary in a row_to_json dump of every table', !leaks(dump));
    let pgDump = '';
    try {
      const bin = ['/opt/homebrew/opt/postgresql@17/bin/pg_dump', 'pg_dump'].find((p) => p === 'pg_dump' || fs.existsSync(p))!;
      pgDump = execFileSync(bin, ['--no-owner', at(appDb)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
    } catch (err) {
      console.log(`     note: pg_dump did not run (${String((err as Error).message).split('\n')[0]}); the row dump stands alone`);
    }
    if (pgDump) ok('dump: no canary in pg_dump', pgDump.includes('COPY public.secrets') && !leaks(pgDump));
    const tree = readTree(DATA);
    ok('disk: no canary in any file under DATA_DIR — config.json included', !leaks(tree));
    ok('disk: no config.json carries a connection secret block with content', !/"connectionSecrets":\s*\{\s*"[0-9a-f-]{36}"/.test(tree));
    ok('replies: no canary in any RPC reply', replies.length > 1000 && !leaks(replies));

    // Delete drops the record AND the secrets.
    const del = await call(srv.base, 'connection:delete', { projectId: project, connId });
    ok('delete: ok, and the store no longer has the password', del.body.ok === true && (await enc.get('default', 'connection.password', connId)) === null
      && (await pool.query('SELECT 1 FROM secrets WHERE ref = $1', [connId])).rowCount === 0);
    await srv.close();
    ok('log: the trace-level server log never carries the canary', appLog.length > 1000 && !leaks(appLog));
    ok('output: nothing this process printed carries the canary', !leaks(captured));
  } finally {
    await pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${appDb} WITH (FORCE)`);
    await root.query(`DROP DATABASE IF EXISTS ${srcDb} WITH (FORCE)`);
    await root.end();
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.rmSync(desktopUserData, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to the end', false, err instanceof Error ? err.stack : err))
  .finally(finish);
