// Settings over the server's RPC (T2.14), over real HTTP, server mode, no
// Electron.
//
//   Part 1 (always): dev sign-in (an org admin), config and records as files.
//   Workspace formats and branding (prefs:get reads back what was set; strict
//   inputs), the uploaded logo, the Assistant's rules / auto-refresh / alert
//   switches, dashboard themes, the project's Share policy and sensitivity
//   review, the palette's search, and the org backup's round trip — download
//   (one zip of every project's bundle) → upload → restore as NEW projects,
//   the typed confirmation enforced by the server, a tampered backup refused
//   as a whole, nothing written.
//
//   Part 2 (DATABASE_URL): header sign-in on a scratch database. Every new
//   channel by role — org channels viewer / editor / org admin, project
//   channels viewer / editor / project admin / org admin — a denied call never
//   reaching its handler (spy), and the backup download and restore on the
//   audit trail.
//
//   npm run build:ts && node scripts/test-settings-server.js

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
const bundle: typeof import('../src/app/bundle') = require('../src/app/bundle');
const privacyStore: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-settings-'));
type Identity = import('../src/server/context').Identity;
// any: each channel's own reply shape
type Reply = { status: number; body: any };

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

/** A project with one dataset holding an email column, written through the store as `who`. */
async function seed(who: Identity, projectId: string, name = 'Customers'): Promise<string> {
  return context.runInContext(who, 'seed', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => [`person${i}@example.com`, i * 10]);
    const d = await datasets.saveDataset(projectId, { name, sourceKind: 'csv', columns: [{ name: 'email', type: 'text' }, { name: 'spend', type: 'number' }], rows });
    if (!d) throw new Error('seed dataset');
    return d.id;
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
    form.append('file', new Blob([new Uint8Array(bytes)]), name);
    const res = await fetch(`${base}/api/files`, { method: 'POST', body: form, headers: withCsrf(headers) });
    return (await res.json()) as { fileToken: string };
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
    // ── Formats and branding ──────────────────────────────────────────────
    const fmt = await call('formats:set', { locale: 'de-DE', currency: 'EUR', weekStart: 0, compact: false, calendarType: '445' });
    const prefs = (await call('prefs:get')).body;
    ok('formats:set: prefs:get reads back exactly what was set (merged over the rest)', fmt.status === 200 && prefs.formats.locale === 'de-DE' && prefs.formats.currency === 'EUR' && prefs.formats.weekStart === 0 && prefs.formats.compact === false && prefs.formats.calendarType === '445' && prefs.formats.dateFormat === 'medium', JSON.stringify(prefs.formats));
    ok('formats:set: an unknown key is a 400 (strict input)', (await call('formats:set', { locale: 'en-US', path: '/etc' })).status === 400);
    ok('formats:set: an out-of-range week start is a 400', (await call('formats:set', { weekStart: 9 })).status === 400);
    await call('branding:set', { accent: '#0d9488', dashboardStyle: 'executive' });
    const br = (await call('prefs:get')).body.branding;
    ok('branding:set: accent and new-dashboard style stored', br.accent === '#0d9488' && br.dashboardStyle === 'executive', JSON.stringify(br));
    ok('branding:set: logo is not the browser\'s to set (400)', (await call('branding:set', { logo: 'png' })).status === 400);
    ok('branding:set: a colour that is not #rrggbb is a 400', (await call('branding:set', { accent: 'red; background:url(x)' })).status === 400);

    // ── The logo ──────────────────────────────────────────────────────────
    ok('branding:logo: none yet', (await call('branding:logo', 'workspace')).body.dataUrl === null);
    const logo = await call('branding:setLogo', { fileToken: (await upload(PNG, 'mark.png')).fileToken });
    ok('branding:setLogo: an uploaded PNG becomes the workspace logo (a data: URL back, no path)', logo.body.ok === true && /^data:image\/png;base64,/.test(logo.body.dataUrl) && !JSON.stringify(logo.body).includes(DATA), JSON.stringify(logo.body).slice(0, 120));
    ok('branding:logo: reads it back', /^data:image\/png;base64,/.test((await call('branding:logo', 'workspace')).body.dataUrl ?? ''));
    ok('branding:logo: another scope is a 400 (a dashboard\'s logo is not this channel\'s)', (await call('branding:logo', '../x')).status === 400);
    const notImg = await call('branding:setLogo', { fileToken: (await upload(Buffer.from('<script>alert(1)</script>'), 'x.svg')).fileToken });
    ok('branding:setLogo: a file that is not a PNG or a clean SVG is refused with a reason', notImg.body.ok === false && typeof notImg.body.error === 'string', JSON.stringify(notImg.body));
    ok('branding:setLogo: a used token is refused', (await call('branding:setLogo', { fileToken: 'x'.repeat(43) })).body.ok === false);
    await call('branding:clearLogo', 'workspace');
    ok('branding:clearLogo: gone', (await call('branding:logo', 'workspace')).body.dataUrl === null && (await call('prefs:get')).body.branding.logo === '');

    // ── Assistant rules, auto-refresh, alert switches ─────────────────────
    await call('rules:set', { text: 'Round to whole numbers.' });
    await call('autorefresh:set', false);
    await call('notifications:set', { fields: { alertExplain: true } });
    const ks = (await call('key:status')).body;
    ok('rules / auto-refresh / notifications: key:status reads them back', ks.globalRules === 'Round to whole numbers.' && ks.autoRefresh === false && ks.notifications.alertExplain === true && ks.notifications.alerts === true, JSON.stringify({ r: ks.globalRules, a: ks.autoRefresh, n: ks.notifications }));
    ok('notifications:set: the desktop-only switches are a 400 on the server', (await call('notifications:set', { fields: { desktop: true } })).status === 400);
    await call('autorefresh:set', true);

    // ── Themes ────────────────────────────────────────────────────────────
    const saved = await call('themes:save', { name: '  Board   pack ', tokens: { '--bg': '#101114', '--accent': '#ff8800', '--dash-card-radius': 99, '--evil': 'url(x)' } });
    const th = saved.body.theme;
    ok('themes:save: stored with an id, name tidied, values clamped, unknown tokens dropped', saved.body.ok === true && /^[0-9a-f-]{36}$/.test(th.id) && th.name === 'Board pack' && th.tokens['--dash-card-radius'] === 28 && !('--evil' in th.tokens), JSON.stringify(th));
    ok('themes:save: a token value with a url() is dropped', !JSON.stringify((await call('themes:save', { id: th.id, name: 'Board pack', tokens: { '--bg': 'url(javascript:x)' } })).body).includes('url('));
    await call('themes:setDefault', th.id);
    const tl = (await call('themes:list')).body;
    ok('themes:setDefault / themes:list: the default and the theme', tl.defaultId === th.id && tl.themes.length === 1, JSON.stringify(tl));
    ok('themes:delete: removed, and the default with it', (await call('themes:delete', th.id)).body.ok === true && (await call('themes:list')).body.defaultId === '');
    ok('themes:delete: not a UUID → 400', (await call('themes:delete', '../themes')).status === 400);

    // ── Privacy ───────────────────────────────────────────────────────────
    const pid: string = (await call('projects:create', { name: 'Privacy' })).body.id;
    const ds = await seed(dev, pid);
    const scan = await call('privacy:scan', { projectId: pid });
    const ov = (await call('privacy:overview', { projectId: pid })).body;
    const pending = ov.datasets?.[0]?.pending ?? [];
    ok('privacy:scan → overview: the email column is proposed as personal', scan.body.ok === true && scan.body.found >= 1 && pending.some((p: { column: string; level: string }) => p.column === 'email' && p.level === 'personal'), JSON.stringify(ov));
    ok('privacy:overview: the default policy masks on every path', ['export', 'report', 'publish', 'bundle'].every((k) => ov.policy[k] === 'mask'), JSON.stringify(ov.policy));
    ok('privacy:review: the dataset\'s pending proposal', (await call('privacy:review', { projectId: pid, datasetId: ds })).body.pending.length >= 1);
    await call('privacy:decide', { projectId: pid, datasetId: ds, column: 'email', level: 'personal' });
    const ov2 = (await call('privacy:overview', { projectId: pid })).body;
    ok('privacy:decide: marked, no longer pending', ov2.datasets[0].sensitive.some((c: { column: string }) => c.column === 'email') && ov2.datasets[0].pending.length === 0, JSON.stringify(ov2.datasets));
    const sum = (await call('privacy:summary', { projectId: pid, path: 'export', datasetIds: [ds] })).body;
    ok('privacy:summary: the export line names one masked column', sum.ok === true && sum.count === 1 && sum.action === 'mask' && typeof sum.line === 'string', JSON.stringify(sum));
    await call('privacy:setPolicy', { projectId: pid, policy: { export: 'include' } });
    ok('privacy:setPolicy: stored, the others kept', (await call('privacy:overview', { projectId: pid })).body.policy.export === 'include' && (await call('privacy:overview', { projectId: pid })).body.policy.bundle === 'mask');
    ok('privacy:setPolicy: an unknown action is a 400', (await call('privacy:setPolicy', { projectId: pid, policy: { export: 'leak' } })).status === 400);
    ok('privacy:decide: an unknown level is a 400', (await call('privacy:decide', { projectId: pid, datasetId: ds, column: 'email', level: 'secret' })).status === 400);
    const salt = (await context.runInContext(dev, 'salt', () => privacyStore.getSalt(pid))) as string;
    ok('privacy: no reply carries the masking key', salt.length === 64 && !JSON.stringify([ov2, sum, await call('privacy:review', { projectId: pid, datasetId: ds })]).includes(salt));

    // ── Search ────────────────────────────────────────────────────────────
    const hits = (await call('search:query', { projectId: pid, query: 'cust' })).body;
    ok('search:query: the dataset by name, in the asked project', hits.ok === true && hits.results.length === 1 && hits.results[0].id === ds && hits.results[0].kind === 'dataset', JSON.stringify(hits));
    ok('search:query: no project → 400 (the desktop\'s "every project" is not offered)', (await call('search:query', { projectId: '', query: 'cust' })).status === 400);

    // ── Backups: download → restore ───────────────────────────────────────
    const before: Array<{ id: string; name: string }> = (await call('projects:list')).body;
    let t0 = performance.now();
    const dl = await call('backups:download');
    const dlMs = performance.now() - t0;
    ok('backups:download: a download token and the project count, no path', dl.body.ok === true && dl.body.count === before.length && /^[A-Za-z0-9_-]{43}$/.test(dl.body.downloadToken) && !('path' in dl.body), JSON.stringify(dl.body));
    const file = await download(dl.body.downloadToken);
    const entries = bundle.readZip(file.bytes);
    const man = JSON.parse(entries.find((e) => e.name === 'backup.json')!.data.toString('utf8'));
    ok('backups:download: one zip — backup.json plus one .ordinate per project', file.status === 200 && /Ordinate backup default \d{4}-\d{2}-\d{2}\.zip/.test(file.disposition ?? '') && man.format === 'ordinate-backup' && man.projects.length === before.length && entries.length === before.length + 1, file.disposition);
    const inner = bundle.readZip(entries.find((e) => e.name === man.projects.find((p: { name: string }) => p.name === 'Privacy').file)!.data);
    const innerDs = inner.find((e) => /^datasets\/.*\.parquet$/.test(e.name));
    ok('backups:download: unmasked — the Parquet travels (a bundle export would mask it)', !!innerDs && inner.some((e) => e.name === 'privacy/policy.json'), inner.map((e) => e.name).join());
    ok('backups:download: the masking key never travels', !inner.some((e) => /salt/.test(e.name)) && !file.bytes.includes(Buffer.from(salt)));
    await new Promise((r) => setTimeout(r, 50));
    ok('backups:download: the temp zip is deleted once sent', fs.readdirSync(path.join(DATA, 'orgs', 'default', 'temp')).every((n: string) => !n.startsWith('backup-')));

    const tok = (await upload(file.bytes, 'backup.zip')).fileToken;
    ok('backups:restore: without the typed word it is a 400', (await call('backups:restore', { fileToken: tok })).status === 400 && (await call('backups:restore', { fileToken: tok, confirm: 'yes' })).status === 400);
    t0 = performance.now();
    const rs = await call('backups:restore', { fileToken: tok, confirm: 'restore' });
    console.log(`     measured: backups:download ${dlMs.toFixed(0)} ms, backups:restore ${(performance.now() - t0).toFixed(0)} ms for ${before.length} projects (${(file.bytes.length / 1024).toFixed(0)} KB)`);
    const after: Array<{ id: string; name: string }> = (await call('projects:list')).body;
    ok('backups:restore: every project back as a NEW one, named "(restored …)", nothing overwritten', rs.body.ok === true && rs.body.restored.length === before.length && rs.body.failed.length === 0 && after.length === 2 * before.length && rs.body.restored.every((p: { id: string; name: string }) => / \(restored [A-Z][a-z]{2} \d{1,2}, \d{4}\)$/.test(p.name) && !before.some((b) => b.id === p.id)), JSON.stringify(rs.body));
    const copy = rs.body.restored.find((p: { name: string }) => p.name.startsWith('Privacy'));
    ok('backups:restore: the restored copy holds its dataset and its marked column', (await call('dataset:list', { projectId: copy.id })).body.length === 1 && (await call('privacy:overview', { projectId: copy.id })).body.datasets[0].sensitive.length === 1);
    ok('backups:restore: the upload is single-use', (await call('backups:restore', { fileToken: tok, confirm: 'restore' })).body.ok === false);

    const tampered = bundle.writeZip([...entries, { name: 'extra.ordinate', data: entries[1].data }]);
    const t1 = await call('backups:restore', { fileToken: (await upload(tampered, 'b.zip')).fileToken, confirm: 'restore' });
    const plain = await call('backups:restore', { fileToken: (await upload(entries[1].data, 'p.ordinate')).fileToken, confirm: 'restore' });
    const junk = await call('backups:restore', { fileToken: (await upload(Buffer.from('nope'), 'j.zip')).fileToken, confirm: 'restore' });
    const n = (await call('projects:list')).body.length;
    ok('backups:restore: a file the manifest does not list → refused as a whole', t1.body.ok === false && /refused as a whole/.test(t1.body.error), JSON.stringify(t1.body));
    ok('backups:restore: a single project bundle or junk → refused with a reason', plain.body.ok === false && junk.body.ok === false && typeof junk.body.error === 'string');
    ok('backups:restore: nothing written by a refused restore', n === after.length, n);
  } finally {
    await app.close();
  }
}

