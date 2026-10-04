// Projects, Trash and version history over the server's RPC (T2.2), over real
// HTTP, server mode, no Electron.
//
//   Part 1 (always): dev sign-in, records as files. The switcher's overview
//   and "opened" stamp, rename, the Trash (restore, delete for good, empty),
//   version history (list, read, restore = a new version), the bundle's T0.4
//   round trip (export → download token → upload → import as a new project,
//   each token single-use, the export's temp file gone after the download),
//   delete, and the caller's role without Postgres.
//
//   Part 2 (DATABASE_URL): header sign-in on a scratch database, records in
//   Postgres. Every new channel by project role (viewer / editor / project
//   admin / org admin) — the denied ones never reach their handler — plus the
//   importer's grant, grants dropped with a deleted project, share targets and
//   the audited export.
//
//   npm run build:ts && node scripts/test-projects-server.js

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
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const api: typeof import('../src/api/index') = require('../src/api/index');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const versions: typeof import('../src/app/versions') = require('../src/app/versions');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const bundle: typeof import('../src/app/bundle') = require('../src/app/bundle');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-projects-'));
type Identity = import('../src/server/context').Identity;
// any: each channel's own reply shape
type Reply = { status: number; body: any };

/** A project with one dataset and two visuals of it, written through the stores as `who`. */
async function seed(who: Identity, projectId: string): Promise<{ ds: string; v1: string; v2: string }> {
  return context.runInContext(who, 'seed', async () => {
    const d = await datasets.saveDataset(projectId, { name: 'Orders', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'sales', type: 'number' }], rows: [['N', 1], ['S', 2]] });
    if (!d) throw new Error('seed dataset');
    const mk = async (name: string) => {
      const v = await visuals.saveVisual(projectId, { name, datasetId: d.id, chartType: 'bar', encoding: { category: 'region', values: [{ column: 'sales', aggregation: 'sum' }] } });
      if (!v) throw new Error('seed visual');
      return v.id;
    };
    return { ds: d.id, v1: await mk('Sales by region'), v2: await mk('Doomed chart') };
  });
}

function client(base: string, headers: Record<string, string> = {}) {
  const call = async (channel: string, payload?: unknown): Promise<Reply> => {
    const res = await fetch(`${base}/api/rpc/${channel}`, {
      method: 'POST',
      headers: withCsrf({ 'content-type': 'application/json', ...headers }),
      body: wire.encode({ args: payload === undefined ? [] : [payload] }),
    });
    const text = await res.text();
    return { status: res.status, body: res.status === 200 ? wire.decode(text) : text };
  };
  const upload = async (bytes: Buffer, name: string) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)]), name);
    const res = await fetch(`${base}/api/files`, { method: 'POST', body: form, headers: withCsrf(headers) });
    return { status: res.status, body: (await res.json()) as { fileToken: string } };
  };
  const download = async (token: string) => {
    const res = await fetch(`${base}/api/files/${token}`, { headers });
    return { status: res.status, disposition: res.headers.get('content-disposition'), bytes: Buffer.from(await res.arrayBuffer()) };
  };
  return { call, upload, download };
}

async function listen(app: FastifyInstance): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
}

