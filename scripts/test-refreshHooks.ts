// Refresh URLs (live data L0.5) — the route's shape, without Postgres:
//
// 1. THE TOKEN: `ordh_` + 43 base64url characters, 1,000 distinct; stored as
//    its sha256; its first 13 characters are the listed prefix.
// 2. THE GATE: the route authorises itself. Sign-in is never looked up for it
//    (the identify spy stays at 0), no CSRF pair or same-origin Origin is
//    asked, and no CSRF cookie is handed out. NEGATIVE CONTROLS: the same
//    cross-site, cookie-less POST to /api/rpc is a 403, and identify runs.
// 3. ANY BODY, ANY METHOD: dbt and Airflow send JSON, `curl -d` a form, curl
//    -X POST nothing — all reach the handler (none is a 415); a body over the
//    cap is a 413; a method other than POST and GET (the status read) is a
//    405; a deeper path is the same 404 as
//    an unknown token. Without a database there are no hooks: every
//    well-formed token is that 404.
// 4. THE PER-IP LIMIT: the sign-in limit's numbers, in a bucket of its own —
//    the 4th call over a limit of 3 is a 429 with Retry-After, another IP is
//    not affected, and sign-in's own bucket is untouched.
// 5. NO TOKEN IN A LOG: every request line and every message (Fastify's
//    "Route … not found" is text no serializer sees) is masked. NEGATIVE
//    CONTROL: the file-token mask alone leaves a hook token in the URL.
//
// The DB half (claims, the interval across pods, revocation, audit, RLS, the
// canary over replies, rows and logs) is scripts/test-refreshHooks-db.ts.
//
//   npm run build:ts && node scripts/test-refreshHooks.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { Writable } from 'stream';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { createHash }: typeof import('crypto') = require('crypto');

const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const store: typeof import('../src/server/hooks/store') = require('../src/server/hooks/store');
const route: typeof import('../src/server/hooks/route') = require('../src/server/hooks/route');
const files: typeof import('../src/server/files') = require('../src/server/files');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-hooks-'));
const HOST = 'ordinate.test';
const log: string[] = [];
const sink = new Writable({
  write(chunk: Buffer, _enc, cb) {
    log.push(...chunk.toString('utf8').split('\n').filter(Boolean));
    cb();
  },
});

