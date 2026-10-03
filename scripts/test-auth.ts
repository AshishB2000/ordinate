// Self-check for sign-in configuration and the pure parts of src/server/auth/
// (T3.2) — no Postgres needed: AUTH_MODE and its variables, the prod gate on
// dev sign-in (in process AND as a real `node src/server/main.js` refusing to
// start), proxy trust by CIDR for IPv4, IPv6 and IPv4-mapped peers, the cookie
// flags, and the post-sign-in redirect guard. The DB-backed flows (sessions,
// OIDC, header mode over HTTP) are scripts/test-auth-db.ts.
//
//   npm run build:ts && node scripts/test-auth.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { spawnSync } from 'child_process';
import * as path from 'path';

const envMod: typeof import('../src/server/env') = require('../src/server/env');
const context: typeof import('../src/server/context') = require('../src/server/context');
const auth: typeof import('../src/server/auth/index') = require('../src/server/auth/index');
const cookies: typeof import('../src/server/auth/cookies') = require('../src/server/auth/cookies');

const MAIN = path.join(__dirname, '..', 'src', 'server', 'main.js');
const DB = 'postgres://u@localhost/db';
const SECRET = 'cl1ent-s3cret-canary';
const OIDC = {
  AUTH_MODE: 'oidc',
  DATABASE_URL: DB,
  OIDC_ISSUER: 'https://idp.example.com',
  OIDC_CLIENT_ID: 'ordinate',
  OIDC_CLIENT_SECRET: SECRET,
  OIDC_REDIRECT_URL: 'https://bi.example.com/api/auth/callback',
};

function envFails(label: string, src: Record<string, string>, needle: string): void {
  try {
    envMod.parseEnv(src);
    ok(`env: ${label} is rejected`, false);
  } catch (err) {
    const e = err as Error;
    ok(`env: ${label} is rejected, naming ${needle}`, e.name === 'EnvError' && e.message.includes(needle), e.message);
    ok(`env: ${label}: the client secret is never echoed`, !e.message.includes(SECRET), e.message);
  }
}

function gateRefuses(label: string, src: Record<string, string>): void {
  try {
    context.identityFor(envMod.parseEnv(src));
    ok(`gate: ${label} is refused`, false);
  } catch (err) {
    const e = err as Error;
    ok(`gate: ${label} is refused with an EnvError naming sign-in`, e.name === 'EnvError' && e.message.includes('sign-in'), e.message);
  }
}

