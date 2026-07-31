// Self-check for src/connections.ts (connection metadata store) + the connection
// secret store in src/config.ts. Like test-datasets.ts, we stub the 'electron'
// module (via Module._load) to point userData at a fresh temp dir, then exercise
// the REAL connections + projects + config modules against real disk. No
// framework. This is a PURE store round-trip — it does NOT open a pg socket or
// hit the network (connectionRun is exercised at runtime, not here).

export {}; // module scope — sibling test scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-connections-'));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return { app: { getPath: (_name: string) => tmpUserData } };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the .ts sources.
const connections: typeof import('../src/connections') = require('../src/connections');
const projects: typeof import('../src/projects') = require('../src/projects');
const config: typeof import('../src/config') = require('../src/config');

let failures = 0;
function ok(label: string, cond: boolean) {
  if (cond) console.log('ok   ' + label);
  else { console.error('FAIL ' + label); failures++; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_PW = 'sup3r-s3cret-pw';

async function main(): Promise<void> {
  await projects.init();
  await connections.init(); // no-op stub

  const proj = await projects.createProject('Conn project');
  ok('created a parent project', typeof proj.id === 'string' && proj.id.length > 0);

  // Empty to start.
  let list = await connections.listConnections(proj.id);
  ok('listConnections is empty initially', Array.isArray(list) && list.length === 0);

  // save a Postgres connection.
  const a = await connections.saveConnection(proj.id, {
    name: '  Warehouse  ',
    kind: 'postgres',
    host: 'db.example.com',
    port: 5432,
    database: 'analytics',
    user: 'reader',
    ssl: true,
    table: 'public.sales',
  });
  ok('saveConnection returns a connection', a !== null && typeof a.id === 'string' && UUID_RE.test(a.id));
  ok('saveConnection trims the name', a !== null && a.name === 'Warehouse');
  ok('saveConnection sets projectId', a !== null && a.projectId === proj.id);
  ok('saveConnection keeps non-secret pg metadata', a !== null && a.host === 'db.example.com' && a.port === 5432 && a.database === 'analytics' && a.user === 'reader' && a.ssl === true && a.table === 'public.sales');
  ok('saveConnection sets kind', a !== null && a.kind === 'postgres');
  ok('saveConnection defaults lastStatus untested', a !== null && a.lastStatus === 'untested');
  ok('saveConnection defaults lastRefreshedAt null', a !== null && a.lastRefreshedAt === null);
  ok('saveConnection sets schemaVersion 1', a !== null && a.schemaVersion === 1);
  ok('saveConnection sets createdAt === updatedAt', a !== null && a.createdAt === a.updatedAt);
  ok('connection file written to disk',
    a !== null && fs.existsSync(path.join(tmpUserData, 'projects', proj.id, 'connections', a.id + '.json')));

  // second connection (created later → newer updatedAt).
  await new Promise((r) => setTimeout(r, 5));
  const b = await connections.saveConnection(proj.id, {
    name: 'Prices API',
    kind: 'url',
    url: 'https://api.example.com/prices.json',
  });
  ok('second saveConnection returns a connection', b !== null);
  ok('connection ids are unique', a !== null && b !== null && a.id !== b.id);
  ok('url connection keeps its url', b !== null && b.url === 'https://api.example.com/prices.json' && b.kind === 'url');

  // list — both, newest-updated first (b first).
  list = await connections.listConnections(proj.id);
  ok('listConnections returns both connections', list.length === 2);
  ok('listConnections is newest-updated first', b !== null && list[0].id === b.id && a !== null && list[1].id === a.id);

  // get.
  const gotA = a !== null ? await connections.getConnection(proj.id, a.id) : null;
  ok('getConnection returns the full connection', gotA !== null && a !== null && gotA.id === a.id && gotA.host === 'db.example.com');
  const gotMissing = await connections.getConnection(proj.id, '00000000-0000-0000-0000-000000000000');
  ok('getConnection returns null for a missing uuid', gotMissing === null);

  // save under a UUID-shaped but nonexistent project → null (no orphans).
  const orphan = await connections.saveConnection('00000000-0000-0000-0000-000000000000', {
    name: 'Orphan', kind: 'url', url: 'https://x.example.com',
  });
  ok('saveConnection rejects a nonexistent parent project', orphan === null);

  // updateConnection: status/telemetry patch bumps updatedAt.
  await new Promise((r) => setTimeout(r, 5));
  const updated = a !== null ? await connections.updateConnection(proj.id, a.id, {
    lastStatus: 'ok', lastRefreshedAt: '2026-01-01T00:00:00.000Z', linkedDatasetId: '11111111-1111-1111-1111-111111111111',
  }) : null;
  ok('updateConnection applies the patch', updated !== null && updated.lastStatus === 'ok' && updated.lastRefreshedAt === '2026-01-01T00:00:00.000Z' && updated.linkedDatasetId === '11111111-1111-1111-1111-111111111111');
  ok('updateConnection bumps updatedAt', updated !== null && a !== null && updated.updatedAt !== a.updatedAt);
  ok('updateConnection returns null for a missing connection',
    (await connections.updateConnection(proj.id, '00000000-0000-0000-0000-000000000000', { lastStatus: 'ok' })) === null);

  // ── Secret store (config.ts) ────────────────────────────────────────────────
  ok('getConnectionSecret is empty before set', a !== null && Object.keys(config.getConnectionSecret(a.id)).length === 0);
  const setRes = a !== null ? config.setConnectionSecret(a.id, { password: SECRET_PW }) : { ok: false };
  ok('setConnectionSecret succeeds for a UUID connId', setRes.ok === true);
  ok('getConnectionSecret returns the stored password', a !== null && config.getConnectionSecret(a.id).password === SECRET_PW);

  // The password must live ONLY in config.json — NEVER in the connection file,
  // NEVER in the renderer-facing publicConnection view.
  const connFileRaw = a !== null ? fs.readFileSync(path.join(tmpUserData, 'projects', proj.id, 'connections', a.id + '.json'), 'utf8') : '';
  ok('connection file on disk does NOT contain the secret', !connFileRaw.includes(SECRET_PW));
  const pub = a !== null && gotA !== null ? connections.publicConnection(gotA) : null;
  ok('publicConnection view does NOT contain the secret', pub !== null && !JSON.stringify(pub).includes(SECRET_PW) && !('password' in (pub as any)) && !('token' in (pub as any)));

  // config secret store rejects a non-UUID connId (path/key-injection guard).
  ok('setConnectionSecret rejects a non-UUID connId', config.setConnectionSecret('../evil', { password: 'x' }).ok === false);
  ok('getConnectionSecret returns {} for a non-UUID connId', Object.keys(config.getConnectionSecret('../evil')).length === 0);

  // deleteConnection also drops the secret (done by the IPC layer, but assert the
  // secret helper works and the metadata delete removes the file).
  const del = a !== null ? await connections.deleteConnection(proj.id, a.id) : false;
  ok('deleteConnection returns true', del === true);
  ok('deleteConnection removes the file',
    a !== null && !fs.existsSync(path.join(tmpUserData, 'projects', proj.id, 'connections', a.id + '.json')));
  if (a !== null) config.deleteConnectionSecret(a.id);
  ok('deleteConnectionSecret drops the secret', a !== null && Object.keys(config.getConnectionSecret(a.id)).length === 0);

  list = await connections.listConnections(proj.id);
  ok('listConnections reflects the deletion', list.length === 1 && b !== null && list[0].id === b.id);

  // deleting a missing but WELL-FORMED uuid is a no-op success (fs.rm force).
  ok('deleteConnection of a missing uuid succeeds (force)',
    (await connections.deleteConnection(proj.id, '00000000-0000-0000-0000-000000000000')) === true);

  // ── SECURITY: BOTH projectId and connId must be UUID-validated before any fs
  // op — a traversal in either would escape the project's connections dir. ──────
  const sentinel = path.join(tmpUserData, 'projects', proj.id, 'SECRET.json');
  fs.writeFileSync(sentinel, 'keep');
  const outsideSentinel = path.join(tmpUserData, 'DO_NOT_DELETE.txt');
  fs.writeFileSync(outsideSentinel, 'keep');

  ok('saveConnection rejects a traversal projectId',
    (await connections.saveConnection('..', { name: 'x', kind: 'url', url: 'https://x' })) === null);
  ok('saveConnection rejects a nested traversal projectId',
    (await connections.saveConnection('../../foo', { name: 'x', kind: 'url', url: 'https://x' })) === null);
  ok('getConnection rejects a traversal projectId', (await connections.getConnection('..', b !== null ? b.id : 'x')) === null);
  ok('getConnection rejects a traversal connId', (await connections.getConnection(proj.id, '../SECRET')) === null);
  ok('getConnection rejects a nested traversal connId', (await connections.getConnection(proj.id, '../../etc/passwd')) === null);
  ok('updateConnection rejects a traversal projectId', (await connections.updateConnection('..', 'x', { lastStatus: 'ok' })) === null);
  ok('updateConnection rejects a traversal connId', (await connections.updateConnection(proj.id, '../SECRET', { lastStatus: 'ok' })) === null);
  ok('deleteConnection rejects a traversal projectId', (await connections.deleteConnection('..', 'x')) === false);
  ok('deleteConnection rejects a traversal connId', (await connections.deleteConnection(proj.id, '../SECRET')) === false);
  ok('deleteConnection rejects a nested traversal connId', (await connections.deleteConnection(proj.id, '../../DO_NOT_DELETE')) === false);
  ok('listConnections rejects a traversal projectId', (await connections.listConnections('..')).length === 0);

  ok('traversal ops did NOT touch the in-project sentinel', fs.existsSync(sentinel));
  ok('traversal ops did NOT touch files outside projects/', fs.existsSync(outsideSentinel));
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    Module._load = origLoad;
    if (failures) { console.error('\n' + failures + ' connections check(s) FAILED'); process.exit(1); }
    console.log('\nAll connections checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