async function partOne(): Promise<void> {
  const app = appMod.buildApp(envMod.parseEnv({ LOG_LEVEL: 'silent', DATA_DIR: DATA, ORDINATE_ENV: 'dev' }));
  const base = await listen(app);
  const { call, upload, download } = client(base);
  const dev: Identity = { user: { email: 'dev@local', role: 'admin' }, org: { id: 'default' } };
  try {
    const made = await call('projects:create', { name: 'Quarterly' });
    const pid: string = made.body.id;
    const { ds, v1, v2 } = await seed(dev, pid);

    // ── Switcher ──────────────────────────────────────────────────────────
    const ov = await call('projects:overview');
    const row = ov.body.find((p: { id: string }) => p.id === pid);
    ok('overview: the project with its counts (1 dataset, 0 dashboards) and archived=false', ov.status === 200 && row?.datasets === 1 && row.dashboards === 0 && row.archived === false, JSON.stringify(row));
    const before = row.lastOpenedAt;
    const opened = await call('projects:open', { id: pid });
    const after = (await call('projects:overview')).body.find((p: { id: string }) => p.id === pid).lastOpenedAt;
    ok('open: stamps "last opened"', opened.status === 200 && typeof after === 'string' && after !== before, `${before} → ${after}`);
    const renamed = await call('projects:rename', { id: pid, name: '  Q3 numbers ' });
    ok('rename: trimmed and stored', renamed.status === 200 && renamed.body.name === 'Q3 numbers');
    ok('rename: an unknown key is a 400 (strict input)', (await call('projects:rename', { id: pid, name: 'x', path: '/etc' })).status === 400);
    const arch = await call('projects:archive', { id: pid, archived: true });
    const archRow = (await call('projects:overview')).body.find((p: { id: string }) => p.id === pid);
    await call('projects:archive', { id: pid, archived: false });
    ok('archive: flagged, then restored', arch.status === 200 && archRow.archived === true && (await call('projects:overview')).body.find((p: { id: string }) => p.id === pid).archived === false);
    ok('roles: the dev admin is admin on it, without Postgres', (await call('projects:roles')).body[pid] === 'admin');

    // ── Version history ───────────────────────────────────────────────────
    await context.runInContext(dev, 'edit', async () => {
      const first = await visuals.getVisual(pid, v1);
      await versions.record(pid, 'visual', first);
      const next = await visuals.updateVisual(pid, v1, { name: 'Sales by region (edited)' });
      await versions.record(pid, 'visual', next, { before: first });
    });
    const of = { projectId: pid, type: 'visual', id: v1 };
    const list = await call('versions:list', of);
    ok('versions:list: two saves, newest first, each with a summary', list.status === 200 && list.body.length === 2 && list.body[0].savedAt >= list.body[1].savedAt && list.body.every((v: { summary: string }) => typeof v.summary === 'string'), JSON.stringify(list.body));
    const old = list.body[1];
    const got = await call('versions:get', { ...of, key: old.key });
    ok('versions:get: the older version holds the old name', got.status === 200 && got.body.record.name === 'Sales by region');
    ok('versions:get: a malformed key reads nothing', (await call('versions:get', { ...of, key: '../../x' })).body === null);
    const restored = await call('versions:restore', { ...of, key: old.key });
    const nowName = await context.runInContext(dev, 'r', async () => (await visuals.getVisual(pid, v1))?.name);
    const list2 = (await call('versions:list', of)).body;
    ok('versions:restore: the visual has its old name back', restored.status === 200 && restored.body.ok === true && nowName === 'Sales by region', JSON.stringify(restored.body));
    ok('versions:restore: recorded as a NEW version marked restoredFrom (append-only)', list2.length === 3 && list2[0].restoredFrom === old.savedAt);
    ok('versions: a type outside the five is a 400', (await call('versions:list', { ...of, type: 'alert' })).status === 400);

    // ── Trash ─────────────────────────────────────────────────────────────
    const moved = await context.runInContext(dev, 'del', () => trash.trashRecord(pid, 'visual', v2));
    const tl = await call('trash:list', { projectId: pid });
    ok('trash:list: the deleted visual, 30 days left', moved.ok && tl.status === 200 && tl.body.length === 1 && tl.body[0].id === v2 && tl.body[0].daysLeft === 30, JSON.stringify(tl.body));
    const back = await call('trash:restore', { projectId: pid, type: 'visual', id: v2 });
    ok('trash:restore: back in the project, out of the Trash', back.body.ok === true && back.body.restored[0].id === v2 && (await call('trash:list', { projectId: pid })).body.length === 0);
    await context.runInContext(dev, 'del', async () => {
      await versions.record(pid, 'visual', await visuals.getVisual(pid, v2));
      await trash.trashRecord(pid, 'visual', v2);
    });
    const purged = await call('trash:purge', { projectId: pid, type: 'visual', id: v2 });
    ok('trash:purge: gone for good, with its version history', purged.body.ok === true && (await call('trash:list', { projectId: pid })).body.length === 0 && (await call('versions:list', { projectId: pid, type: 'visual', id: v2 })).body.length === 0);
    await context.runInContext(dev, 'del', () => trash.trashRecord(pid, 'dataset', ds));
    const withCascade = (await call('trash:list', { projectId: pid })).body;
    const emptied = await call('trash:empty', { projectId: pid });
    ok('trash:empty: the dataset and the visual deleted with it, both purged', withCascade.length === 2 && withCascade.some((e: { deletedWith?: string }) => e.deletedWith === ds) && emptied.body.removed === 2 && (await call('trash:list', { projectId: pid })).body.length === 0, JSON.stringify(withCascade));
    ok('trash: a type outside the six is a 400', (await call('trash:purge', { projectId: pid, type: 'project', id: v2 })).status === 400);

    // ── Bundle: export → download → upload → import ──────────────────────
    const src = (await call('projects:create', { name: 'Bundle me' })).body.id as string;
    await seed(dev, src);
    const tmp = path.join(DATA, 'orgs', 'default', 'temp');
    const exp = await call('projects:export', { id: src });
    ok('export: a download token, no path in the reply', exp.status === 200 && exp.body.ok === true && /^[A-Za-z0-9_-]{43}$/.test(exp.body.downloadToken) && !('path' in exp.body), JSON.stringify(exp.body));
    const file = await download(exp.body.downloadToken);
    ok('export: the download is the bundle, named after the project', file.status === 200 && /Bundle me\.ordinate/.test(file.disposition ?? ''), file.disposition);
    const manifest = JSON.parse(bundle.readZip(file.bytes).find((e) => e.name === 'manifest.json')!.data.toString('utf8'));
    ok('export: the manifest carries package.json\'s version (no Electron on the server)', manifest.appVersion === require('../package.json').version && manifest.counts.datasets === 1 && manifest.counts.visuals === 2, JSON.stringify(manifest));
    await new Promise((r) => setTimeout(r, 50));
    ok('export: the temp file is deleted once sent', fs.readdirSync(tmp).every((n: string) => !n.startsWith('export-')), fs.readdirSync(tmp).join());
    ok('export: the download token is single-use', (await download(exp.body.downloadToken)).status === 404);
    const up = await upload(file.bytes, 'Bundle me.ordinate');
    const imp = await call('projects:import', { fileToken: up.body.fileToken });
    const newId = imp.body.project?.id;
    ok('import: a NEW project with the same counts', imp.status === 200 && imp.body.ok === true && newId && newId !== src && imp.body.counts.datasets === 1 && imp.body.counts.visuals === 2, JSON.stringify(imp.body));
    ok('import: its dataset opens', (await call('dataset:list', { projectId: newId })).body.length === 1);
    ok('import: the upload token is single-use', (await call('projects:import', { fileToken: up.body.fileToken })).body.ok === false);
    ok('import: the upload is deleted once read', fs.readdirSync(tmp).every((n: string) => !n.startsWith('upload-')), fs.readdirSync(tmp).join());
    const junk = await upload(Buffer.from('not a zip'), 'junk.ordinate');
    const bad = await call('projects:import', { fileToken: junk.body.fileToken });
    ok('import: a file that is not a bundle is refused with a reason, not a 500', bad.status === 200 && bad.body.ok === false && typeof bad.body.error === 'string', JSON.stringify(bad.body));

    // ── Delete ────────────────────────────────────────────────────────────
    const del = await call('projects:delete', { id: newId });
    const ids = (await call('projects:list')).body.map((p: { id: string }) => p.id);
    ok('delete: the project is gone from every list', del.body.ok === true && !ids.includes(newId) && ids.includes(src));
    ok('delete: an unknown project is a 403 before the handler', (await call('projects:delete', { id: newId })).status === 403);
  } finally {
    await app.close();
  }
}

