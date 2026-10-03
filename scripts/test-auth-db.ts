// Self-check for sign-in against a real Postgres (T3.2): the OIDC code flow
// end to end through the REAL openid-client against scripts/mockOidc.ts (no
// browser — web/e2e/auth.e2e.ts drives one), sessions (rotation on login,
// idle and absolute expiry, logout, logout-everywhere, disabled users), the
// bootstrap admin and the domain allowlist, header mode trusting
// X-Forwarded-Email only from a trusted peer (IPv4 and IPv6, injected AND over
// real sockets), and — over every log line all of that produced — that no
// session id, code, token, client secret or cookie value was ever logged.
//
// Needs a Postgres it may CREATE DATABASE on; without DATABASE_URL it prints
// one skip line. Every run makes its own scratch database and drops it.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-auth-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Writable } from 'stream';
import { Client, Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { startMockOidc, type MockOidc } from './mockOidc';

const envMod: typeof import('../src/server/env') = require('../src/server/env');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const store: typeof import('../src/server/auth/store') = require('../src/server/auth/store');

const SECRET = 'oidc-cl1ent-s3cret-canary';
const REDIRECT = 'http://127.0.0.1:1/api/auth/callback';
const log: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _enc, cb) {
    log.push(...chunk.toString('utf8').split('\n').filter(Boolean));
    cb();
  },
});
/** Every secret value the run produced; none may appear in `log`. */
const secrets = new Set<string>([SECRET]);