async function partTwo(adminUrl: string): Promise<void> {
  const dbName = `ordinate_t214_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  const app = appMod.buildApp(envMod.parseEnv({
    LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header',
    TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'acme', ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
  }));
  try {
    const base = await listen(app);
    const as = (who: string) => client(base, { 'x-forwarded-email': `${who}@acme.test` });
    for (const p of ['boss', 'alice', 'bob', 'carol', 'eve']) await as(p).call('projects:list');
    const uid = async (who: string) => (await pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [`${who}@acme.test`])).rows[0].id;
    await pool.query(`UPDATE users SET role = 'editor' WHERE email IN ('bob@acme.test', 'carol@acme.test')`);
    const boss = as('boss');
    const pid: string = (await boss.call('projects:create', { name: 'Shared' })).body.id;
    for (const [who, role] of [['alice', 'viewer'], ['bob', 'editor'], ['carol', 'admin']]) {
      await boss.call('project:share', { projectId: pid, member: { userId: await uid(who) }, role });
    }
    const bossId: Identity = { user: { email: 'boss@acme.test', role: 'admin' }, org: { id: 'acme' } };
    const ds = await seed(bossId, pid);

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
    const rank = { read: 1, write: 2, admin: 3 } as const;
    let wrong = 0;
    let leaks = 0;
    const lines: string[] = [];
    const run = async (cells: Array<[string, () => unknown, 'read' | 'write' | 'admin']>, who: string[], has: Record<string, number>) => {
      for (const [ch, mk, access] of cells) {
        const line: string[] = [];
        for (const w of who) {
          const before = calls.get(ch) ?? 0;
          const r = await as(w).call(ch, mk());
          const allowed = r.status === 200;
          if (allowed !== has[w] >= rank[access] || (r.status !== 200 && r.status !== 403)) wrong++;
          if (!allowed && (calls.get(ch) ?? 0) !== before) leaks++;
          line.push(allowed ? 'ALLOW' : 'deny ');
        }
        lines.push(`     ${ch.padEnd(20)} ${access.padEnd(6)} ${line.join(' ')}`);
      }
    };
    // Org channels: alice is an org viewer, bob an org editor, boss the org admin.
    await run([
      ['themes:list', () => undefined, 'read'],
      ['branding:logo', () => 'workspace', 'read'],
      ['formats:set', () => ({ currency: 'USD' }), 'admin'],
      ['branding:set', () => ({ accent: '' }), 'admin'],
      ['branding:clearLogo', () => 'workspace', 'admin'],
      ['rules:set', () => ({ text: '' }), 'admin'],
      ['autorefresh:set', () => true, 'admin'],
      ['notifications:set', () => ({ fields: { alerts: true } }), 'admin'],
      ['themes:save', () => ({ name: 'T', tokens: {} }), 'admin'],
      ['themes:setDefault', () => '', 'admin'],
      ['themes:delete', () => '00000000-0000-4000-8000-000000000000', 'admin'],
      ['backups:download', () => undefined, 'admin'],
    ], ['alice', 'bob', 'boss'], { alice: 1, bob: 2, boss: 3 });
    lines.push('     -- project channels: viewer, editor, project admin (an org editor), org admin');
    await run([
      ['privacy:overview', () => ({ projectId: pid }), 'read'],
      ['privacy:review', () => ({ projectId: pid, datasetId: ds }), 'read'],
      ['privacy:summary', () => ({ projectId: pid, path: 'export', datasetIds: null }), 'read'],
      ['search:query', () => ({ projectId: pid, query: 'c' }), 'read'],
      ['privacy:decide', () => ({ projectId: pid, datasetId: ds, column: 'email', level: 'personal' }), 'write'],
      ['privacy:scan', () => ({ projectId: pid }), 'write'],
      ['privacy:setPolicy', () => ({ projectId: pid, policy: { export: 'mask' } }), 'admin'],
    ], ['alice', 'bob', 'carol', 'boss'], { alice: 1, bob: 2, carol: 3, boss: 3 });
    console.log('     channel              access roles →\n' + lines.join('\n'));
    ok('roles: every new channel allows exactly the roles its access names', wrong === 0, wrong);
    ok('roles: a denied call never reached its handler (spy)', leaks === 0, leaks);
    ok('roles: no grant on the project → privacy and search are 403', (await as('eve').call('privacy:overview', { projectId: pid })).status === 403 && (await as('eve').call('search:query', { projectId: pid, query: 'c' })).status === 403);

    // Restore, as the org admin; an org editor may not (before the handler).
    const dl = (await boss.call('backups:download')).body;
    const bytes = (await boss.download(dl.downloadToken)).bytes;
    const n = calls.get('backups:restore') ?? 0;
    const byBob = await as('bob').call('backups:restore', { fileToken: (await as('bob').upload(bytes, 'b.zip')).fileToken, confirm: 'restore' });
    ok('backups:restore: an org editor gets 403, the handler never ran', byBob.status === 403 && (calls.get('backups:restore') ?? 0) === n);
    const rs = await boss.call('backups:restore', { fileToken: (await boss.upload(bytes, 'b.zip')).fileToken, confirm: 'restore' });
    ok('backups:restore: the org admin restores (records in Postgres)', rs.body.ok === true && rs.body.restored.length >= 1, JSON.stringify(rs.body));
    const audit = await pool.query<{ channel: string; actor: string; outcome: string }>(`SELECT channel, actor, outcome FROM audit_log WHERE channel IN ('backups:download', 'backups:restore')`);
    const has = (ch: string, outcome: string, actor = 'boss@acme.test') => audit.rows.some((r) => r.channel === ch && r.outcome === outcome && r.actor === actor);
    ok('audit: the download and the restore by the admin, and the refusals, are on the trail', has('backups:download', 'ok') && has('backups:restore', 'ok') && has('backups:restore', 'denied', 'bob@acme.test') && has('backups:download', 'denied', 'alice@acme.test'), JSON.stringify(audit.rows));
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
    else console.log('skip settings DB part: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
  } finally {
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
