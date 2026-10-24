// IdP groups decide role and teams (docs/sso-lifecycle/00-design.md §7.1).
//
// Part 1 (no database): the pure mapping, the claim and header readers, the
// digest and the environment parsers.
// Part 2 (DATABASE_URL): sign-in end to end — OIDC through scripts/mockOidc.ts
// and header mode over injected peers — the fail-open traps with their
// negative controls, the managed-role refusals, the last-admin rule under a
// deterministic race, the audit trail and the teams memo.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-idpGroups.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Writable } from 'stream';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { startMockOidc, type MockOidc } from './mockOidc';

const idp: typeof import('../src/server/auth/idpGroups') = require('../src/server/auth/idpGroups');
const reapply: typeof import('../src/server/auth/idpReapply') = require('../src/server/auth/idpReapply');
const idpEnv: typeof import('../src/server/idpEnv') = require('../src/server/idpEnv');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const store: typeof import('../src/server/auth/store') = require('../src/server/auth/store');
const context: typeof import('../src/server/context') = require('../src/server/context');
const caller: typeof import('../src/server/authz/caller') = require('../src/server/authz/caller');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');

type Mapping = import('../src/server/auth/idpGroups').GroupMapping;
const throws = (fn: () => unknown, re: RegExp): boolean => {
  try {
    fn();
    return false;
  } catch (err) {
    return re.test((err as Error).message);
  }
};