// ── AUTH_MODE and its variables ─────────────────────────────────────────────
const d = envMod.parseEnv({}).auth;
ok('env: AUTH_MODE defaults to dev, org default', d.mode === 'dev' && d.org === 'default' && d.oidc === null, JSON.stringify(d));
ok('env: session idle defaults to 8 h, absolute to 7 days', d.sessionIdleMs === 8 * 3_600_000 && d.sessionAbsoluteMs === 7 * 86_400_000, JSON.stringify(d));
ok('env: the auth config is frozen', Object.isFrozen(d) && Object.isFrozen(d.allowedDomains));
const o = envMod.parseEnv({
  ...OIDC,
  ORDINATE_ORG: 'acme',
  ORDINATE_ADMIN_EMAIL: ' Boss@Acme.COM ',
  ALLOWED_EMAIL_DOMAINS: 'Acme.com, acme.co.uk',
  SESSION_IDLE_MINUTES: '30',
  SESSION_ABSOLUTE_HOURS: '12',
}).auth;
ok('env: oidc is read in full', o.mode === 'oidc' && o.oidc?.issuer === OIDC.OIDC_ISSUER && o.oidc.clientSecret === SECRET && o.oidc.redirectUrl === OIDC.OIDC_REDIRECT_URL);
ok('env: admin email and domains are lower-cased and trimmed', o.adminEmail === 'boss@acme.com' && o.allowedDomains.join() === 'acme.com,acme.co.uk', JSON.stringify(o.allowedDomains));
ok('env: org and session lifetimes are taken', o.org === 'acme' && o.sessionIdleMs === 30 * 60_000 && o.sessionAbsoluteMs === 12 * 3_600_000);
envFails('AUTH_MODE=saml', { AUTH_MODE: 'saml' }, 'AUTH_MODE');
for (const v of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URL'] as const) {
  envFails(`oidc without ${v}`, { ...OIDC, [v]: '' }, v);
}
envFails('oidc without DATABASE_URL', { ...OIDC, DATABASE_URL: '' }, 'DATABASE_URL');
envFails('header without DATABASE_URL', { AUTH_MODE: 'header', TRUSTED_PROXY_CIDRS: '10.0.0.0/8' }, 'DATABASE_URL');
// prod + DATABASE_URL also needs ORDINATE_MASTER_KEY (T5.3) before auth is read.
const KEY = { ORDINATE_MASTER_KEY: '0'.repeat(64) };
envFails('prod with an http:// issuer', { ...OIDC, ...KEY, ORDINATE_ENV: 'prod', DATA_DIR: '/srv', OIDC_ISSUER: 'http://idp.local' }, 'OIDC_ISSUER');
ok('env: dev accepts an http:// issuer (a local mock IdP)', envMod.parseEnv({ ...OIDC, OIDC_ISSUER: 'http://127.0.0.1:9999' }).auth.oidc?.issuer === 'http://127.0.0.1:9999');
envFails('header without TRUSTED_PROXY_CIDRS', { AUTH_MODE: 'header', DATABASE_URL: DB }, 'TRUSTED_PROXY_CIDRS');
envFails('TRUSTED_PROXY_CIDRS of commas only', { AUTH_MODE: 'header', DATABASE_URL: DB, TRUSTED_PROXY_CIDRS: ' , ' }, 'TRUSTED_PROXY_CIDRS');
for (const bad of ['10.0.0.0/33', 'fd00::/129', 'proxy.internal', '10.0.0.0/8/1', '10.0.0/8', '10.0.0.0/x', '::1/-1']) {
  envFails(`TRUSTED_PROXY_CIDRS=${bad}`, { AUTH_MODE: 'header', DATABASE_URL: DB, TRUSTED_PROXY_CIDRS: bad }, 'TRUSTED_PROXY_CIDRS');
}
envFails('ORDINATE_ORG=../x', { ORDINATE_ORG: '../x' }, 'ORDINATE_ORG');
envFails('ORDINATE_ADMIN_EMAIL=nobody', { ORDINATE_ADMIN_EMAIL: 'nobody' }, 'ORDINATE_ADMIN_EMAIL');
envFails('ALLOWED_EMAIL_DOMAINS=@acme', { ALLOWED_EMAIL_DOMAINS: '@acme' }, 'ALLOWED_EMAIL_DOMAINS');
envFails('SESSION_IDLE_MINUTES=0', { SESSION_IDLE_MINUTES: '0' }, 'SESSION_IDLE_MINUTES');
envFails('SESSION_ABSOLUTE_HOURS=1.5', { SESSION_ABSOLUTE_HOURS: '1.5' }, 'SESSION_ABSOLUTE_HOURS');

// ── The prod gate on dev sign-in ────────────────────────────────────────────
gateRefuses('prod with AUTH_MODE=dev', { ORDINATE_ENV: 'prod', DATA_DIR: '/srv', AUTH_MODE: 'dev' });
gateRefuses('prod with AUTH_MODE unset', { ORDINATE_ENV: 'prod', DATA_DIR: '/srv' });
ok('gate: dev with AUTH_MODE=dev is the dev admin', context.identityFor(envMod.parseEnv({ AUTH_MODE: 'dev' }))({}).user.email === 'dev@local');