type Inject = Awaited<ReturnType<FastifyInstance['inject']>>;
const cookieOf = (r: Inject, name: string) => r.cookies.find((c) => c.name === name);

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip auth DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const dbName = `ordinate_t32_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  const apps: FastifyInstance[] = [];
  let mock: MockOidc | null = null;
  try {
    mock = await startMockOidc({ clientId: 'ordinate-test', clientSecret: SECRET });
    const idp = mock;
    const cfg = envMod.parseEnv({
      LOG_LEVEL: 'trace',
      DATABASE_URL: scratch.toString(),
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: 'ordinate-test',
      OIDC_CLIENT_SECRET: SECRET,
      OIDC_REDIRECT_URL: REDIRECT,
      ORDINATE_ORG: 'acme',
      ORDINATE_ADMIN_EMAIL: 'boss@acme.test',
      ALLOWED_EMAIL_DOMAINS: 'acme.test',
      SESSION_IDLE_MINUTES: '60',
      SESSION_ABSOLUTE_HOURS: '24',
    });
    const app = appMod.buildApp(cfg, sink);
    apps.push(app);
    await app.ready();
    const tables = await pool.query<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`);
    ok('schema: 0003 created orgs, users, teams, team_members, sessions, api_tokens',
      ['api_tokens', 'orgs', 'sessions', 'team_members', 'teams', 'users'].every((t) => tables.rows.some((r) => r.t === t)), JSON.stringify(tables.rows));
    ok('startup: the configured org exists', (await pool.query(`SELECT 1 FROM orgs WHERE id = 'acme'`)).rowCount === 1);

    const me = async (id: string | undefined) => {
      const r = await app.inject({ method: 'GET', url: '/api/auth/me', headers: id ? { cookie: `ordinate_session=${id}` } : {} });
      return r.json() as { user: { email: string; role: string } | null; org: string | null; mode: string };
    };
    const gate = async (id: string | undefined) =>
      (await app.inject({ method: 'POST', url: '/api/rpc/no:such', headers: id ? { cookie: `ordinate_session=${id}` } : {} })).statusCode;

    /** The whole browser dance, minus the browser: login → IdP → callback. */
    const signIn = async (email: string, o: { cookie?: string; next?: string; decision?: 'allow' | 'deny'; tamper?: boolean; noTx?: boolean } = {}) => {
      const login = await app.inject({ method: 'GET', url: '/api/auth/login' + (o.next ? `?next=${encodeURIComponent(o.next)}` : '') });
      const tx = cookieOf(login, 'ordinate_login');
      if (tx) secrets.add(tx.value);
      const back = new URL(await idp.approve(String(login.headers.location), email, o.decision));
      if (o.tamper) back.searchParams.set('state', 'forged-state');
      const cookie = [!o.noTx && tx ? `ordinate_login=${tx.value}` : '', o.cookie ? `ordinate_session=${o.cookie}` : ''].filter(Boolean).join('; ');
      const cb = await app.inject({ method: 'GET', url: back.pathname + back.search, headers: cookie ? { cookie } : {} });
      const sess = cb.cookies.find((c) => c.name === 'ordinate_session' && c.value);
      if (sess) secrets.add(sess.value);
      return { login, tx, cb, sess, id: sess?.value, to: String(cb.headers.location) };
    };

    // ── Unauthenticated ────────────────────────────────────────────────────
    ok('gate: no cookie → 401 on /api/*', (await gate(undefined)) === 401);
    // T0.5's event stream and T0.4's file routes sit behind the same gate.
    const evNoAuth = await app.inject({ method: 'GET', url: '/api/events?client=6f1c2b7e-0d4a-4c1e-9a55-3b2f8e1d9c00' });
    ok('gate: GET /api/events signed out → 401', evNoAuth.statusCode === 401, evNoAuth.statusCode);
    const upNoAuth = await app.inject({ method: 'POST', url: '/api/files', headers: { 'content-type': 'multipart/form-data; boundary=x' }, payload: '--x--\r\n' });
    ok('gate: POST /api/files signed out → 401', upNoAuth.statusCode === 401, upNoAuth.statusCode);
    ok('gate: GET /api/files/<token> signed out → 401', (await app.inject({ method: 'GET', url: '/api/files/abc' })).statusCode === 401);
    const anon = await me(undefined);
    ok('me: signed out is 200 with user null (no console error on the sign-in page)', anon.user === null && anon.mode === 'oidc', JSON.stringify(anon));

    // ── OIDC sign-in ───────────────────────────────────────────────────────
    const a1 = await signIn('Alice@Acme.test', { next: '/data' });
    ok('login: 302 to the IdP with PKCE S256, state and nonce', a1.login.statusCode === 302 &&
      ['code_challenge', 'state', 'nonce'].every((k) => new URL(String(a1.login.headers.location)).searchParams.get(k)) &&
      new URL(String(a1.login.headers.location)).searchParams.get('code_challenge_method') === 'S256', String(a1.login.headers.location));
    ok('login: the login cookie is httpOnly, SameSite=Lax, scoped to the callback, 10 min',
      a1.tx?.httpOnly === true && a1.tx.sameSite === 'Lax' && a1.tx.path === '/api/auth/callback' && a1.tx.maxAge === 600, JSON.stringify(a1.tx));
    ok('callback: 302 to the requested page', a1.cb.statusCode === 302 && a1.to === '/data', `${a1.cb.statusCode} ${a1.to}`);
    ok('callback: session cookie httpOnly, SameSite=Lax, Path=/, Max-Age = absolute lifetime, not Secure in dev',
      a1.sess?.httpOnly === true && a1.sess.sameSite === 'Lax' && a1.sess.path === '/' && a1.sess.maxAge === 86_400 && !a1.sess.secure, JSON.stringify(a1.sess));
    ok('callback: session id is 256 bits (43 base64url chars)', /^[A-Za-z0-9_-]{43}$/.test(a1.id ?? ''), a1.id);
    ok('callback: the login cookie is cleared', cookieOf(a1.cb, 'ordinate_login')?.value === '');
    const m1 = await me(a1.id);
    ok('me: the signed-in user, lower-cased, auto-provisioned as viewer in the env org', m1.user?.email === 'alice@acme.test' && m1.user.role === 'viewer' && m1.org === 'acme', JSON.stringify(m1));
    ok('gate: with the session cookie the request passes (404 unknown channel, not 401)', (await gate(a1.id)) === 404);
    const stored = await pool.query<{ id_hash: string }>('SELECT id_hash FROM sessions');
    ok('sessions: only the sha256 is stored, never the id', stored.rows.length === 1 && stored.rows[0].id_hash === store.hashId(a1.id ?? '') && !stored.rows.some((r) => r.id_hash === a1.id));

    // ── Page navigations: a signed-out browser is sent to /sign-in first ──
    const nav = (url: string, id?: string) =>
      app.inject({ method: 'GET', url, headers: { accept: 'text/html,*/*', ...(id ? { cookie: `ordinate_session=${id}` } : {}) } });
    const n1 = await nav('/');
    ok('pages: signed-out GET / → 302 /sign-in', n1.statusCode === 302 && n1.headers.location === '/sign-in', `${n1.statusCode} ${n1.headers.location}`);
    const n2 = await nav('/data?tab=2');
    ok('pages: a deep link keeps where it was going', n2.headers.location === '/sign-in?next=%2Fdata%3Ftab%3D2', String(n2.headers.location));
    ok('pages: signed in, the app is served (no redirect)', (await nav('/data', a1.id)).statusCode !== 302);
    const unredirected = await Promise.all(['/sign-in', '/healthz', '/favicon.svg', '/assets/x.js'].map(async (u) => (await nav(u)).statusCode));
    ok('pages: /sign-in, probes and files are never redirected', unredirected.every((c) => c !== 302), JSON.stringify(unredirected));

    const boss = await signIn('boss@acme.test');
    ok('bootstrap: ORDINATE_ADMIN_EMAIL is org admin on first sign-in', (await me(boss.id)).user?.role === 'admin');
    await pool.query(`UPDATE users SET role = 'viewer' WHERE email = 'boss@acme.test'`);
    const boss2 = await signIn('boss@acme.test');
    ok('bootstrap: …and is made admin again at the next sign-in (recovery path)', (await me(boss2.id)).user?.role === 'admin');
    ok('provision: one user row per email, however many sign-ins', (await pool.query(`SELECT 1 FROM users WHERE email = 'boss@acme.test'`)).rowCount === 1);

    // ── Rotation (no fixation) ─────────────────────────────────────────────
    const a2 = await signIn('alice@acme.test', { cookie: a1.id });
    ok('rotation: signing in again issues a NEW id', !!a2.id && a2.id !== a1.id);
    ok('rotation: the id the browser arrived with is dead', (await me(a1.id)).user === null && (await me(a2.id)).user?.email === 'alice@acme.test');
    const planted = 'P'.repeat(43);
    secrets.add(planted);
    const a3 = await signIn('alice@acme.test', { cookie: planted });
    ok('fixation: a planted id is never the one that gets signed in', a3.id !== planted && (await me(planted)).user === null && (await me(a3.id)).user !== null);

    // ── Idle and absolute expiry (DB clock) ────────────────────────────────
    const setRow = (id: string | undefined, sql: string) => pool.query(`UPDATE sessions SET ${sql} WHERE id_hash = $1`, [store.hashId(id ?? '')]);
    await setRow(a3.id, `last_seen_at = now() - interval '59 minutes'`);
    ok('idle: 59 min quiet (limit 60) is still signed in', (await me(a3.id)).user !== null);
    const slid = await pool.query<{ s: number }>('SELECT extract(epoch FROM now() - last_seen_at) AS s FROM sessions WHERE id_hash = $1', [store.hashId(a3.id ?? '')]);
    ok('idle: …and that request slid the idle window', Number(slid.rows[0]?.s) < 5, JSON.stringify(slid.rows));
    await setRow(a3.id, `last_seen_at = now() - interval '61 minutes'`);
    ok('idle: 61 min quiet → signed out', (await me(a3.id)).user === null && (await gate(a3.id)) === 401);
    const a4 = await signIn('alice@acme.test');
    await setRow(a4.id, `expires_at = now() - interval '1 second'`);
    ok('absolute: past expires_at → signed out, however recently used', (await me(a4.id)).user === null);
    const exp = await signIn('alice@acme.test');
    const life = await pool.query<{ h: number }>('SELECT extract(epoch FROM expires_at - created_at) / 3600 AS h FROM sessions WHERE id_hash = $1', [store.hashId(exp.id ?? '')]);
    ok('absolute: expires_at is created_at + SESSION_ABSOLUTE_HOURS', Math.abs(Number(life.rows[0]?.h) - 24) < 0.01, JSON.stringify(life.rows));
    ok('sweep: sign-in deleted the dead sessions', (await pool.query('SELECT 1 FROM sessions WHERE id_hash = ANY($1)', [[a3.id, a4.id].map((x) => store.hashId(x ?? ''))])).rowCount === 0);

    // ── Logout and logout-everywhere ───────────────────────────────────────
    const out = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: `ordinate_session=${exp.id}` } });
    const cleared = cookieOf(out, 'ordinate_session');
    ok('logout: 204 and the cookie is cleared', out.statusCode === 204 && cleared?.value === '' && (cleared.expires?.getTime() ?? 1) <= Date.now(), JSON.stringify(cleared));
    ok('logout: the row is deleted, the id is dead', (await me(exp.id)).user === null &&
      (await pool.query('SELECT 1 FROM sessions WHERE id_hash = $1', [store.hashId(exp.id ?? '')])).rowCount === 0);
    const laptop = await signIn('alice@acme.test');
    const phone = await signIn('alice@acme.test');
    const bob = await signIn('bob@acme.test');
    const all = await app.inject({ method: 'POST', url: '/api/auth/logout-everywhere', headers: { cookie: `ordinate_session=${laptop.id}` } });
    ok('logout-everywhere: ends every session of that user', all.statusCode === 200 && (all.json() as { ended: number }).ended >= 2, all.body);
    ok('logout-everywhere: laptop and phone are both signed out', (await me(laptop.id)).user === null && (await me(phone.id)).user === null);
    ok('logout-everywhere: another user is untouched', (await me(bob.id)).user?.email === 'bob@acme.test');
    ok('logout-everywhere: signed out → 401', (await app.inject({ method: 'POST', url: '/api/auth/logout-everywhere' })).statusCode === 401);

    // ── Refusals ───────────────────────────────────────────────────────────
    await pool.query(`UPDATE users SET disabled_at = now() WHERE email = 'bob@acme.test'`);
    ok('disabled: a live session of a disabled user stops working', (await me(bob.id)).user === null);
    const bobAgain = await signIn('bob@acme.test');
    ok('disabled: sign-in is refused → /sign-in?error=disabled, no session', bobAgain.to === '/sign-in?error=disabled' && !bobAgain.id, bobAgain.to);
    const eve = await signIn('eve@elsewhere.test');
    ok('domain: an address outside ALLOWED_EMAIL_DOMAINS → error=domain', eve.to === '/sign-in?error=domain' && !eve.id, eve.to);
    ok('domain: …and no user row was written', (await pool.query(`SELECT 1 FROM users WHERE email LIKE 'eve@%'`)).rowCount === 0);
    idp.extraClaims = { email_verified: false };
    const unv = await signIn('carol@acme.test');
    idp.extraClaims = {};
    ok('email_verified=false → error=email', unv.to === '/sign-in?error=email' && !unv.id, unv.to);
    const denied = await signIn('carol@acme.test', { decision: 'deny' });
    ok('IdP denial → error=denied', denied.to === '/sign-in?error=denied' && !denied.id, denied.to);
    const forged = await signIn('carol@acme.test', { tamper: true });
    ok('forged state → error=failed, no session', forged.to === '/sign-in?error=failed' && !forged.id, forged.to);
    const noTx = await signIn('carol@acme.test', { noTx: true });
    ok('callback without the login cookie (other browser, >10 min) → error=expired', noTx.to === '/sign-in?error=expired' && !noTx.id, noTx.to);
    const evil = await signIn('carol@acme.test', { next: '//evil.example/x' });
    ok('open redirect: next=//evil.example lands on /', evil.to === '/' && !!evil.id, evil.to);
    ok('carol was provisioned only by the successful sign-in', (await pool.query(`SELECT 1 FROM users WHERE email = 'carol@acme.test'`)).rowCount === 1);

    // ── Audit trail (T3.3): sign-ins and sign-outs, with ids only ─────────
    const trail = await pool.query<{ action: string; actor: string | null; outcome: string; j: string }>(
      `SELECT action, actor, outcome, row_to_json(a)::text AS j FROM audit_log a ORDER BY id`);
    const has = (action: string, actor: string | null, outcome: string) =>
      trail.rows.some((r) => r.action === action && r.actor === actor && r.outcome === outcome);
    ok('audit: a successful sign-in is a login/ok row for that member', has('login', 'alice@acme.test', 'ok'), JSON.stringify(trail.rows.map((r) => [r.action, r.actor, r.outcome])));
    ok('audit: refused sign-ins are login/denied (disabled, domain, unverified → no actor)',
      has('login', 'bob@acme.test', 'denied') && has('login', 'eve@elsewhere.test', 'denied') && has('login', null, 'denied'));
    ok('audit: logout and logout-everywhere name who signed out', trail.rows.some((r) => r.action === 'logout' && !!r.actor) && has('logout_everywhere', 'alice@acme.test', 'ok'));
    const trailText = trail.rows.map((r) => r.j).join('\n');
    ok('audit: no session id, cookie, code or token in any row', [...secrets, ...idp.issued].every((s) => !s || !trailText.includes(s)));

    // ── Header mode ────────────────────────────────────────────────────────
    const hcfg = (cidrs: string) => envMod.parseEnv({ LOG_LEVEL: 'trace', DATABASE_URL: scratch.toString(), AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: cidrs, ORDINATE_ORG: 'acme' });
    const happ = appMod.buildApp(hcfg('10.0.0.0/8, fd00::/8'), sink);
    apps.push(happ);
    await happ.ready();
    const hreq = async (remoteAddress: string, headers: Record<string, string>, url = '/api/rpc/no:such') =>
      happ.inject({ method: url.includes('rpc') ? 'POST' : 'GET', url, remoteAddress, headers });
    const spoof = { 'x-forwarded-email': 'mallory@acme.test' };
    ok('header v4: spoofed X-Forwarded-Email from an untrusted peer → 401', (await hreq('203.0.113.9', spoof)).statusCode === 401);
    ok('header v4: …even claiming a trusted X-Forwarded-For / X-Real-IP', (await hreq('203.0.113.9', { ...spoof, 'x-forwarded-for': '10.0.0.1', 'x-real-ip': '10.0.0.1' })).statusCode === 401);
    ok('header v6: spoofed header from an untrusted v6 peer → 401', (await hreq('2001:db8::1', spoof)).statusCode === 401);
    ok('header v4-mapped: an untrusted IPv4 peer on a dual-stack socket → 401', (await hreq('::ffff:203.0.113.9', spoof)).statusCode === 401);
    ok('header: nothing was provisioned for the spoofed address', (await pool.query(`SELECT 1 FROM users WHERE email = 'mallory@acme.test'`)).rowCount === 0);
    const dana = { 'x-forwarded-email': 'Dana@Acme.test' };
    ok('header v4: trusted proxy 10.1.2.3 → passes the gate', (await hreq('10.1.2.3', dana)).statusCode === 404);
    ok('header v6: trusted proxy fd00::7 → passes the gate', (await hreq('fd00::7', dana)).statusCode === 404);
    ok('header v4-mapped: ::ffff:10.1.2.3 → passes the gate', (await hreq('::ffff:10.1.2.3', dana)).statusCode === 404);
    const hm = (await hreq('fd00::7', dana, '/api/auth/me')).json() as { user: { email: string; role: string } | null; mode: string };
    ok('header: me is the asserted user, auto-provisioned as viewer', hm.user?.email === 'dana@acme.test' && hm.user.role === 'viewer' && hm.mode === 'header', JSON.stringify(hm));
    ok('header: trusted peer without the header → 401', (await hreq('10.1.2.3', {})).statusCode === 401);
    ok('header: a disabled user is refused even from the proxy', await (async () => {
      await pool.query(`UPDATE users SET disabled_at = now() WHERE email = 'dana@acme.test'`);
      return (await hreq('10.1.2.3', dana)).statusCode === 401;
    })());

    // Real sockets: the peer address is what the kernel says, not a header.
    for (const [cidr, okHost, badHost] of [['127.0.0.1/32', '127.0.0.1', '[::1]'], ['::1/128', '[::1]', '127.0.0.1']] as const) {
      const sapp = appMod.buildApp(hcfg(cidr), sink);
      apps.push(sapp);
      await sapp.listen({ port: 0, host: '::' });
      const port = (sapp.server.address() as import('net').AddressInfo).port;
      const call = async (host: string) => (await fetch(`http://${host}:${port}/api/rpc/no:such`, { method: 'POST', headers: { 'x-forwarded-email': 'erin@acme.test', 'x-forwarded-for': okHost.replace(/[[\]]/g, '') } })).status;
      ok(`socket: TRUSTED_PROXY_CIDRS=${cidr} accepts a real connection from ${okHost}`, (await call(okHost)) === 404);
      ok(`socket: …and rejects one from ${badHost}, whatever X-Forwarded-For says`, (await call(badHost)) === 401);
    }

    // ── Nothing secret in any log line ─────────────────────────────────────
    for (const v of idp.issued) secrets.add(v);
    const text = log.join('\n');
    ok('logs: captured at trace level from every app above', log.length > 50 && text.includes('"signed in"'), log.length);
    ok('logs: the callback is logged by path only, without ?code&state', text.includes('"url":"/api/auth/callback"') && !/callback\?/.test(text));
    const leaked = [...secrets].filter((s) => s && text.includes(s));
    ok(`logs: none of ${secrets.size} session ids, cookie values, codes, tokens or the client secret appear`, leaked.length === 0, leaked.map((s) => s.slice(0, 8) + '…').join(' '));
  } finally {
    for (const a of apps) await a.close().catch(() => undefined);
    await mock?.close();
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