function pure(): void {
  // ── a. The mapping ─────────────────────────────────────────────────────
  const T1 = '11111111-1111-4111-8111-111111111111';
  const T2 = '22222222-2222-4222-8222-222222222222';
  const map: Mapping[] = [
    { group: 'bi-admins', role: 'admin', teamId: null },
    { group: 'bi-editors', role: 'editor', teamId: T1 },
    { group: 'analysts', role: null, teamId: T2 },
  ];
  const m = (groups: string[], bg = false) => idp.rolesAndTeams(groups, map, bg);
  ok('mapping: the highest mapped role wins', m(['bi-editors', 'bi-admins']).role === 'admin' && m(['bi-editors']).role === 'editor');
  ok('mapping: no mapped group is a viewer', m(['marketing']).role === 'viewer' && m([]).role === 'viewer');
  ok('mapping: break-glass is admin whatever the groups', m([], true).role === 'admin' && m(['bi-editors'], true).role === 'admin');
  ok('mapping: linked teams are exactly the matched groups\' teams', JSON.stringify(m(['bi-editors', 'analysts']).teams) === JSON.stringify([T1, T2].sort()) && m(['bi-admins']).teams.length === 0);
  ok('mapping: every linked team is listed (the only ones a sync touches)', JSON.stringify(m([]).linked) === JSON.stringify([T1, T2].sort()));
  const teamsOnly: Mapping[] = [{ group: 'analysts', role: null, teamId: T2 }];
  ok('mapping: no role row → roles are manual (null), break-glass still admin', idp.rolesAndTeams(['analysts'], teamsOnly, false).role === null && idp.rolesAndTeams([], teamsOnly, true).role === 'admin');
  ok('last admin: kept when no other signed-in admin remains', idp.keepLastAdmin('admin', 'viewer', 0) === 'admin');
  ok('NEGATIVE CONTROL: a second signed-in admin lets the demotion through', idp.keepLastAdmin('admin', 'viewer', 1) === 'viewer');
  ok('last admin: a non-admin is never "kept"', idp.keepLastAdmin('editor', 'viewer', 0) === 'viewer');
  ok('canonical: NFC and trimmed, deduplicated and sorted', JSON.stringify(idp.canonGroups([' b ', 'a', 'Café', 'a', ''])) === JSON.stringify(['Café', 'a', 'b'].sort()));
  ok('matching is case-sensitive: "Admins" is not "admins"', m(['BI-Admins']).role === 'viewer');
  ok('NEGATIVE CONTROL: the exact name matches', m(['bi-admins']).role === 'admin');

  // ── b. Reading the claim and the header ───────────────────────────────
  const g = (claims: Record<string, unknown> | undefined, name = 'groups') => JSON.stringify(idp.groupsFromClaims(claims, name));
  ok('claim: absent / null / number / object / boolean → absent', [{}, { groups: null }, { groups: 3 }, { groups: { a: 1 } }, { groups: true }, undefined].every((c) => g(c) === '"absent"'));
  ok('claim: an array holding a non-string → absent, never a partial list', g({ groups: ['a', 2] }) === '"absent"');
  ok('claim: a string is one group; an array the list', g({ groups: 'a' }) === '["a"]' && g({ groups: ['b', 'a'] }) === '["a","b"]');
  ok('claim: an explicit empty list is [] (it changes things)', g({ groups: [] }) === '[]');
  ok('claim: Entra overage (`_claim_names` naming the claim) → overage, even with a list', g({ _claim_names: { groups: 'src1' }, groups: ['a'] }) === '"overage"');
  ok('claim: `hasgroups` → overage for the groups claim', g({ hasgroups: true }) === '"overage"' && g({ hasgroups: 'true' }) === '"overage"');
  ok('claim: `hasgroups` is about groups, not app roles', g({ hasgroups: true, roles: ['a'] }, 'roles') === '["a"]');
  ok('claim: `_claim_names` naming another claim is not this claim\'s overage', g({ _claim_names: { groups: 'src1' }, roles: ['a'] }, 'roles') === '["a"]');
  ok('claim: a namespaced top-level claim is read as one key', g({ 'https://acme.test/groups': ['a'] }, 'https://acme.test/groups') === '["a"]');
  ok('header: missing → absent; empty → []; comma-separated, trimmed', JSON.stringify(idp.groupsFromHeader(undefined)) === '"absent"'
    && JSON.stringify(idp.groupsFromHeader('')) === '[]' && JSON.stringify(idp.groupsFromHeader('b, a ,,a')) === '["a","b"]');
  ok('digest: order-free, and the break-glass flag counts', idp.digestOf(['a', 'b'], false) === idp.digestOf(idp.canonGroups(['b', 'a']), false) && idp.digestOf(['a'], true) !== idp.digestOf(['a'], false));

  // ── k. Environment ─────────────────────────────────────────────────────
  const base = { LOG_LEVEL: 'silent', DATABASE_URL: 'postgres://x@127.0.0.1/x' };
  const oidc = { ...base, AUTH_MODE: 'oidc', OIDC_ISSUER: 'http://127.0.0.1:1', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', OIDC_REDIRECT_URL: 'http://127.0.0.1:1/api/auth/callback' };
  const header = { ...base, AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32' };
  const parsed = envMod.parseEnv({ ...oidc, OIDC_GROUPS_CLAIM: 'groups', OIDC_EXTRA_SCOPES: 'groups, openid offline_access groups' });
  ok('env: OIDC_GROUPS_CLAIM and OIDC_EXTRA_SCOPES (deduplicated, the always-sent ones dropped)',
    JSON.stringify(parsed.auth.groupsFrom) === '{"claim":"groups"}' && JSON.stringify(parsed.auth.oidc?.extraScopes) === '["groups","offline_access"]');
  ok('env: TRUSTED_GROUPS_HEADER is lower-cased', JSON.stringify(envMod.parseEnv({ ...header, TRUSTED_GROUPS_HEADER: 'X-Forwarded-Groups' }).auth.groupsFrom) === '{"header":"x-forwarded-groups"}');
  ok('env: unset → groups are not read; tokens live 365 days', envMod.parseEnv(header).auth.groupsFrom === null && envMod.parseEnv(header).auth.apiTokenMaxDays === 365);
  ok('env: OIDC_GROUPS_CLAIM under header mode refuses to start', throws(() => envMod.parseEnv({ ...header, OIDC_GROUPS_CLAIM: 'groups' }), /OIDC_GROUPS_CLAIM is read only when AUTH_MODE=oidc/));
  ok('env: TRUSTED_GROUPS_HEADER under oidc refuses to start', throws(() => envMod.parseEnv({ ...oidc, TRUSTED_GROUPS_HEADER: 'x-groups' }), /TRUSTED_GROUPS_HEADER is read only/));
  ok('env: OIDC_EXTRA_SCOPES under header mode refuses to start', throws(() => envMod.parseEnv({ ...header, OIDC_EXTRA_SCOPES: 'groups' }), /OIDC_EXTRA_SCOPES is read only/));
  ok('env: a header name with a space, or X-Forwarded-Email itself, refuses to start',
    throws(() => idpEnv.groupsFrom('header', undefined, 'x groups'), /header name/) && throws(() => idpEnv.groupsFrom('header', undefined, 'X-Forwarded-Email'), /already means/));
  ok('env: a scope with a quote refuses to start', throws(() => idpEnv.extraScopes('oidc', 'a"b'), /not a scope/));
  ok('env: API_TOKEN_MAX_DAYS 0, 3651 and "x" refuse; 1 and 3650 parse',
    ['0', '3651', 'x', '1.5'].every((v) => throws(() => idpEnv.apiTokenMaxDays(v), /API_TOKEN_MAX_DAYS/)) && idpEnv.apiTokenMaxDays('1') === 1 && idpEnv.apiTokenMaxDays('3650') === 3650);
}

const SECRET = 'idp-groups-client-secret';
const sink = new Writable({ write: (_c, _e, cb) => cb() });

async function db(): Promise<void> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip idp groups DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_idp_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const root = new Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 6 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  let mock: MockOidc | null = null;
  const apps: FastifyInstance[] = [];
  appMod.registerHandlers(); // the admin channels and the row-access caller read the built app's pool
  try {
    await oidcPart(scratch.toString(), pool, apps, (m) => (mock = m));
    await headerPart(scratch.toString(), pool, apps);
    await dormantPart(scratch.toString(), apps);
  } finally {
    for (const a of apps) await a.close().catch(() => undefined);
    await (mock as MockOidc | null)?.close();
    await pool.end();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  }
}

const q = async <T = Record<string, unknown>>(pool: Pool, sql: string, args: unknown[] = []): Promise<T[]> => (await pool.query(sql, args)).rows as T[];
const roleOf = async (pool: Pool, email: string) => (await q<{ role: string }>(pool, 'SELECT role FROM users WHERE email = $1', [email]))[0]?.role;
const teamsOf = async (pool: Pool, email: string) =>
  (await q<{ name: string }>(pool, 'SELECT t.name FROM team_members m JOIN teams t ON t.id = m.team_id JOIN users u ON u.id = m.user_id WHERE u.email = $1 ORDER BY t.name', [email])).map((r) => r.name).join(',');
const team = async (pool: Pool, org: string, name: string) => (await q<{ id: string }>(pool, 'INSERT INTO teams (org_id, name) VALUES ($1, $2) RETURNING id::text', [org, name]))[0].id;
const mapGroup = async (pool: Pool, org: string, group: string, role: string | null, teamId: string | null) =>
  pool.query('INSERT INTO idp_groups (org_id, group_name, role, team_id) VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, group_name) DO UPDATE SET role = $3, team_id = $4', [org, group, role, teamId]);

// ── c, d. OIDC ─────────────────────────────────────────────────────────────
async function oidcPart(url: string, pool: Pool, apps: FastifyInstance[], keep: (m: MockOidc) => void): Promise<void> {
  const idpMod: typeof import('../src/server/auth/idpGroups') = require('../src/server/auth/idpGroups');
  const idp = await startMockOidc({ clientId: 'ordinate-test', clientSecret: SECRET });
  keep(idp);
  const cfg = envMod.parseEnv({
    LOG_LEVEL: 'silent', DATABASE_URL: url, AUTH_MODE: 'oidc', OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: 'ordinate-test',
    OIDC_CLIENT_SECRET: SECRET, OIDC_REDIRECT_URL: 'http://127.0.0.1:1/api/auth/callback', ORDINATE_ORG: 'acme',
    ORDINATE_ADMIN_EMAIL: 'boss@acme.test', OIDC_GROUPS_CLAIM: 'groups', OIDC_EXTRA_SCOPES: 'groups',
  });
  const app = appMod.buildApp(cfg, sink);
  apps.push(app);
  await app.ready();
  const signIn = async (email: string, claims: Record<string, unknown>) => {
    idp.extraClaims = claims;
    const login = await app.inject({ method: 'GET', url: '/api/auth/login' });
    const tx = login.cookies.find((c) => c.name === 'ordinate_login');
    const back = new URL(await idp.approve(String(login.headers.location), email));
    const cb = await app.inject({ method: 'GET', url: back.pathname + back.search, headers: tx ? { cookie: `ordinate_login=${tx.value}` } : {} });
    return { login, cb, id: cb.cookies.find((c) => c.name === 'ordinate_session' && c.value)?.value };
  };
  const analysts = await team(pool, 'acme', 'Analysts');
  const sales = await team(pool, 'acme', 'Sales');
  const manual = await team(pool, 'acme', 'Manual');
  await mapGroup(pool, 'acme', 'bi-editors', 'editor', analysts);
  await mapGroup(pool, 'acme', 'bi-admins', 'admin', null);
  await mapGroup(pool, 'acme', 'sales', null, sales);

  const first = await signIn('carol@acme.test', { groups: ['bi-editors'] });
  ok('oidc: the authorize URL asks for OIDC_EXTRA_SCOPES', new URL(String(first.login.headers.location)).searchParams.get('scope') === 'openid email profile groups');
  ok('oidc: a sign-in with groups sets the mapped role and linked team, before the session', !!first.id && (await roleOf(pool, 'carol@acme.test')) === 'editor' && (await teamsOf(pool, 'carol@acme.test')) === 'Analysts');
  await pool.query(`INSERT INTO team_members (team_id, user_id) SELECT $1, id FROM users WHERE email = 'carol@acme.test'`, [manual]);
  await signIn('carol@acme.test', { groups: ['sales', 'bi-admins'] });
  ok('oidc: moving between groups changes role and teams at the next sign-in; a manual team is untouched',
    (await roleOf(pool, 'carol@acme.test')) === 'admin' && (await teamsOf(pool, 'carol@acme.test')) === 'Manual,Sales', await teamsOf(pool, 'carol@acme.test'));
  await signIn('dave@acme.test', { groups: ['bi-editors', 'sales'] });
  const before = `${await roleOf(pool, 'dave@acme.test')}|${await teamsOf(pool, 'dave@acme.test')}`;
  const absent = await signIn('dave@acme.test', {});
  const overage = await signIn('dave@acme.test', { _claim_names: { groups: 'src1' }, _claim_sources: { src1: { endpoint: 'https://graph.example/x' } } });
  const malformed = await signIn('dave@acme.test', { groups: ['sales', 7] });
  ok('oidc: an absent claim, Entra\'s overage and a malformed claim change nothing (and still sign in)',
    !!absent.id && !!overage.id && !!malformed.id && `${await roleOf(pool, 'dave@acme.test')}|${await teamsOf(pool, 'dave@acme.test')}` === before, before);
  await signIn('dave@acme.test', { groups: [] });
  ok('NEGATIVE CONTROL: an explicit empty list demotes to viewer and leaves every linked team', (await roleOf(pool, 'dave@acme.test')) === 'viewer' && (await teamsOf(pool, 'dave@acme.test')) === '');
  // S-M1: an OIDC sign-in under a held people lock tries twice, then signs in with the stored role.
  idpMod.setSyncTimingForTest({ waitMs: 300, lockMs: 300 });
  const holder = new Client({ connectionString: url });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('people:acme', 0))`);
    const busy = await signIn('dave@acme.test', { groups: ['bi-admins'] });
    ok('S-M1: an OIDC sign-in while the lock is held still signs in, with the stored role (viewer), nothing synced',
      !!busy.id && (await roleOf(pool, 'dave@acme.test')) === 'viewer', String(busy.cb.headers.location));
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
    idpMod.setSyncTimingForTest(null);
  }
  await signIn('boss@acme.test', { groups: [] });
  ok('oidc: the break-glass admin stays admin with no mapped group', (await roleOf(pool, 'boss@acme.test')) === 'admin');
  const rows = await q<{ actor: string; outcome: string; targets: string[] }>(pool, `SELECT actor, outcome, target_ids::text[] AS targets FROM audit_log WHERE channel = 'idp:sync' ORDER BY id`);
  ok('audit: one idp:sync row per sign-in that changed something, naming the member and the teams',
    rows.filter((r) => r.actor === 'carol@acme.test').length === 2 && rows.filter((r) => r.actor === 'dave@acme.test').length === 2
      && rows.some((r) => r.actor === 'carol@acme.test' && r.targets.includes(sales) && r.targets.includes(analysts)), JSON.stringify(rows));
  await app.close();
}

// ── e–i. Header mode ───────────────────────────────────────────────────────
async function headerPart(url: string, pool: Pool, apps: FastifyInstance[]): Promise<void> {
  const cfg = envMod.parseEnv({
    LOG_LEVEL: 'silent', DATABASE_URL: url, AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'hdr',
    ORDINATE_ADMIN_EMAIL: 'root@hdr.test', TRUSTED_GROUPS_HEADER: 'X-Forwarded-Groups',
  });
  const app = appMod.buildApp(cfg, sink);
  apps.push(app);
  await app.ready();
  const me = async (email: string, groups?: string, peer = '127.0.0.1', extra: Record<string, string> = {}) => {
    const r = await app.inject({ method: 'GET', url: '/api/auth/me', remoteAddress: peer, headers: { 'x-forwarded-email': email, ...(groups !== undefined ? { 'x-forwarded-groups': groups } : {}), ...extra } });
    return (r.json() as { user: { role: string } | null }).user?.role ?? null;
  };
  const xmin = async (email: string) => (await q<{ x: string }>(pool, 'SELECT xmin::text AS x FROM users WHERE email = $1', [email]))[0]?.x;
  const ops = await team(pool, 'hdr', 'Ops');
  await mapGroup(pool, 'hdr', 'ops', 'editor', ops);
  await mapGroup(pool, 'hdr', 'admins', 'admin', null);
  ok('header: the break-glass admin signs in (another admin, so the demotions below are not the last admin\'s)', (await me('root@hdr.test', 'ops')) === 'admin');

  ok('header: groups from a trusted peer apply (role and linked team)', (await me('erin@hdr.test', 'ops')) === 'editor' && (await teamsOf(pool, 'erin@hdr.test')) === 'Ops');
  const x0 = await xmin('erin@hdr.test');
  for (let i = 0; i < 3; i++) await me('erin@hdr.test', ' ops ');
  ok('header: the same groups again write nothing (the users row is untouched over 3 requests)', (await xmin('erin@hdr.test')) === x0, `${x0}`);
  await me('erin@hdr.test');
  ok('header: a missing header writes nothing and changes nothing (m5)', (await xmin('erin@hdr.test')) === x0 && (await roleOf(pool, 'erin@hdr.test')) === 'editor');
  ok('header: the same header from an UNTRUSTED peer is not believed: 401, nothing written',
    (await me('erin@hdr.test', 'admins', '203.0.113.9')) === null && (await roleOf(pool, 'erin@hdr.test')) === 'editor' && (await xmin('erin@hdr.test')) === x0);
  ok('NEGATIVE CONTROL: from the trusted peer, the same header promotes', (await me('erin@hdr.test', 'admins')) === 'admin');
  await me('erin@hdr.test', 'ops');
  // A bearer request is decided by its token alone: a groups header beside it is never read.
  const userId = (await q<{ id: string }>(pool, `SELECT id::text FROM users WHERE email = 'erin@hdr.test'`))[0].id;
  const token = 'ord_' + 'A'.repeat(43);
  await pool.query(`INSERT INTO api_tokens (user_id, name, token_hash, prefix, expires_at) VALUES ($1, 't', $2, 'ord_AAAAAAAA', now() + interval '1 day')`, [userId, store.hashId(token)]);
  const x1 = await xmin('erin@hdr.test');
  const bearer = async (peer: string) => {
    const r = await app.inject({ method: 'GET', url: '/api/auth/me', remoteAddress: peer, headers: { 'x-forwarded-email': 'erin@hdr.test', 'x-forwarded-groups': 'admins', authorization: `Bearer ${token}` } });
    return (r.json() as { user: { role: string } | null }).user?.role ?? `${r.statusCode} ${r.body}`;
  };
  const b1 = await bearer('127.0.0.1');
  ok('header: bearer + groups header from a trusted peer → the token\'s current role, groups ignored', b1 === 'editor', String(b1));
  ok('header: bearer + groups header from an untrusted peer → the same, groups ignored', (await bearer('203.0.113.9')) === 'editor' && (await roleOf(pool, 'erin@hdr.test')) === 'editor' && (await xmin('erin@hdr.test')) === x1, `${x1}`);

  // M1: the break-glass admin is restored in one request even when the digest matches.
  await pool.query(`UPDATE users SET role = 'viewer' WHERE email = 'root@hdr.test'`);
  ok('header: a demoted break-glass admin is admin again after one request (digest unchanged)', (await me('root@hdr.test', 'ops')) === 'admin');

  // 1i: the teams memo. A sync inside a request context forgets it.
  const idpMod: typeof import('../src/server/auth/idpGroups') = require('../src/server/auth/idpGroups');
  const P = '0b3c7c3e-6c2a-4c8e-9d7a-2f0d1c9b8a01';
  const fred = { user: { email: 'fred@hdr.test', role: 'viewer' as const }, org: { id: 'hdr' } };
  await me('fred@hdr.test', 'ops');
  const fredId = (await q<{ id: string }>(pool, `SELECT id::text FROM users WHERE email = 'fred@hdr.test'`))[0].id;
  const inside = await context.runInContext(fred, 'memo-test', async () => {
    const a = (await caller.callerOn(P)).teamIds.length;
    await idpMod.applyIdpGroups(pool, cfg.auth, { userId: fredId, email: 'fred@hdr.test' }, [], { compare: false, log: app.log });
    return [a, (await caller.callerOn(P)).teamIds.length];
  });
  ok('memo: a sync inside a request leaves no stale teams (1 → 0 in the same request)', inside[0] === 1 && inside[1] === 0, JSON.stringify(inside));
  await me('fred@hdr.test', 'ops');
  const stale = await context.runInContext(fred, 'memo-control', async () => {
    const a = (await caller.callerOn(P)).teamIds.length;
    await pool.query('DELETE FROM team_members WHERE user_id = $1', [fredId]);
    return [a, (await caller.callerOn(P)).teamIds.length];
  });
  ok('NEGATIVE CONTROL: a raw change without the forget is still memoised (1 → 1)', stale[0] === 1 && stale[1] === 1, JSON.stringify(stale));

  // ── f. Managed means managed (over the RPC route, as the break-glass admin) ──
  const rpc = async (channel: string, payload?: unknown, email = 'root@hdr.test') => {
    const r = await app.inject({ method: 'POST', url: `/api/rpc/${channel}`, remoteAddress: '127.0.0.1',
      headers: withCsrf({ 'content-type': 'application/json', 'x-forwarded-email': email }), payload: wire.encode({ args: payload === undefined ? [] : [payload] }) });
    return { status: r.statusCode, body: (r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body)) as any }; // any: each channel's reply
  };
  const idOf = async (email: string) => (await q<{ id: string }>(pool, 'SELECT id::text FROM users WHERE email = $1', [email]))[0].id;
  const erin = await idOf('erin@hdr.test');
  const refusedRole = await rpc('admin:setRole', { userId: erin, role: 'viewer' });
  ok('managed: admin:setRole is 409 idp_managed with the catalog sentence while a group maps a role',
    refusedRole.status === 409 && refusedRole.body.code === 'idp_managed' && /identity provider/.test(refusedRole.body.message) && (await roleOf(pool, 'erin@hdr.test')) === 'editor', JSON.stringify(refusedRole));
  const invited = await rpc('admin:invite', { email: 'newbie@hdr.test', role: 'admin' });
  ok('C4: while roles follow the IdP an invite is stored as a viewer, whatever role it names',
    invited.body?.ok === true && (await roleOf(pool, 'newbie@hdr.test')) === 'viewer', `${JSON.stringify(invited)} ${await roleOf(pool, 'newbie@hdr.test')}`);
  const view = (await rpc('admin:idpGroups')).body;
  ok('admin:idpGroups: the source, the header, the map with team names, what is managed',
    view.source === 'header' && view.from === 'x-forwarded-groups' && view.roleManaged === true && view.linkedTeamIds.includes(ops)
      && view.groups.some((g: { group: string; teamName: string }) => g.group === 'ops' && g.teamName === 'Ops'), JSON.stringify(view));
  await pool.query(`UPDATE idp_groups SET role = NULL WHERE org_id = 'hdr' AND team_id IS NOT NULL`);
  await pool.query(`DELETE FROM idp_groups WHERE org_id = 'hdr' AND team_id IS NULL`);
  const allowed = await rpc('admin:setRole', { userId: erin, role: 'viewer' });
  ok('NEGATIVE CONTROL: with no group mapping a role, admin:setRole works (roles are manual)', allowed.body?.ok === true && (await roleOf(pool, 'erin@hdr.test')) === 'viewer', JSON.stringify(allowed));
  await rpc('admin:invite', { email: 'newbie2@hdr.test', role: 'editor' });
  ok('NEGATIVE CONTROL (C4): with roles manual, an invite keeps the role it names', (await roleOf(pool, 'newbie2@hdr.test')) === 'editor');
  const linkedRefused = await rpc('admin:teamMember', { teamId: ops, userId: erin, member: false });
  ok('managed: admin:teamMember is 409 idp_managed on a linked team', linkedRefused.status === 409 && linkedRefused.body.code === 'idp_managed' && (await teamsOf(pool, 'erin@hdr.test')) === 'Ops', JSON.stringify(linkedRefused));
  const manual = await team(pool, 'hdr', 'Manual');
  const manualOk = await rpc('admin:teamMember', { teamId: manual, userId: erin, member: true });
  ok('NEGATIVE CONTROL: admin:teamMember works on a manual team, and clears the digest (re-checked next request)',
    manualOk.body?.ok === true && (await teamsOf(pool, 'erin@hdr.test')) === 'Manual,Ops'
      && (await q<{ d: string | null }>(pool, `SELECT idp_groups_digest AS d FROM users WHERE email = 'erin@hdr.test'`))[0].d === null);

  // ── j. A map change applies at once: a newly linked team is emptied and refilled from stored groups ──
  const ana = await team(pool, 'hdr', 'Analysts');
  await me('gus@hdr.test', 'misc');
  await pool.query(`INSERT INTO team_members (team_id, user_id) SELECT $1, id FROM users WHERE email = 'gus@hdr.test'`, [ana]);
  const link = await rpc('admin:setIdpGroup', { group: ' ops ', role: 'editor', teamId: ana });
  ok('map: linking a team applies at once — members with that group are in it now, a manual member is out',
    link.body?.ok === true && (await teamsOf(pool, 'erin@hdr.test')).includes('Analysts') && (await teamsOf(pool, 'fred@hdr.test')) === 'Analysts'
      && !(await teamsOf(pool, 'gus@hdr.test')).includes('Analysts'), `${JSON.stringify(link)} gus=${await teamsOf(pool, 'gus@hdr.test')}`);
  ok('map: the role it maps applies at once too, stored as trimmed', (await roleOf(pool, 'erin@hdr.test')) === 'editor'
    && (await q(pool, `SELECT 1 FROM idp_groups WHERE org_id = 'hdr' AND group_name = 'ops'`)).length === 1);
  ok('map: Ops, no longer linked by ops, is emptied (unlink clears too)', (await q(pool, 'SELECT 1 FROM team_members WHERE team_id = $1', [ops])).length === 0);
  const badTeam = await rpc('admin:setIdpGroup', { group: 'x', role: null, teamId: crypto.randomUUID() });
  ok('map: a team from nowhere is refused, nothing written', badTeam.body?.ok === false && badTeam.body.error === 'unknown team' && (await q(pool, `SELECT 1 FROM idp_groups WHERE group_name = 'x'`)).length === 0);
  // S-M1: the same mapping again writes nothing and re-applies nobody.
  const xErin = await xmin('erin@hdr.test');
  const auditBefore = (await q(pool, `SELECT 1 FROM audit_log WHERE channel = 'idp:sync'`)).length;
  await rpc('admin:setIdpGroup', { group: 'ops', role: 'editor', teamId: ana });
  ok('S-M1: saving an unchanged mapping re-applies nobody (no member written, no idp:sync row)',
    (await xmin('erin@hdr.test')) === xErin && (await q(pool, `SELECT 1 FROM audit_log WHERE channel = 'idp:sync'`)).length === auditBefore);
  // S-M1: a sync that cannot get the people lock in time answers the member AS STORED and writes nothing.
  idpMod.setSyncTimingForTest({ waitMs: 300, lockMs: 300 });
  const holder = new Client({ connectionString: url });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('people:hdr', 0))`);
    const x2 = await xmin('erin@hdr.test');
    const t0 = performance.now();
    const busyRole = await me('erin@hdr.test', 'misc'); // an unmapped group: synced, she would be a viewer
    const took = performance.now() - t0;
    ok(`S-M1: header mode under a held lock answers the stored role within the lock timeout (${Math.round(took)} ms), nothing written`,
      busyRole === 'editor' && took < 2000 && (await xmin('erin@hdr.test')) === x2, `${busyRole} ${Math.round(took)}`);
    await holder.query('ROLLBACK');
    const freed = await me('erin@hdr.test', 'misc');
    ok('S-M1: …and once the lock is free the next request syncs (misc → viewer)', freed === 'viewer', String(freed));
    await me('erin@hdr.test', 'ops');
  } finally {
    await holder.end();
    idpMod.setSyncTimingForTest(null);
  }

  ok('map: a viewer cannot read or change it (403)', (await rpc('admin:idpGroups', undefined, 'erin@hdr.test')).status === 403
    && (await rpc('admin:setIdpGroup', { group: 'y', role: 'admin', teamId: null }, 'erin@hdr.test')).status === 403);
  await rpc('admin:setIdpGroup', { group: 'admins', role: 'admin', teamId: null });

  // C7: two requests of one person with DIFFERENT groups at once: each runs its own sync, neither joins the other's.
  await me('hank@hdr.test', 'misc');
  let held = 0;
  idpMod.setSyncBarrierForTest(async (email) => {
    if (email !== 'hank@hdr.test' || held++ > 0) return;
    // Hold the first sync until the second one is waiting on the database (it never gets there if it joined).
    for (let i = 0; i < 200; i++) {
      // A row-lock wait is a `transactionid` lock, which names no database.
      if ((await q(pool, `SELECT 1 FROM pg_locks WHERE NOT granted AND locktype IN ('transactionid', 'tuple', 'advisory')`)).length) break;
      await new Promise((r) => setTimeout(r, 10));
    }
  });
  try {
    const [asOps, asAdmins] = await Promise.all([me('hank@hdr.test', 'ops'), me('hank@hdr.test', 'admins')]);
    ok('C7: concurrent requests with different groups each get their own sync (ops → editor, admins → admin)', asOps === 'editor' && asAdmins === 'admin', `${asOps} ${asAdmins}`);
  } finally {
    idpMod.setSyncBarrierForTest(null);
  }

  // ── M3: a kept last admin is evaluated again once the org gains an admin ──
  const lone = `lone-${Date.now()}`;
  await pool.query(`INSERT INTO orgs (id, name) VALUES ($1, $1)`, [lone]);
  const loneAuth = { ...cfg.auth, org: lone, adminEmail: null };
  const mk = async (email: string, role: string) => (await q<{ id: string }>(pool, `INSERT INTO users (org_id, email, role, last_login_at) VALUES ($1, $2, $3, now()) RETURNING id::text`, [lone, email, role]))[0].id;
  await pool.query(`INSERT INTO idp_groups (org_id, group_name, role) VALUES ($1, 'staff', 'viewer'), ($1, 'admins', 'admin')`, [lone]);
  const kim = await mk('kim@hdr.test', 'admin');
  const kept = await idpMod.applyIdpGroups(pool, loneAuth, { userId: kim, email: 'kim@hdr.test' }, ['staff'], { compare: true, log: app.log });
  const keptDigest = (await q<{ d: string }>(pool, 'SELECT idp_groups_digest AS d FROM users WHERE id = $1', [kim]))[0].d;
  ok('last admin: a sync that would demote the org\'s only admin keeps them, marked kept', kept === 'admin' && keptDigest.startsWith('kept:'), keptDigest);
  ok('last admin: audited denied, once', (await q(pool, `SELECT 1 FROM audit_log WHERE org_id = $1 AND channel = 'idp:sync' AND outcome = 'denied'`, [lone])).length === 1);
  const lee = await mk('lee@hdr.test', 'viewer');
  await idpMod.applyIdpGroups(pool, loneAuth, { userId: lee, email: 'lee@hdr.test' }, ['admins'], { compare: true, log: app.log });
  ok('last admin: the org gains an admin → the kept marker is cleared', (await q<{ d: string | null }>(pool, 'SELECT idp_groups_digest AS d FROM users WHERE id = $1', [kim]))[0].d === null);
  ok('last admin: …and the next sync demotes the kept admin', (await idpMod.applyIdpGroups(pool, loneAuth, { userId: kim, email: 'kim@hdr.test' }, ['staff'], { compare: true, log: app.log })) === 'viewer');

  // C2: the org gains an admin through an INVITED admin's first sign-in (admin → admin: no role change).
  const lone2 = `lone2-${Date.now()}`;
  await pool.query(`INSERT INTO orgs (id, name) VALUES ($1, $1)`, [lone2]);
  const auth2 = { ...cfg.auth, org: lone2, adminEmail: null };
  await pool.query(`INSERT INTO idp_groups (org_id, group_name, role) VALUES ($1, 'staff', 'viewer'), ($1, 'admins', 'admin')`, [lone2]);
  const kim2 = (await q<{ id: string }>(pool, `INSERT INTO users (org_id, email, role, last_login_at) VALUES ($1, 'kim@hdr.test', 'admin', now()) RETURNING id::text`, [lone2]))[0].id;
  await idpMod.applyIdpGroups(pool, auth2, { userId: kim2, email: 'kim@hdr.test' }, ['staff'], { compare: true, log: app.log });
  await pool.query(`INSERT INTO users (org_id, email, role) VALUES ($1, 'ivy@hdr.test', 'admin')`, [lone2]); // invited as admin, not signed in
  const ivy = await store.provision(pool, auth2, 'ivy@hdr.test');
  if (typeof ivy !== 'string') await idpMod.applyIdpGroups(pool, auth2, { userId: ivy.userId, email: 'ivy@hdr.test' }, ['admins'], { compare: true, log: app.log });
  ok('C2: an invited admin\'s first sign-in gains the org an admin — the kept admin\'s next sync demotes them',
    (await idpMod.applyIdpGroups(pool, auth2, { userId: kim2, email: 'kim@hdr.test' }, ['staff'], { compare: true, log: app.log })) === 'viewer');

  // C3: one map change that promotes Zed and would demote Kim (the only admin): Kim goes, whatever the order.
  const lone3 = `lone3-${Date.now()}`;
  await pool.query(`INSERT INTO orgs (id, name) VALUES ($1, $1)`, [lone3]);
  const auth3 = { ...cfg.auth, org: lone3, adminEmail: null };
  const member3 = async (email: string, role: string, groups: string[]) =>
    (await q<{ id: string }>(pool, `INSERT INTO users (org_id, email, role, last_login_at, idp_groups, idp_groups_at) VALUES ($1, $2, $3, now(), $4, now()) RETURNING id::text`, [lone3, email, role, groups]))[0].id;
  await member3('kim@hdr.test', 'admin', ['staff']);
  await member3('zed@hdr.test', 'viewer', ['admins']);
  await pool.query(`INSERT INTO idp_groups (org_id, group_name, role) VALUES ($1, 'staff', 'viewer'), ($1, 'admins', 'admin')`, [lone3]);
  await store.withPeopleLock(pool, lone3, 'exclusive', (c) => reapply.reapplyAll(c, auth3, lone3));
  const roles3 = await q<{ email: string; role: string }>(pool, 'SELECT email, role FROM users WHERE org_id = $1 ORDER BY email', [lone3]);
  ok('C3: a map change applies promotions first — Zed is admin, so Kim is demoted, not kept', JSON.stringify(roles3.map((r) => r.role)) === '["viewer","admin"]', JSON.stringify(roles3));

  // S-L3: a map change grants nothing from a STALE group list (older than SESSION_ABSOLUTE_HOURS); it still takes away.
  const lone4 = `lone4-${Date.now()}`;
  await pool.query(`INSERT INTO orgs (id, name) VALUES ($1, $1)`, [lone4]);
  const auth4 = { ...cfg.auth, org: lone4, adminEmail: null };
  const fin = await team(pool, lone4, 'Finance');
  const member4 = async (email: string, role: string, groups: string[], ageHours: number) =>
    (await q<{ id: string }>(pool, `INSERT INTO users (org_id, email, role, last_login_at, idp_groups, idp_groups_at, idp_groups_digest)
      VALUES ($1, $2, $3, now(), $4, now() - $5 * interval '1 hour', 'x') RETURNING id::text`, [lone4, email, role, groups, ageHours]))[0].id;
  const maxAge = cfg.auth.sessionAbsoluteMs / 3_600_000;
  await member4('fresh@hdr.test', 'viewer', ['finance'], 1);
  await member4('stale@hdr.test', 'viewer', ['finance'], maxAge + 1);
  await member4('demote@hdr.test', 'editor', ['other'], maxAge + 1);
  await pool.query(`INSERT INTO idp_groups (org_id, group_name, role, team_id) VALUES ($1, 'finance', 'editor', $2)`, [lone4, fin]);
  await store.withPeopleLock(pool, lone4, 'exclusive', (c) => reapply.reapplyAll(c, auth4, lone4));
  const four = async (email: string) => (await q<{ role: string; d: string | null }>(pool, 'SELECT role, idp_groups_digest AS d FROM users WHERE org_id = $1 AND email = $2', [lone4, email]))[0];
  const teams4 = async (email: string) => (await q(pool, 'SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id WHERE u.org_id = $1 AND u.email = $2', [lone4, email])).length;
  ok('S-L3: a member whose groups were read recently gets the new grant (role and team)', (await four('fresh@hdr.test')).role === 'editor' && (await teams4('fresh@hdr.test')) === 1);
  ok('S-L3: a member whose groups are older than a session gets NO grant from them, and is re-read at their next request',
    (await four('stale@hdr.test')).role === 'viewer' && (await teams4('stale@hdr.test')) === 0 && (await four('stale@hdr.test')).d === null);
  ok('S-L3: a reduction applies to a stale member too (no mapped group → viewer)', (await four('demote@hdr.test')).role === 'viewer');

  // ── g. Three demotions racing: the people lock keeps exactly one admin (a deterministic barrier) ──
  const race = async (lock: boolean): Promise<number> => {
    const org = `race-${lock ? 'on' : 'off'}-${Date.now()}`;
    await pool.query(`INSERT INTO orgs (id, name) VALUES ($1, $1)`, [org]);
    await pool.query(`INSERT INTO idp_groups (org_id, group_name, role) VALUES ($1, 'staff', 'viewer')`, [org]);
    const ids = [];
    for (const n of ['a1', 'a2', 'a3']) ids.push((await q<{ id: string }>(pool, `INSERT INTO users (org_id, email, role, last_login_at) VALUES ($1, $2, 'admin', now()) RETURNING id::text`, [org, `${n}@race.test`]))[0].id);
    const auth = { ...cfg.auth, org, adminEmail: null };
    let arrived = 0;
    const waiting = async () => (await q(pool, `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).length > 0;
    const until = async (cond: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 500 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 10));
    };
    idpMod.setSyncBarrierForTest(async () => {
      arrived++;
      // With the lock: the holder waits until another sync is BLOCKED on it. Without: every sync waits for all three.
      if (lock) await until(waiting);
      else await until(() => arrived >= 3);
    });
    store.setPeopleLockForTest(lock);
    try {
      await Promise.all(ids.map((id, i) => idpMod.applyIdpGroups(pool, auth, { userId: id, email: `a${i + 1}@race.test` }, ['staff'], { compare: true, log: app.log })));
    } finally {
      idpMod.setSyncBarrierForTest(null);
      store.setPeopleLockForTest(true);
    }
    return (await q(pool, `SELECT 1 FROM users WHERE org_id = $1 AND role = 'admin'`, [org])).length;
  };
  const withLock = await race(true);
  ok('race: three admins demoted at once under the people lock leave exactly one admin', withLock === 1, String(withLock));
  const withoutLock = await race(false);
  ok('NEGATIVE CONTROL: without the lock, the same race leaves no admin', withoutLock === 0, String(withoutLock));
  await app.close();
}

// ── The map is refused while groups are not read (dormant) ──
async function dormantPart(url: string, apps: FastifyInstance[]): Promise<void> {
  const app = appMod.buildApp(envMod.parseEnv({ LOG_LEVEL: 'silent', DATABASE_URL: url, AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '127.0.0.1/32', ORDINATE_ORG: 'hdr', ORDINATE_ADMIN_EMAIL: 'root@hdr.test' }), sink);
  apps.push(app);
  await app.ready();
  const r = await app.inject({ method: 'POST', url: '/api/rpc/admin:setIdpGroup', remoteAddress: '127.0.0.1',
    headers: withCsrf({ 'content-type': 'application/json', 'x-forwarded-email': 'root@hdr.test' }), payload: wire.encode({ args: [{ group: 'z', role: 'admin', teamId: null }] }) });
  const body = r.statusCode === 200 ? (wire.decode(r.body) as { ok: boolean; error?: string }) : null;
  ok('map: refused while the server reads no groups (`dormant`); the earlier saves are the control', body?.ok === false && body.error === 'dormant', r.body);
  await app.close();
}

(async () => {
  pure();
  await db();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
