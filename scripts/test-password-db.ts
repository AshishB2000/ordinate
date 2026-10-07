// Self-check for password sign-in (AUTH_MODE=password, the default) — the
// hashing and setup-code helpers in plain Node, then the whole flow against a
// real Postgres through the real app:
//
//   first run   the setup code is printed once in the log and stored only as a
//               sha256; a wrong or expired code is refused; the right one (typed
//               in any case, with or without dashes) creates the first admin and
//               signs them in; setup then closes for good
//   sign-in     wrong password and unknown email are the same refusal (every
//               refusal is 200 { ok: false }: no browser console error); a disabled
//               member is told so only after the right password; ten wrong
//               passwords lock that account (not another); the per-IP sign-in
//               limit covers the password routes; ORDINATE_ADMIN_EMAIL is re-made
//               admin at sign-in
//   temporary   an admin adds a person with a temporary password: until they
//               change it every page is /change-password and every /api/ call
//               but /api/auth/* is 403; changing it ends their other sessions
//   admin       add / reset are org-confined, refuse a short password, your own
//               reset, an address outside ALLOWED_EMAIL_DOMAINS, and any mode
//               but password
//   audit+logs  sign-ins and password changes are audit rows; no password, hash,
//               session id or (outside its one startup line) setup code is ever
//               logged or audited
//
// Needs a Postgres it may CREATE DATABASE on for the second half; without
// DATABASE_URL it prints one skip line after the helper checks.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-password-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { Writable } from 'stream';
import { createHash } from 'crypto';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const ph: typeof import('../src/server/auth/passwordHash') = require('../src/server/auth/passwordHash');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-password-db-'));
const log: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _enc, cb) {
    log.push(...chunk.toString('utf8').split('\n').filter(Boolean));
    cb();
  },
});
/** Every secret the run produced; none may reach a log line or an audit row. */
const secrets = new Set<string>();
const pw = (s: string) => (secrets.add(s), s);

type Inject = Awaited<ReturnType<FastifyInstance['inject']>>;
const sessionOf = (r: Inject) => {
  const c = r.cookies.find((x) => x.name === 'ordinate_session' && x.value);
  if (c) secrets.add(c.value);
  return c?.value;
};

