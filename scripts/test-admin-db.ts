// Admin (T3.4) against a real Postgres, over real HTTP.
//
// Two orgs (acme, beta), each its own server process-in-a-process (header
// sign-in from a trusted 127.0.0.1 peer, one shared database and DATA_DIR,
// server mode, no Electron). For EVERY admin channel: an org viewer and an org
// editor get 403 and the handler never runs; the org admin gets 200; the OTHER
// org's admin, handed this org's ids, changes nothing here. Then each admin
// action for real — invite, role, disable, teams, ownership transfer, audit
// filters and paging, settings and the per-org upload cap under
// MAX_UPLOAD_MB — and the audit row each one leaves (never a value).
//
// Needs a Postgres it may CREATE DATABASE on; without DATABASE_URL it prints
// one skip line. Every run makes its own scratch database and drops it.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-admin-db.js

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
const adminApi: typeof import('../src/api/admin') = require('../src/api/admin');
const config: typeof import('../src/app/config') = require('../src/app/config');

const CANARY = 'c4nary-invitee@acme.test';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-admin-db-'));

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip admin DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  ok('AI_PROVIDERS (the contract) equals config.BYOK_PROVIDERS (what the server can call)',
    JSON.stringify([...adminApi.AI_PROVIDERS]) === JSON.stringify(config.BYOK_PROVIDERS));
  const dbName = `ordinate_t34a_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  const apps: FastifyInstance[] = [];
  try {
    context.enterServerMode(DATA);
    appMod.registerHandlers();

    const channels = Object.keys(adminApi.adminContracts);
    const calls = new Map<string, number>();
    for (const ch of channels) {
      const real = rpc.handlers.get(ch);
      if (!real) continue;
      rpc.registry.removeHandler(ch);
      rpc.registry.handle(ch, (e, ...args) => {
        calls.set(ch, (calls.get(ch) ?? 0) + 1);
        return real(e, ...args);
      });
    }
    const ran = (ch: string) => calls.get(ch) ?? 0;
    ok(`every admin contract (${channels.length}) has a registered handler`, channels.every((c) => rpc.handlers.has(c)), channels.filter((c) => !rpc.handlers.has(c)).join());

    const base: Record<string, string> = {};
    for (const org of ['acme', 'beta']) {
      const app = appMod.buildApp(envMod.parseEnv({
        LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), AUTH_MODE: 'header',
        TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: org, ORDINATE_ADMIN_EMAIL: `boss@${org}.test`,
        ALLOWED_EMAIL_DOMAINS: 'acme.test,beta.test', MAX_UPLOAD_MB: '5',
      }));
      apps.push(app);
      await app.listen({ port: 0, host: '127.0.0.1' });
      base[org] = `http://127.0.0.1:${(app.server.address() as import('net').AddressInfo).port}`;
    }
    const call = async (org: string, email: string, channel: string, payload?: unknown) => {
      const res = await fetch(`${base[org]}/api/rpc/${channel}`, {
        method: 'POST',
        headers: withCsrf({ 'content-type': 'application/json', 'x-forwarded-email': email }),
        body: wire.encode({ args: payload === undefined ? [] : [payload] }),
      });
      const text = await res.text();
      return { status: res.status, body: (res.status === 200 ? wire.decode(text) : text) as any }; // any: each channel's own reply
    };
    const q = async <T extends object>(sql: string, args: unknown[] = []) => (await pool.query<T>(sql, args)).rows;
    const uid = async (email: string) => (await q<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]))[0]?.id;

    // ── People: header sign-in provisions viewers; carol is made an editor ──
    for (const p of ['boss', 'alice', 'carol', 'dave']) await call('acme', `${p}@acme.test`, 'projects:list');
    await call('beta', 'boss@beta.test', 'projects:list');
    await pool.query(`UPDATE users SET role = 'editor' WHERE email = 'carol@acme.test'`);
    const dave = await uid('dave@acme.test');
    const project = (await call('acme', 'boss@acme.test', 'projects:create', { name: 'Ledger' })).body.id as string;
    const betaProject = (await call('beta', 'boss@beta.test', 'projects:create', { name: 'Beta' })).body.id as string;
    const team0 = (await call('acme', 'boss@acme.test', 'admin:createTeam', { name: 'Finance' })).body.id as string;

    // ── The matrix: every admin channel × viewer / editor / org admin / other org's admin ──
    const payloads: Record<string, unknown> = {
      'admin:users': undefined,
      'admin:invite': { email: 'matrix@acme.test', role: 'viewer' },
      'admin:setRole': { userId: dave, role: 'viewer' },
      'admin:setDisabled': { userId: dave, disabled: false },
      'admin:teams': undefined,
      'admin:createTeam': { name: 'Matrix' },
      'admin:renameTeam': { teamId: team0, name: 'Finance' },
      'admin:teamMember': { teamId: team0, userId: dave, member: true },
      'admin:projects': undefined,
      'admin:transferOwner': { projectId: project, teamId: team0 },
      'admin:audit': {},
      'admin:settings': undefined,
      'admin:saveSettings': { publicLinks: false, aiProviders: [...adminApi.AI_PROVIDERS], uploadCapMb: null },
    };
    ok('matrix: a payload for every admin channel', channels.every((c) => c in payloads) && Object.keys(payloads).length === channels.length);
    let unexpectedAllows = 0;
    let leaks = 0;
    const rows: string[] = [];
    for (const [label, email] of [['org viewer', 'alice@acme.test'], ['org editor', 'carol@acme.test']]) {
      const cells: number[] = [];
      for (const ch of channels) {
        const n = ran(ch);
        const r = await call('acme', email, ch, payloads[ch]);
        cells.push(r.status);
        if (r.status !== 403) unexpectedAllows++;
        if (ran(ch) !== n) leaks++;
      }
      rows.push(`${label.padEnd(10)} ${cells.join(' ')}`);
    }
    const adminCells: number[] = [];
    for (const ch of channels) {
      const n = ran(ch);
      const r = await call('acme', 'boss@acme.test', ch, payloads[ch]);
      adminCells.push(r.status);
      if (r.status !== 200 || ran(ch) !== n + 1) leaks++;
    }
    rows.push(`org admin  ${adminCells.join(' ')}`);
    console.log(`     ${channels.length} admin channels, status per caller:\n       ${rows.join('\n       ')}`);
    ok('matrix: org viewers and editors are refused EVERY admin channel (403) — zero unexpected allows', unexpectedAllows === 0, unexpectedAllows);
    ok('matrix: a refused call never reached its handler; an org admin\'s reached it once with 200', leaks === 0, leaks);
    const denied = await q<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE outcome = 'denied' AND channel LIKE 'admin:%'`);
    ok('matrix: every refusal is an audit row (outcome denied)', denied[0].n === 2 * channels.length, denied[0].n);

    // Other org: beta's admin, with acme's ids, changes nothing in acme.
    const snapshot = async () => JSON.stringify(await q(`SELECT
      (SELECT json_agg(u ORDER BY email) FROM (SELECT email, role, disabled_at FROM users WHERE org_id = 'acme') u) AS users,
      (SELECT json_agg(t ORDER BY name) FROM (SELECT name FROM teams WHERE org_id = 'acme') t) AS teams,
      (SELECT count(*) FROM team_members m JOIN teams t ON t.id = m.team_id WHERE t.org_id = 'acme') AS members,
      (SELECT json_agg(g ORDER BY team_id) FROM (SELECT team_id, owner FROM project_grants WHERE project_id = $1 AND team_id IS NOT NULL) g) AS owners,
      (SELECT count(*) FROM org_settings WHERE org_id = 'acme') AS settings`, [project]));
    const before = await snapshot();
    const foreign = {
      'admin:setRole': { userId: dave, role: 'admin' },
      'admin:setDisabled': { userId: dave, disabled: true },
      'admin:renameTeam': { teamId: team0, name: 'Hijacked' },
      'admin:teamMember': { teamId: team0, userId: await uid('boss@beta.test'), member: true },
      'admin:transferOwner': { projectId: project, teamId: team0 },
    };
    const foreignReplies: string[] = [];
    for (const [ch, p] of Object.entries(foreign)) {
      const r = await call('beta', 'boss@beta.test', ch, p);
      foreignReplies.push(`${ch}=${r.status}:${r.body?.ok}`);
    }
    ok('other org: each write with acme ids answers ok:false', foreignReplies.every((x) => x.endsWith(':false')), foreignReplies.join(' '));
    ok('other org: acme\'s users, teams, members, owners and settings are byte-identical afterwards', (await snapshot()) === before);
    const betaUsers = (await call('beta', 'boss@beta.test', 'admin:users')).body as { email: string }[];
    const betaTeams = (await call('beta', 'boss@beta.test', 'admin:teams')).body as unknown[];
    const betaProjects = (await call('beta', 'boss@beta.test', 'admin:projects')).body as { id: string }[];
    const betaAudit = (await call('beta', 'boss@beta.test', 'admin:audit', {})).body as { rows: { actor: string }[] };
    ok('other org: beta\'s admin lists only beta (users, teams, projects, audit)',
      betaUsers.every((u) => u.email.endsWith('@beta.test')) && betaTeams.length === 0
        && betaProjects.length === 1 && betaProjects[0].id === betaProject
        && betaAudit.rows.length > 0 && betaAudit.rows.every((r) => r.actor === 'boss@beta.test'));

    // ── Users: invite, role, disable ─────────────────────────────────────
    const inv = await call('acme', 'boss@acme.test', 'admin:invite', { email: CANARY.toUpperCase(), role: 'editor' });
    const invitee = await q<{ role: string; last_login_at: string | null }>('SELECT role, last_login_at FROM users WHERE email = $1', [CANARY]);
    ok('invite: a pending user row (lower-cased, invited role, never signed in)', inv.body.ok === true && invitee[0]?.role === 'editor' && invitee[0].last_login_at === null);
    ok('invite: the same address again is refused (exists)', (await call('acme', 'boss@acme.test', 'admin:invite', { email: CANARY, role: 'viewer' })).body.error === 'exists');
    ok('invite: an address outside ALLOWED_EMAIL_DOMAINS is refused (domain)', (await call('acme', 'boss@acme.test', 'admin:invite', { email: 'x@else.test', role: 'viewer' })).body.error === 'domain');
    ok('invite: a malformed address is a 400', (await call('acme', 'boss@acme.test', 'admin:invite', { email: 'nope', role: 'viewer' })).status === 400);
    const listed = (await call('acme', 'boss@acme.test', 'admin:users')).body as { email: string; pending: boolean }[];
    ok('users: the invitee is listed as pending', listed.find((u) => u.email === CANARY)?.pending === true);
    await call('acme', CANARY, 'projects:list');
    const after = await q<{ role: string; last_login_at: string | null }>('SELECT role, last_login_at FROM users WHERE email = $1', [CANARY]);
    ok('invite: the first sign-in activates the row and keeps the invited role', after[0].role === 'editor' && after[0].last_login_at !== null);

    const boss = await uid('boss@acme.test');
    ok('role: the last enabled admin cannot be demoted', (await call('acme', 'boss@acme.test', 'admin:setRole', { userId: boss, role: 'editor' })).body.error === 'last-admin');
    ok('role: dave → admin', (await call('acme', 'boss@acme.test', 'admin:setRole', { userId: dave, role: 'admin' })).body.ok === true);
    ok('role: with a second admin, dave → editor works', (await call('acme', 'boss@acme.test', 'admin:setRole', { userId: dave, role: 'editor' })).body.ok === true
      && (await q<{ role: string }>('SELECT role FROM users WHERE id = $1', [dave]))[0].role === 'editor');
    ok('role: takes effect on the next request (dave may now create a project)', (await call('acme', 'dave@acme.test', 'projects:create', { name: 'Dave\'s' })).status === 200);
    ok('disable: an admin cannot disable themselves', (await call('acme', 'boss@acme.test', 'admin:setDisabled', { userId: boss, disabled: true })).body.error === 'self');
    ok('disable: dave is disabled', (await call('acme', 'boss@acme.test', 'admin:setDisabled', { userId: dave, disabled: true })).body.ok === true);
    ok('disable: dave\'s next request is refused (401)', (await call('acme', 'dave@acme.test', 'projects:list')).status === 401);
    ok('enable: dave is back', (await call('acme', 'boss@acme.test', 'admin:setDisabled', { userId: dave, disabled: false })).body.ok === true
      && (await call('acme', 'dave@acme.test', 'projects:list')).status === 200);

    // ── Teams ────────────────────────────────────────────────────────────
    ok('teams: a duplicate name is refused (exists)', (await call('acme', 'boss@acme.test', 'admin:createTeam', { name: 'Finance' })).body.error === 'exists');
    const ops = (await call('acme', 'boss@acme.test', 'admin:createTeam', { name: 'Ops' })).body.id as string;
    ok('teams: rename to a taken name is refused, to a free one works',
      (await call('acme', 'boss@acme.test', 'admin:renameTeam', { teamId: ops, name: 'Finance' })).body.error === 'exists'
        && (await call('acme', 'boss@acme.test', 'admin:renameTeam', { teamId: ops, name: 'Operations' })).body.ok === true);
    const alice = await uid('alice@acme.test');
    await call('acme', 'boss@acme.test', 'admin:teamMember', { teamId: ops, userId: alice, member: true });
    await call('acme', 'boss@acme.test', 'admin:teamMember', { teamId: ops, userId: dave, member: true });
    await call('acme', 'boss@acme.test', 'admin:teamMember', { teamId: ops, userId: dave, member: false });
    const teams = (await call('acme', 'boss@acme.test', 'admin:teams')).body as { name: string; members: { email: string }[] }[];
    ok('teams: listed with members (alice in Operations, dave added then removed)',
      JSON.stringify(teams.find((t) => t.name === 'Operations')?.members.map((m) => m.email)) === '["alice@acme.test"]', JSON.stringify(teams));

    // ── Ownership transfer ───────────────────────────────────────────────
    const ownerOf = async () => (await call('acme', 'boss@acme.test', 'admin:projects')).body.find((p: { id: string }) => p.id === project)?.owner?.name;
    ok('owner: Finance owns Ledger (the matrix call transferred it)', (await ownerOf()) === 'Finance');
    ok('owner: alice (no grant) cannot share Ledger yet', (await call('acme', 'alice@acme.test', 'project:share', { projectId: project, member: { userId: dave }, role: 'viewer' })).status === 403);
    ok('owner: transfer to Operations', (await call('acme', 'boss@acme.test', 'admin:transferOwner', { projectId: project, teamId: ops })).body.ok === true && (await ownerOf()) === 'Operations');
    const grants = await q<{ name: string; role: string; owner: boolean }>(
      'SELECT t.name, g.role, g.owner FROM project_grants g JOIN teams t ON t.id = g.team_id WHERE g.project_id = $1 ORDER BY t.name', [project]);
    ok('owner: one owner; the previous owner team keeps an admin grant', JSON.stringify(grants) === '[{"name":"Finance","role":"admin","owner":false},{"name":"Operations","role":"admin","owner":true}]', JSON.stringify(grants));
    ok('owner: alice, through Operations, is now admin on Ledger', (await call('acme', 'alice@acme.test', 'project:share', { projectId: project, member: { userId: dave }, role: 'viewer' })).status === 200);
    ok('owner: an unknown project is refused', (await call('acme', 'boss@acme.test', 'admin:transferOwner', { projectId: betaProject, teamId: ops })).body.error === 'unknown project');
    ok('owner: project:share cannot strip the owner grant', (await call('acme', 'boss@acme.test', 'project:share', { projectId: project, member: { teamId: ops }, role: null })).status === 200 && (await ownerOf()) === 'Operations');

    // ── Settings and the per-org upload cap ──────────────────────────────
    const s0 = (await call('acme', 'boss@acme.test', 'admin:settings')).body;
    ok('settings: defaults — public links off, every provider, no cap, ceiling = MAX_UPLOAD_MB',
      s0.publicLinks === false && s0.aiProviders.length === 4 && s0.uploadCapMb === null && s0.maxUploadMb === 5, JSON.stringify(s0));
    ok('settings: a cap above MAX_UPLOAD_MB is refused', (await call('acme', 'boss@acme.test', 'admin:saveSettings', { publicLinks: true, aiProviders: ['openai'], uploadCapMb: 6 })).body.error === 'cap');
    ok('settings: an unknown provider is a 400', (await call('acme', 'boss@acme.test', 'admin:saveSettings', { publicLinks: true, aiProviders: ['ollama'], uploadCapMb: 1 })).status === 400);
    ok('settings: saved', (await call('acme', 'boss@acme.test', 'admin:saveSettings', { publicLinks: true, aiProviders: ['openai', 'anthropic'], uploadCapMb: 1 })).body.ok === true);
    const s1 = (await call('acme', 'boss@acme.test', 'admin:settings')).body;
    ok('settings: read back (providers in canonical order)', s1.publicLinks === true && JSON.stringify(s1.aiProviders) === '["anthropic","openai"]' && s1.uploadCapMb === 1, JSON.stringify(s1));
    const upload = async (org: string, mb: number) => {
      const form = new FormData();
      form.append('file', new Blob([Buffer.alloc(mb * 1024 * 1024 + 1024, 97)]), 'big.csv');
      const r = await fetch(`${base[org]}/api/files`, { method: 'POST', headers: withCsrf({ 'x-forwarded-email': `boss@${org}.test` }), body: form }).catch(() => null);
      return r ? r.status : 0;
    };
    ok('upload cap: acme (org cap 1 MB) refuses 2 MB with 413', (await upload('acme', 2)) === 413);
    ok('upload cap: beta (no org cap, ceiling 5 MB) accepts 2 MB', (await upload('beta', 2)) === 200);
    ok('upload cap: the ceiling still holds for beta (6 MB → 413)', (await upload('beta', 6)) === 413);

    // ── Audit: every admin action is a row; filters; keyset paging ────────
    const trail = await q<{ channel: string; outcome: string; actor: string; j: string }>(
      `SELECT channel, outcome, actor, row_to_json(a)::text AS j FROM audit_log a WHERE org_id = 'acme' AND channel LIKE 'admin:%' ORDER BY id`);
    const okChannels = new Set(trail.filter((r) => r.outcome === 'ok').map((r) => r.channel));
    const lists = channels.filter((c) => (adminApi.adminContracts as Record<string, { audit?: unknown }>)[c].audit === 'denials');
    const writes = channels.filter((c) => !lists.includes(c));
    ok(`audit: every admin WRITE (${writes.length}) left an ok row`, writes.every((c) => okChannels.has(c)), writes.filter((c) => !okChannels.has(c)).join());
    ok(`audit: the ${lists.length} lists the screens load leave no ok row (so reading the log does not grow it)`,
      lists.length === 5 && lists.every((c) => !okChannels.has(c)), lists.join());
    const deniedChannels = new Set(trail.filter((r) => r.outcome === 'denied').map((r) => r.channel));
    ok('audit: a REFUSED call is a row on every admin channel, lists included', channels.every((c) => deniedChannels.has(c)));
    ok('audit: the transfer row names the project and the team', (await q(`SELECT 1 FROM audit_log WHERE channel = 'admin:transferOwner' AND outcome = 'ok' AND $1 = ANY(target_ids) AND $2 = ANY(target_ids)`, [project, ops])).length >= 1);
    const dump = (await q<{ j: string }>('SELECT json_agg(a)::text AS j FROM audit_log a'))[0].j;
    ok('audit (canary): the invited address, a value, is in no row', !dump.includes('c4nary') && !trail.some((r) => r.j.includes('c4nary')));

    const page = async (f: Record<string, unknown>) => (await call('acme', 'boss@acme.test', 'admin:audit', f)).body as { rows: { id: number; channel: string; outcome: string; actor: string; projectId: string | null; targets: string[] }[]; next: number | null; channels?: string[] };
    const byChannel = await page({ channel: 'admin:setRole' });
    ok('audit filter: channel', byChannel.rows.length > 0 && byChannel.rows.every((r) => r.channel === 'admin:setRole'));
    const byActor = await page({ actor: 'ALICE' });
    ok('audit filter: actor (case-insensitive contains)', byActor.rows.length > 0 && byActor.rows.every((r) => r.actor === 'alice@acme.test'));
    const byOutcome = await page({ outcome: 'denied', limit: 200 });
    ok('audit filter: outcome', byOutcome.rows.length >= 2 * channels.length && byOutcome.rows.every((r) => r.outcome === 'denied'));
    const byProject = await page({ projectId: project, limit: 200 });
    ok('audit filter: project (authorized against it, or named in the ids)', byProject.rows.length > 0 && byProject.rows.every((r) => r.projectId === project || r.targets.includes(project)));
    const future = await page({ from: new Date(Date.now() + 86_400_000).toISOString() });
    const all = await page({ from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), limit: 200 });
    ok('audit filter: date range', future.rows.length === 0 && all.rows.length > 20);
    ok('audit filter: a LIKE wildcard in actor is literal', (await page({ actor: '%' })).rows.length === 0);
    ok('audit: the first page offers the channel list', !!all.channels && all.channels.includes('admin:invite') && all.channels.includes('projects:create'));
    const seen: number[] = [];
    let cursor: number | undefined;
    let pages = 0;
    do {
      const p = await page({ limit: 7, ...(cursor ? { before: cursor } : {}) });
      seen.push(...p.rows.map((r) => r.id));
      cursor = p.next ?? undefined;
      pages++;
    } while (cursor && pages < 100);
    const total = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE org_id = 'acme'`))[0].n;
    ok(`audit paging: ${pages} pages of 7 cover all ${total} rows once, newest first`,
      seen.length === total && new Set(seen).size === total && seen.every((id, i) => i === 0 || id < seen[i - 1]), `${seen.length} ${total}`);
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