(async () => {
  // ── 1. The token ──────────────────────────────────────────────────────────
  const many = Array.from({ length: 1000 }, () => store.newHookToken());
  ok('token: ordh_ + 43 base64url chars, 1,000 of them distinct', many.every((t) => /^ordh_[A-Za-z0-9_-]{43}$/.test(t) && store.isHookToken(t))
    && new Set(many).size === 1000);
  const token = many[0];
  ok('token: stored as its hex sha256', store.hookHash(token) === createHash('sha256').update(token).digest('hex'));
  ok('token: the listed prefix is ordh_ + 8 characters', store.PREFIX_LEN === 13 && token.slice(0, store.PREFIX_LEN).startsWith('ordh_'));
  ok('token: an API token, a short one and a padded one are not hook tokens',
    !store.isHookToken('ord_' + 'a'.repeat(43)) && !store.isHookToken('ordh_abc') && !store.isHookToken(`${token}x`) && !store.isHookToken(` ${token}`));

  // ── 5 (unit). The masks ───────────────────────────────────────────────────
  const url = `/api/hooks/refresh/${token}`;
  ok('mask: the request line hides the path after /api/hooks/refresh/', route.maskHookUrl(url) === '/api/hooks/refresh/[redacted]');
  ok('mask: …a malformed token there too (it is still a credential to someone)', route.maskHookUrl('/api/hooks/refresh/whatever-was-sent') === '/api/hooks/refresh/[redacted]');
  ok('mask: …and a token anywhere else in a URL', !route.maskHookUrl(`/api/hooks%2Frefresh/${token}`).includes(token.slice(5)));
  ok('mask: a message string loses the token', route.maskHookTokens(`Route POST:${url} not found`) === 'Route POST:/api/hooks/refresh/ordh_[redacted] not found');
  ok('mask (NEGATIVE CONTROL): the file-token mask alone leaves the hook token in the URL', files.maskFileToken(url).includes(token));

  // ── 2–5. The app, without Postgres ────────────────────────────────────────
  let identified = 0;
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', DATA_DIR: DATA, LOG_LEVEL: 'trace', RATE_LIMIT_LOGIN_PER_MINUTE: '3' }), sink, () => {
    identified++;
    return { user: { email: 'dev@local', role: 'admin' }, org: { id: 'default' } };
  });
  try {
    await app.ready();
    const hook = (t: string, opts: { method?: 'POST' | 'GET' | 'PUT' | 'DELETE'; headers?: Record<string, string>; payload?: string | Buffer; ip?: string } = {}) =>
      app.inject({ method: opts.method ?? 'POST', url: `/api/hooks/refresh/${t}`, headers: { host: HOST, ...opts.headers }, payload: opts.payload, remoteAddress: opts.ip ?? '10.0.0.9' });
    const csrfCookie = (h: Record<string, unknown>) => [h['set-cookie']].flat().find((c) => typeof c === 'string' && c.includes('ordinate_csrf'));

    // 2. The gate
    const before = identified;
    const cross = await hook(token, { headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, payload: '{}' });
    ok('gate: a cross-site POST with no CSRF pair reaches the route (404: no database, no hooks), not a CSRF 403',
      cross.statusCode === 404 && cross.json().error === 'unknown refresh URL', `${cross.statusCode} ${cross.body}`);
    ok('gate: sign-in was never looked up for it', identified === before, identified - before);
    ok('gate: no CSRF cookie is handed out on it', !csrfCookie(cross.headers), String(cross.headers['set-cookie']));
    ok('gate: no-store on the reply', cross.headers['cache-control'] === 'no-store');
    const rpcCross = await app.inject({ method: 'POST', url: '/api/rpc/projects:list', headers: { host: HOST, origin: 'https://evil.example', 'content-type': 'application/json' }, payload: '{"args":[]}' });
    ok('gate (NEGATIVE CONTROL): the same cross-site POST to /api/rpc → 403 origin', rpcCross.statusCode === 403 && rpcCross.json().error === 'origin', rpcCross.body);
    const rpcBare = await app.inject({ method: 'POST', url: '/api/rpc/projects:list', headers: { host: HOST, 'content-type': 'application/json' }, payload: '{"args":[]}' });
    ok('gate (NEGATIVE CONTROL): …and with no pair → 403 csrf, with a cookie handed out', rpcBare.statusCode === 403 && rpcBare.json().error === 'csrf' && !!csrfCookie(rpcBare.headers));
    const n0 = identified;
    await app.inject({ method: 'POST', url: '/api/rpc/projects:list', headers: { host: HOST, 'content-type': 'application/json', cookie: `ordinate_csrf=${'c'.repeat(43)}`, 'x-csrf-token': 'c'.repeat(43) }, payload: '{"args":[]}' });
    ok('gate (NEGATIVE CONTROL): a signed-in route does look the caller up', identified > n0);

    // 3. Any body, any method
    const bodies: [string, Record<string, string>, string | undefined][] = [
      ['no body (curl -X POST)', {}, undefined],
      ['a form (curl -d)', { 'content-type': 'application/x-www-form-urlencoded' }, 'a=1'],
      ['JSON (dbt, Airflow)', { 'content-type': 'application/json' }, '{"run":"nightly"}'],
      ['malformed JSON', { 'content-type': 'application/json' }, '{nope'],
      ['text', { 'content-type': 'text/plain' }, 'hello'],
      ['an odd type', { 'content-type': 'application/x-ordinate-probe' }, 'x'],
    ];
    for (const [i, [what, h, payload]] of bodies.entries()) {
      const r = await hook(token, { headers: h, payload, ip: `10.0.3.${i + 1}` }); // an IP each: the limit here is 3
      ok(`body: ${what} → the handler answers (404 unknown), not a 415/400`, r.statusCode === 404 && r.json().error === 'unknown refresh URL', `${r.statusCode} ${r.body}`);
    }
    const big = await hook(token, { headers: { 'content-type': 'application/json' }, payload: `"${'x'.repeat(70 * 1024)}"`, ip: '10.0.1.2' });
    ok('body: over 64 KiB → 413', big.statusCode === 413, big.statusCode);
    for (const method of ['PUT', 'DELETE'] as const) {
      const r = await hook(token, { method, ip: '10.0.1.3' });
      ok(`method: ${method} → 405, Allow: GET, POST`, r.statusCode === 405 && r.headers.allow === 'GET, POST', `${r.statusCode} ${r.body}`);
    }
    // GET asks how the last call ended (scripts/test-refreshHooks-status.ts): the same gate, and the same 404 here.
    const asked = await hook(token, { method: 'GET', ip: '10.0.1.3' });
    ok('method: GET is the status read — without a database, the unknown token\'s 404', asked.statusCode === 404 && asked.json().error === 'unknown refresh URL', `${asked.statusCode} ${asked.body}`);
    const deeper = await hook(`${token}/extra`, { ip: '10.0.1.4' });
    const unknown = await hook(store.newHookToken(), { ip: '10.0.1.4' });
    ok('path: a deeper path is the same 404 as an unknown token', deeper.statusCode === 404 && deeper.body === unknown.body, `${deeper.statusCode} ${deeper.body}`);
    const malformed = await hook('ordh_short', { ip: '10.0.1.4' });
    ok('path: a malformed token is the same 404', malformed.statusCode === 404 && malformed.body === unknown.body);

    // 4. The per-IP limit (RATE_LIMIT_LOGIN_PER_MINUTE=3 here), its own bucket
    const ip = '10.0.2.1';
    const three = await Promise.all([1, 2, 3].map(() => hook(token, { ip })));
    const fourth = await hook(token, { ip });
    ok('limit: 3 calls from one IP are answered', three.every((r) => r.statusCode === 404));
    ok('limit: the 4th → 429 with Retry-After', fourth.statusCode === 429 && Number(fourth.headers['retry-after']) >= 1, `${fourth.statusCode} ${fourth.headers['retry-after']}`);
    ok('limit: another IP is not affected', (await hook(token, { ip: '10.0.2.2' })).statusCode === 404);
    const login = await app.inject({ url: '/api/auth/login', headers: { host: HOST }, remoteAddress: ip });
    ok('limit: sign-in from that IP has its own bucket (not 429)', login.statusCode !== 429, login.statusCode);

    // 5. No token in a log line
    app.log.info(`Route POST:${url} not found`);
    app.log.warn({ kind: 'probe' }, `a message after an object, quoting ${url}`);
    await new Promise((r) => setTimeout(r, 50));
    const leaked = log.filter((l) => l.includes(token.slice(5)) || many.slice(1, 3).some((t) => l.includes(t)));
    ok(`logs: ${log.length} trace-level lines, none holding a hook token`, log.length > 20 && leaked.length === 0, leaked.slice(0, 3).join('\n'));
    ok('logs: the request line shows the masked path', log.some((l) => l.includes('/api/hooks/refresh/[redacted]')));
    ok('logs: a message naming the URL is masked too', log.some((l) => l.includes('Route POST:/api/hooks/refresh/ordh_[redacted] not found')));
  } finally {
    await app.close();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