const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const e: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'AUTH_MODE', 'DATABASE_URL', 'OIDC_CLIENT_SECRET', 'STORAGE_URL']) if (!(k in extra)) delete e[k];
  return e;
};
const prodDev = spawnSync(process.execPath, [MAIN], {
  env: childEnv({ ORDINATE_ENV: 'prod', AUTH_MODE: 'dev', DATA_DIR: path.join(__dirname, 'nonexistent-never-created'), PORT: '0' }),
  encoding: 'utf8',
  timeout: 20_000,
});
const ours = prodDev.stderr.split('\n').filter((l) => l.startsWith('ordinate: '));
ok('process: prod + AUTH_MODE=dev exits non-zero', prodDev.status !== 0 && prodDev.status !== null, prodDev.status);
ok('process: …with one line naming sign-in and AUTH_MODE', ours.length === 1 && ours[0].includes('sign-in') && ours[0].includes('AUTH_MODE'), prodDev.stderr);
ok('process: …and never listened', !prodDev.stdout.includes('Server listening'), prodDev.stdout);
const badMode = spawnSync(process.execPath, [MAIN], { env: childEnv({ AUTH_MODE: 'oidc', PORT: '0' }), encoding: 'utf8', timeout: 20_000 });
ok('process: oidc with nothing configured refuses with one line', badMode.status !== 0 && badMode.stderr.split('\n').filter((l) => l.startsWith('ordinate: ')).length === 1, badMode.stderr);

// ── Proxy trust (header mode) ───────────────────────────────────────────────
const list = envMod.proxyList(['10.0.0.0/8', '192.168.1.7', 'fd00::/8', '2001:db8:1::/48']);
const peers: [string | undefined, boolean, string][] = [
  ['10.1.2.3', true, 'v4 inside a /8'],
  ['10.255.255.255', true, 'v4 at the edge of a /8'],
  ['11.0.0.1', false, 'v4 just outside'],
  ['192.168.1.7', true, 'v4 bare address = /32'],
  ['192.168.1.8', false, 'v4 next to a /32'],
  ['::ffff:10.1.2.3', true, 'IPv4-mapped v6 inside a v4 subnet (dual-stack socket)'],
  ['::ffff:203.0.113.9', false, 'IPv4-mapped v6 outside'],
  ['fd00::7', true, 'v6 inside fd00::/8'],
  ['fe80::1', false, 'v6 outside fd00::/8'],
  ['2001:db8:1:ffff::1', true, 'v6 inside a /48'],
  ['2001:db8:2::1', false, 'v6 outside a /48'],
  ['::1', false, 'v6 loopback, not listed'],
  ['127.0.0.1', false, 'v4 loopback, not listed'],
  [undefined, false, 'no peer address'],
  ['not-an-ip', false, 'garbage'],
];
for (const [peer, want, label] of peers) ok(`trust: ${label} (${peer}) → ${want}`, auth.isTrustedPeer(list, peer) === want);

// ── Cookies and the redirect guard ──────────────────────────────────────────
const prodNames = cookies.cookieNames(true);
ok('cookies: prod names carry __Host- / __Secure- prefixes', prodNames.session === '__Host-ordinate_session' && prodNames.tx.startsWith('__Secure-'));
const po = cookies.cookieOpts(true, '/');
ok('cookies: prod flags are httpOnly, Secure, SameSite=Lax, Path=/', po.httpOnly === true && po.secure === true && po.sameSite === 'lax' && po.path === '/');
ok('cookies: dev drops Secure only', cookies.cookieOpts(false, '/').secure === false && cookies.cookieOpts(false, '/').httpOnly === true);
const nexts: [unknown, string][] = [
  ['/data', '/data'],
  ['/visuals?id=1', '/visuals?id=1'],
  ['//evil.example', '/'],
  ['/\\evil.example', '/'],
  ['https://evil.example', '/'],
  ['javascript' + ':alert(1)', '/'], // split: the linter rightly flags a literal script URL
  ['data', '/'],
  ['/a b', '/'],
  [undefined, '/'],
  [['/x'], '/'],
];
for (const [raw, want] of nexts) ok(`next: ${JSON.stringify(raw)} → ${want}`, cookies.safeNext(raw) === want);

finish();