async function partTwo(adminUrl: string): Promise<void> {
  const dbName = `ordinate_t22_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  const app = appMod.buildApp(envMod.parseEnv({
    LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
  }));
  try {
    const base = await listen(app);
    const as = (who: string) => client(base, { 'x-forwarded-email': `${who}@acme.test` });
    for (const p of ['boss', 'alice', 'bob', 'carol', 'eve']) await as(p).call('projects:list');
    const uid = async (who: string) => (await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [`${who}@acme.test`])).rows[0].id;
    await pool.query(`UPDATE users SET role = 'editor' WHERE email = 'eve@acme.test'`);
    const team = (await pool.query<{ id: string }>(`INSERT INTO teams (org_id, name) VALUES ('acme', 'Analysts') RETURNING id`)).rows[0].id;
    const boss = as('boss');
    const pid: string = (await boss.call('projects:create', { name: 'Shared' })).body.id;
    for (const [who, role] of [['alice', 'viewer'], ['bob', 'editor'], ['carol', 'admin']]) {
      await boss.call('project:share', { projectId: pid, member: { userId: await uid(who) }, role });
    }
    const bossId: Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
    const { v1 } = await seed(bossId, pid);

    // Spies: a denied call must never reach its handler.
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
    const roles = (await Promise.all(['alice', 'bob', 'carol', 'boss'].map(async (w) => (await as(w).call('projects:roles')).body[pid]))).join();
    ok('projects:roles: viewer, editor, admin (grant), admin (org admin)', roles === 'viewer,editor,admin,admin', roles);
    ok('projects:roles: no grant → not in the map', !(pid in (await as('eve').call('projects:roles')).body));

    // Re-made per cell: a restore / purge / delete must have something to act on.
    const ready = async () => {
      await context.runInContext(bossId, 'r', async () => {
        await trash.trashRecord(pid, 'visual', v1).catch(() => undefined);
      });
      const key = (await boss.call('versions:list', { projectId: pid, type: 'visual', id: v1 })).body[0]?.key ?? '2026-01-01T00-00-00-000Z';
      return key as string;
    };
    await context.runInContext(bossId, 'v', async () => { await versions.record(pid, 'visual', await visuals.getVisual(pid, v1)); });
    type Cell = [string, (key: string) => unknown, 'read' | 'write' | 'admin'];
    const cells: Cell[] = [
      ['projects:open', () => ({ id: pid }), 'read'],
      ['projects:export', () => ({ id: pid }), 'read'],
      ['trash:list', () => ({ projectId: pid }), 'read'],
      ['versions:list', () => ({ projectId: pid, type: 'visual', id: v1 }), 'read'],
      ['versions:get', (key) => ({ projectId: pid, type: 'visual', id: v1, key }), 'read'],
      ['project:access', () => ({ projectId: pid }), 'read'],
      ['projects:rename', () => ({ id: pid, name: 'Shared' }), 'write'],
      ['trash:restore', () => ({ projectId: pid, type: 'visual', id: v1 }), 'write'],
      ['versions:restore', (key) => ({ projectId: pid, type: 'visual', id: v1, key }), 'write'],
      ['projects:archive', () => ({ id: pid, archived: false }), 'admin'],
      ['trash:purge', () => ({ projectId: pid, type: 'alert', id: v1 }), 'admin'],
      ['trash:empty', () => ({ projectId: pid }), 'admin'],
      ['project:shareTargets', () => ({ projectId: pid }), 'admin'],
    ];
    const rank = { read: 1, write: 2, admin: 3 } as const;
    const has: Record<string, number> = { alice: 1, bob: 2, carol: 3, boss: 3 };
    let wrong = 0;
    let leaks = 0;
    const lines: string[] = [];
    for (const [ch, mk, access] of cells) {
      const line: string[] = [];
      for (const who of ['alice', 'bob', 'carol', 'boss']) {
        const key = await ready();
        const n = calls.get(ch) ?? 0;
        const r = await as(who).call(ch, mk(key));
        const allowed = r.status === 200;
        if (allowed !== has[who] >= rank[access] || (r.status !== 200 && r.status !== 403)) wrong++;
        if (!allowed && (calls.get(ch) ?? 0) !== n) leaks++;
        line.push(allowed ? 'ALLOW' : 'deny ');
      }
      lines.push(`     ${ch.padEnd(22)} ${access.padEnd(6)} ${line.join(' ')}`);
    }
    console.log('     channel                access viewer editor admin org-admin\n' + lines.join('\n'));
    ok('roles: every new channel allows exactly the roles its access names', wrong === 0, wrong);
    ok('roles: a denied call never reached its handler (spy)', leaks === 0, leaks);
    const delN = calls.get('projects:delete') ?? 0;
    const delBy = await Promise.all(['alice', 'bob'].map(async (w) => (await as(w).call('projects:delete', { id: pid })).status));
    ok('delete: a viewer and an editor get 403, the handler never ran', delBy.join() === '403,403' && (calls.get('projects:delete') ?? 0) === delN, delBy.join());

    const targets = (await as('carol').call('project:shareTargets', { projectId: pid })).body;
    ok('shareTargets: the org\'s users and teams, ids and labels only', targets.users.length === 5 && targets.teams.length === 1 && targets.teams[0].id === team && Object.keys(targets.users[0]).sort().join() === 'email,id', JSON.stringify(targets));

    // Import by an org editor: granted admin on what they brought in.
    const exp = (await boss.call('projects:export', { id: pid })).body;
    const eve = as('eve');
    ok('download: another member cannot fetch the exporter\'s token', (await eve.download(exp.downloadToken)).status === 404);
    const again = (await boss.call('projects:export', { id: pid })).body;
    const file = await boss.download(again.downloadToken);
    const up = await eve.upload(file.bytes, 'Shared.ordinate');
    const imp = await eve.call('projects:import', { fileToken: up.body.fileToken });
    const importedId: string = imp.body.project?.id;
    ok('import: an org editor imports a project and is granted admin on it', imp.status === 200 && (await eve.call('projects:roles')).body[importedId] === 'admin', JSON.stringify(imp.body));
    ok('import: an org viewer may not import (403)', (await as('alice').call('projects:import', { fileToken: up.body.fileToken })).status === 403);

    const del = await eve.call('projects:delete', { id: importedId });
    const left = (await pool.query('SELECT 1 FROM project_grants WHERE project_id = $1', [importedId])).rowCount;
    ok('delete: the project admin deletes it, and its grants go with it', del.body.ok === true && left === 0, left);
    const audit = await pool.query<{ channel: string; actor: string }>(`SELECT channel, actor FROM audit_log WHERE outcome = 'ok' AND channel IN ('projects:export', 'projects:delete', 'projects:import')`);
    ok('audit: export (an audited read), import and delete are on the trail', ['projects:export', 'projects:import', 'projects:delete'].every((c) => audit.rows.some((r) => r.channel === c)), JSON.stringify(audit.rows));
  } finally {
    await app.close().catch(() => undefined);
    await pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }
}

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  try {
    await partOne();
    if (process.env.DATABASE_URL) await partTwo(process.env.DATABASE_URL);
    else console.log('skip projects DB part: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