(async () => {
  // ── Helpers, no database ────────────────────────────────────────────────
  const h1 = await ph.hashPassword(pw('correct horse battery'));
  const h2 = await ph.hashPassword('correct horse battery');
  ok('hash: scrypt$N$r$p$salt$hash, never the password', /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(h1) && !h1.includes('correct'), h1);
  ok('hash: salted (the same password hashes differently)', h1 !== h2);
  ok('verify: the right password', await ph.verifyPassword('correct horse battery', h1));
  ok('verify: a wrong one is false', !(await ph.verifyPassword('correct horse battery!', h1)));
  ok('verify: NFC and NFD spellings of one password agree', await ph.verifyPassword('café-au-lait-1', await ph.hashPassword('café-au-lait-1')));
  for (const bad of [null, '', 'plain', 'scrypt$0$8$1$a$b', `scrypt$${2 ** 20}$8$1$a$b`, 'scrypt$1000$8$1$a$b', 'bcrypt$2b$10$x']) {
    ok(`verify: a missing or malformed stored hash (${JSON.stringify(bad)}) is false, not a throw`, !(await ph.verifyPassword('anything-at-all', bad)));
  }
  ok('policy: 9 characters is short, 10 is fine, 257 is long', ph.passwordProblem('123456789') === 'short' && ph.passwordProblem('1234567890') === null && ph.passwordProblem('x'.repeat(257)) === 'long');
  ok('policy: length counts characters, not UTF-16 units (5 emoji is short)', ph.passwordProblem('😀😀😀😀😀') === 'short');
  ok('policy: a non-string is short', ph.passwordProblem(undefined) === 'short' && ph.passwordProblem(12345678901) === 'short');
  const codes = Array.from({ length: 200 }, () => ph.newSetupCode());
  ok('setup code: XXXX-XXXX-XXXX from an alphabet with no 0/O/1/I/L', codes.every((c) => /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(c)), codes.find((c) => !/^[A-HJKMNP-Z2-9-]{14}$/.test(c)));
  ok('setup code: 200 draws, 200 different codes', new Set(codes).size === 200);
  ok('setup code: typed lower-case, spaced or undashed reads as printed', ph.normalSetupCode(' k7qm 2xra-v9td ') === 'K7QM-2XRA-V9TD' && ph.normalSetupCode('K7QM2XRAV9TD') === 'K7QM-2XRA-V9TD');
  ok('setup code: wrong length, a 0 or an O, or a non-string is null', [ph.normalSetupCode('K7QM-2XRA'), ph.normalSetupCode('K7QM-2XRA-V9T0'), ph.normalSetupCode('K7QM-2XRA-V9TO'), ph.normalSetupCode(42)].every((x) => x === null));

  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip password DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_pw_${process.pid}_${Date.now()}`;
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
    const cfg = envMod.parseEnv({
      LOG_LEVEL: 'trace',
      DATA_DIR: DATA,
      DATABASE_URL: scratch.toString(),
      ORDINATE_ORG: 'acme',
      ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
      ALLOWED_EMAIL_DOMAINS: 'acme.test',
      // This suite signs in many times from one address; the limit itself is checked on its own app below.
      RATE_LIMIT_LOGIN_PER_MINUTE: '10000',
    });
    ok('env: AUTH_MODE unset is password sign-in', cfg.auth.mode === 'password');
    const app = appMod.buildApp(cfg, sink);
    apps.push(app);
    await app.ready();

    const text = () => log.join('\n');
    const msgs = () => log.map((l) => (JSON.parse(l) as { msg?: string; level?: number }));
    ok('startup: warns that password sign-in is for trying Ordinate out', msgs().some((m) => m.level === 40 && m.msg?.includes('AUTH_MODE=password') && m.msg.includes('AUTH_MODE=oidc')));
    const codeLines = msgs().filter((m) => m.msg?.startsWith('First-run setup code: '));
    const code = /([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(codeLines[0]?.msg ?? '')?.[1] ?? '';
    ok('startup: one setup code, at warn level (seen at LOG_LEVEL=warn)', codeLines.length === 1 && codeLines[0].level === 40 && code !== '', JSON.stringify(codeLines));
    const stored = await pool.query<{ code_hash: string; org_id: string }>('SELECT code_hash, org_id FROM setup_codes');
    ok('startup: only the code\'s sha256 is stored, for the org', stored.rows.length === 1 && stored.rows[0].org_id === 'acme' &&
      stored.rows[0].code_hash === createHash('sha256').update(code).digest('hex'), JSON.stringify(stored.rows));

    const me = async (sid?: string) =>
      (await app.inject({ method: 'GET', url: '/api/auth/me', headers: sid ? { cookie: `ordinate_session=${sid}` } : {} })).json() as {
        user: { email: string; role: string; mustChangePassword: boolean } | null; mode: string; setup: boolean; canSignOut: boolean;
      };
    const post = (route: string, body: unknown, sid?: string, remoteAddress?: string) =>
      app.inject({
        method: 'POST',
        url: `/api/auth/password/${route}`,
        ...(remoteAddress ? { remoteAddress } : {}),
        headers: withCsrf({ 'content-type': 'application/json', ...(sid ? { cookie: `ordinate_session=${sid}` } : {}) }),
        payload: JSON.stringify(body),
      });
    const rpc = async (sid: string | undefined, channel: string, payload?: unknown) => {
      const r = await app.inject({
        method: 'POST',
        url: `/api/rpc/${channel}`,
        headers: withCsrf({ 'content-type': 'application/json', ...(sid ? { cookie: `ordinate_session=${sid}` } : {}) }),
        payload: wire.encode({ args: payload === undefined ? [] : [payload] }),
      });
      return { status: r.statusCode, body: (r.statusCode === 200 ? wire.decode(r.body) : r.body) as any }; // any: each channel's own reply
    };
    /** A designed refusal: 200 { ok: false, error } (a 4xx would be a browser console error). */
    const refused = (r: Inject, error: string) => r.statusCode === 200 && r.json().ok === false && r.json().error === error;
    const accepted = (r: Inject) => r.statusCode === 200 && r.json().ok === true;
    const page = (url: string, sid?: string) => app.inject({ method: 'GET', url, headers: { accept: 'text/html', ...(sid ? { cookie: `ordinate_session=${sid}` } : {}) } });

    // ── First run ─────────────────────────────────────────────────────────
    const anon = await me();
    ok('me: signed out, mode password, setup open, sessions can be ended', anon.user === null && anon.mode === 'password' && anon.setup === true && anon.canSignOut === true, JSON.stringify(anon));
    ok('gate: signed out → 401 on /api/*, 302 /sign-in for a page', (await rpc(undefined, 'projects:list')).status === 401 && (await page('/data')).headers.location === '/sign-in?next=%2Fdata');
    const BOSS = pw('boss-first-password');
    ok('login: nobody can sign in before setup', refused(await post('login', { email: 'boss@acme.test', password: BOSS }), 'invalid'));
    const wrong = code === 'AAAA-AAAA-AAAA' ? 'BBBB-BBBB-BBBB' : 'AAAA-AAAA-AAAA';
    const s1 = await post('setup', { code: wrong, email: 'boss@acme.test', password: BOSS });
    ok('setup: a wrong code → refused (code), nothing created', refused(s1, 'code') && (await pool.query('SELECT 1 FROM users')).rowCount === 0, s1.body);
    ok('setup: garbage for a code → refused (code)', refused(await post('setup', { code: 'nope', email: 'boss@acme.test', password: BOSS }), 'code'));
    ok('setup: a bad email → refused (invalid-input)', refused(await post('setup', { code, email: 'boss', password: BOSS }), 'invalid-input'));
    ok('setup: an unknown field → refused (strict body)', refused(await post('setup', { code, email: 'boss@acme.test', password: BOSS, role: 'admin' }), 'invalid-input'));
    const short = await post('setup', { code, email: 'boss@acme.test', password: 'short' });
    ok('setup: a short password → refused (password-short)', refused(short, 'password-short'), short.body);
    const dom = await post('setup', { code, email: 'boss@elsewhere.test', password: BOSS });
    ok('setup: an address outside ALLOWED_EMAIL_DOMAINS → refused (domain)', refused(dom, 'domain'), dom.body);
    // An expired code is refused even though it is the right one.
    await pool.query(`UPDATE setup_codes SET expires_at = now() - interval '1 second'`);
    ok('setup: the right code past its expiry → refused (code)', refused(await post('setup', { code, email: 'boss@acme.test', password: BOSS }), 'code'));
    await pool.query(`UPDATE setup_codes SET expires_at = now() + interval '1 hour'`);
    const s2 = await post('setup', { code: code.toLowerCase().replace(/-/g, ' '), email: 'Boss@Acme.test', password: BOSS });
    const boss = sessionOf(s2);
    ok('setup: the right code (lower-case, spaced) → ok and a session cookie', accepted(s2) && !!boss, s2.body);
    const bm = await me(boss);
    ok('setup: …signed in as an admin with their own password', bm.user?.email === 'boss@acme.test' && bm.user.role === 'admin' && bm.user.mustChangePassword === false, JSON.stringify(bm));
    ok('setup: closed — me says so, the codes are gone', (await me()).setup === false && (await pool.query('SELECT 1 FROM setup_codes')).rowCount === 0);
    const again = await post('setup', { code, email: 'mallory@acme.test', password: pw('mallory-password') });
    ok('setup: a second attempt with the same code → refused (closed)', refused(again, 'closed'), again.body);
    const row = (await pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE email = 'boss@acme.test'`)).rows[0];
    secrets.add(row.password_hash);
    ok('store: the row holds a scrypt hash, not the password', row.password_hash.startsWith('scrypt$') && !row.password_hash.includes(BOSS));
    ok('setup: no new code at the next start (an admin has a password)', (await (require('../src/server/auth/passwordStore') as typeof import('../src/server/auth/passwordStore')).issueSetupCode(pool, 'acme')) === null);
    ok('gate: the admin\'s session passes (unknown channel → 404)', (await rpc(boss, 'no:such')).status === 404);

    // ── Sign-in ───────────────────────────────────────────────────────────
    const bad1 = await post('login', { email: 'boss@acme.test', password: 'not-the-password' });
    const bad2 = await post('login', { email: 'nobody@acme.test', password: 'not-the-password' });
    ok('login: wrong password and unknown email are the same refusal (invalid)', refused(bad1, 'invalid') && bad1.body === bad2.body, `${bad1.body} ${bad2.body}`);
    ok('login: no session cookie on a refusal', !sessionOf(bad1) && !sessionOf(bad2));
    const l1 = await post('login', { email: ' BOSS@acme.test ', password: BOSS });
    const boss2 = sessionOf(l1);
    ok('login: the right password (email any case) → ok, a new session', accepted(l1) && l1.json().mustChangePassword === false && !!boss2 && boss2 !== boss, l1.body);
    const rot = await post('login', { email: 'boss@acme.test', password: BOSS }, boss2);
    ok('login: rotation — the session the browser arrived with is ended', (await me(boss2)).user === null && (await me(sessionOf(rot))).user?.email === 'boss@acme.test');
    ok('login: a bad body → refused (invalid-input)', refused(await post('login', { email: 'boss@acme.test' }), 'invalid-input'));

    // ── Admin adds people ─────────────────────────────────────────────────
    const tooShort = await rpc(boss, 'admin:addUser', { email: 'alice@acme.test', role: 'editor', password: 'short' });
    ok('admin:addUser: a short temporary password → ok:false password-short', tooShort.status === 200 && tooShort.body.error === 'password-short', JSON.stringify(tooShort.body));
    ok('admin:addUser: outside ALLOWED_EMAIL_DOMAINS → ok:false domain', (await rpc(boss, 'admin:addUser', { email: 'eve@elsewhere.test', role: 'viewer', password: 'long-enough-1' })).body.error === 'domain');
    const TEMP = pw('alice-temporary-1');
    const added = await rpc(boss, 'admin:addUser', { email: 'Alice@Acme.test', role: 'editor', password: TEMP });
    ok('admin:addUser: → ok with the new id', added.status === 200 && added.body.ok === true && typeof added.body.id === 'string', JSON.stringify(added.body));
    ok('admin:addUser: the same address again → ok:false exists', (await rpc(boss, 'admin:addUser', { email: 'alice@acme.test', role: 'viewer', password: 'long-enough-1' })).body.error === 'exists');
    const list = (await rpc(boss, 'admin:users')).body as { email: string; role: string; mustChangePassword: boolean; pending: boolean }[];
    const alice = list.find((u) => u.email === 'alice@acme.test');
    ok('admin:users: shows her as an editor holding a temporary password, not signed in yet', alice?.role === 'editor' && alice.mustChangePassword === true && alice.pending === true, JSON.stringify(alice));
    ok('admin:addUser: a viewer cannot call it (403, the contract)', await (async () => {
      await rpc(boss, 'admin:addUser', { email: 'vic@acme.test', role: 'viewer', password: pw('vic-temporary-1') });
      const v = sessionOf(await post('login', { email: 'vic@acme.test', password: 'vic-temporary-1' }));
      // vic must change first; after that the contract decides.
      await post('change', { current: 'vic-temporary-1', password: pw('vic-own-password') }, v);
      return (await rpc(v, 'admin:addUser', { email: 'x@acme.test', role: 'admin', password: 'long-enough-1' })).status === 403;
    })());

    // ── A temporary password ──────────────────────────────────────────────
    const la = await post('login', { email: 'alice@acme.test', password: TEMP });
    const a1 = sessionOf(la);
    ok('temporary: sign-in → ok with mustChangePassword', accepted(la) && la.json().mustChangePassword === true, la.body);
    ok('temporary: me says so', (await me(a1)).user?.mustChangePassword === true);
    const held = await rpc(a1, 'projects:list');
    ok('temporary: every RPC → 403 password change required', held.status === 403 && String(held.body).includes('password change required'), `${held.status} ${held.body}`);
    ok('temporary: the event stream too', (await app.inject({ method: 'GET', url: '/api/events?client=6f1c2b7e-0d4a-4c1e-9a55-3b2f8e1d9c00', headers: { cookie: `ordinate_session=${a1}` } })).statusCode === 403);
    const p1 = await page('/data?tab=2', a1);
    ok('temporary: a page → 302 /change-password, keeping where it was going', p1.statusCode === 302 && p1.headers.location === '/change-password?next=%2Fdata%3Ftab%3D2', `${p1.statusCode} ${p1.headers.location}`);
    ok('temporary: / → 302 /change-password', (await page('/', a1)).headers.location === '/change-password');
    ok('temporary: /change-password itself is not redirected', (await page('/change-password', a1)).statusCode !== 302);
    const a2 = sessionOf(await post('login', { email: 'alice@acme.test', password: TEMP })); // a second device
    const c1 = await post('change', { current: 'not-the-temp', password: pw('alice-own-password') }, a1);
    ok('change: a wrong current password → refused (current)', refused(c1, 'current'), c1.body);
    ok('change: the same password again → refused (same)', refused(await post('change', { current: TEMP, password: TEMP }, a1), 'same'));
    ok('change: a short one → refused (password-short)', refused(await post('change', { current: TEMP, password: 'short' }, a1), 'password-short'));
    ok('change: signed out → refused (signed-out)', refused(await post('change', { current: TEMP, password: 'alice-own-password' }), 'signed-out'));
    const OWN = 'alice-own-password';
    const c2 = await post('change', { current: TEMP, password: OWN }, a1);
    ok('change: → ok', accepted(c2), c2.body);
    ok('change: this browser stays signed in, the hold is lifted (negative control)', (await me(a1)).user?.mustChangePassword === false && (await rpc(a1, 'projects:list')).status === 200);
    ok('change: the other device was signed out', (await me(a2)).user === null);
    ok('change: the temporary password no longer works, the new one does', refused(await post('login', { email: 'alice@acme.test', password: TEMP }), 'invalid') &&
      accepted(await post('login', { email: 'alice@acme.test', password: OWN })));

    // ── Reset, disable, org confinement ───────────────────────────────────
    const aliceId = added.body.id as string;
    const bossId = (await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = 'boss@acme.test'`)).rows[0].id;
    ok('admin:resetPassword: your own → ok:false self-password', (await rpc(boss, 'admin:resetPassword', { userId: bossId, password: 'long-enough-1' })).body.error === 'self-password');
    ok('admin:resetPassword: a short one → ok:false password-short', (await rpc(boss, 'admin:resetPassword', { userId: aliceId, password: 'short' })).body.error === 'password-short');
    const a3 = sessionOf(await post('login', { email: 'alice@acme.test', password: OWN }));
    const RESET = pw('alice-reset-temp-1');
    ok('admin:resetPassword: → ok', (await rpc(boss, 'admin:resetPassword', { userId: aliceId, password: RESET })).body.ok === true);
    ok('admin:resetPassword: she is signed out everywhere', (await me(a3)).user === null && (await me(a1)).user === null);
    const lr = await post('login', { email: 'alice@acme.test', password: RESET });
    ok('admin:resetPassword: the new one is temporary again', accepted(lr) && lr.json().mustChangePassword === true, lr.body);
    await pool.query(`INSERT INTO orgs (id, name) VALUES ('beta', 'beta') ON CONFLICT DO NOTHING`);
    const betaId = (await pool.query<{ id: string }>(`INSERT INTO users (org_id, email, role) VALUES ('beta', 'carl@beta.test', 'viewer') RETURNING id`)).rows[0].id;
    ok('admin:resetPassword: another org\'s member → ok:false unknown, untouched', (await rpc(boss, 'admin:resetPassword', { userId: betaId, password: 'long-enough-1' })).body.error === 'unknown' &&
      (await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [betaId])).rows[0].password_hash === null);
    await rpc(boss, 'admin:setDisabled', { userId: aliceId, disabled: true });
    const dis = await post('login', { email: 'alice@acme.test', password: RESET });
    ok('disabled: the right password → refused (disabled), no session', refused(dis, 'disabled') && !sessionOf(dis), dis.body);
    ok('disabled: a wrong one → refused (invalid): says nothing about the account', refused(await post('login', { email: 'alice@acme.test', password: 'wrong-password' }), 'invalid'));

    // ── ORDINATE_ADMIN_EMAIL, lockout, the per-IP limit ───────────────────
    await pool.query(`UPDATE users SET role = 'viewer' WHERE email = 'boss@acme.test'`);
    ok('ORDINATE_ADMIN_EMAIL: is made admin again at sign-in', (await me(sessionOf(await post('login', { email: 'boss@acme.test', password: BOSS })))).user?.role === 'admin');
    await rpc(boss, 'admin:addUser', { email: 'lou@acme.test', role: 'viewer', password: pw('lou-temporary-1') });
    for (let i = 0; i < 10; i++) await post('login', { email: 'lou@acme.test', password: `wrong-${i}-password` });
    const locked = await post('login', { email: 'lou@acme.test', password: 'lou-temporary-1' });
    ok('lockout: after 10 wrong passwords even the right one → refused (locked), with Retry-After', refused(locked, 'locked') && locked.json().retryAfter > 0 && Number(locked.headers['retry-after']) > 0, locked.body);
    ok('lockout: another account is not locked (negative control)', accepted(await post('login', { email: 'boss@acme.test', password: BOSS })));

    const limited = appMod.buildApp(envMod.parseEnv({
      LOG_LEVEL: 'trace', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), ORDINATE_ORG: 'acme', RATE_LIMIT_LOGIN_PER_MINUTE: '3',
    }), sink);
    apps.push(limited);
    await limited.ready();
    const tries: number[] = [];
    for (let i = 0; i < 4; i++) {
      tries.push((await limited.inject({ method: 'POST', url: '/api/auth/password/login', remoteAddress: '198.51.100.7',
        headers: withCsrf({ 'content-type': 'application/json' }), payload: JSON.stringify({ email: 'boss@acme.test', password: BOSS }) })).statusCode);
    }
    ok('rate limit: RATE_LIMIT_LOGIN_PER_MINUTE covers the password routes (4th try → 429)', tries.join() === '200,200,200,429', tries.join());

    // ── After a move to SSO a leftover temporary password holds nobody ─────
    const store: typeof import('../src/server/auth/store') = require('../src/server/auth/store');
    const ocfg = envMod.parseEnv({
      LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString(), ORDINATE_ORG: 'acme', AUTH_MODE: 'oidc',
      OIDC_ISSUER: 'http://127.0.0.1:1', OIDC_CLIENT_ID: 'x', OIDC_CLIENT_SECRET: 'x', OIDC_REDIRECT_URL: 'http://127.0.0.1:1/api/auth/callback',
    });
    const oidcApp = appMod.buildApp(ocfg);
    apps.push(oidcApp);
    await oidcApp.ready();
    await rpc(boss, 'admin:setDisabled', { userId: aliceId, disabled: false });
    ok('sso: precondition — alice still holds a temporary password', (await pool.query(`SELECT must_change_password AS m FROM users WHERE id = $1`, [aliceId])).rows[0].m === true);
    const sso = await store.createSession(pool, ocfg.auth, aliceId);
    secrets.add(sso);
    const ssoMe = (await oidcApp.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `ordinate_session=${sso}` } })).json() as { user: { mustChangePassword: boolean } | null };
    const ssoRpc = await oidcApp.inject({ method: 'POST', url: '/api/rpc/no:such', headers: withCsrf({ cookie: `ordinate_session=${sso}`, 'content-type': 'application/json' }), payload: wire.encode({ args: [] }) });
    ok('sso: under oidc the flag holds nothing (me says so, RPC passes the gate)', ssoMe.user?.mustChangePassword === false && ssoRpc.statusCode === 404, `${JSON.stringify(ssoMe)} ${ssoRpc.statusCode}`);

    // ── Mode guard ────────────────────────────────────────────────────────
    const dev = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: scratch.toString() }));
    apps.push(dev);
    await dev.ready();
    const devAdd = await dev.inject({ method: 'POST', url: '/api/rpc/admin:addUser', headers: withCsrf({ 'content-type': 'application/json' }),
      payload: wire.encode({ args: [{ email: 'z@acme.test', role: 'viewer', password: 'long-enough-1' }] }) });
    ok('mode: admin:addUser outside password sign-in → ok:false mode', devAdd.statusCode === 200 && (wire.decode(devAdd.body) as { error?: string }).error === 'mode', devAdd.body);
    ok('mode: no password routes outside password sign-in (404)', (await dev.inject({ method: 'POST', url: '/api/auth/password/login', headers: withCsrf({ 'content-type': 'application/json' }), payload: '{}' })).statusCode === 404);

    // ── Audit and logs ────────────────────────────────────────────────────
    const audit = (await pool.query<{ actor: string | null; action: string; outcome: string; channel: string | null }>('SELECT actor, action, outcome, channel FROM audit_log ORDER BY id')).rows;
    const has = (action: string, outcome: string, actor?: string) => audit.some((r) => r.action === action && r.outcome === outcome && (actor === undefined || r.actor === actor));
    ok('audit: setup and sign-ins are login rows (ok and denied)', has('login', 'ok', 'boss@acme.test') && has('login', 'denied', 'boss@acme.test') && has('login', 'ok', 'alice@acme.test'));
    ok('audit: a refused unknown email is recorded without an actor', has('login', 'denied') && audit.some((r) => r.action === 'login' && r.outcome === 'denied' && r.actor === null));
    ok('audit: password changes, ok and denied', has('password_change', 'ok', 'alice@acme.test') && has('password_change', 'denied', 'alice@acme.test'));
    ok('audit: admin:addUser and admin:resetPassword are rpc rows', audit.some((r) => r.channel === 'admin:addUser') && audit.some((r) => r.channel === 'admin:resetPassword'));
    const auditText = JSON.stringify((await pool.query('SELECT * FROM audit_log')).rows);
    const hashes = (await pool.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE password_hash IS NOT NULL')).rows.map((r) => r.password_hash);
    for (const h of hashes) secrets.add(h);
    const all = text();
    ok('logs: the setup code appears only in its one startup line', all.split(code).length - 1 === 1, all.split(code).length - 1);
    const leakedLog = [...secrets].filter((s) => all.includes(s));
    ok(`logs: none of ${secrets.size} passwords, hashes or session ids appear`, leakedLog.length === 0, leakedLog.map((s) => s.slice(0, 6) + '…').join(' '));
    const leakedAudit = [...secrets, code].filter((s) => auditText.includes(s));
    ok('audit: no password, hash, session id or setup code in any row', leakedAudit.length === 0, leakedAudit.map((s) => s.slice(0, 6) + '…').join(' '));
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
