// Self-check for T6.2 — web hardening, over the REAL app (src/server/app.ts):
//
// 1. HEADERS on every route class — the app's HTML, a static asset, /api/rpc,
//    /api/files (upload and download), /api/events (a hijacked stream),
//    /api/auth/*, /api/mcp, the probes, a 404, a 403 — CSP (the app's outside
//    /api/, the empty one under it — a 304 for index.html included), frame-ancestors 'none', nosniff, X-Frame-Options,
//    Referrer-Policy, Permissions-Policy, COOP; HSTS in prod only.
// 2. CSRF on every non-GET route class: no token / cookie only / header only /
//    unequal → 403; the pair → through. A cross-site Origin, `Origin: null` and
//    `Sec-Fetch-Site: cross-site` → 403 even WITH the pair. Bearer requests are
//    exempt only where a bearer token decides who is asking; /api/mcp is exempt
//    (it refuses cookies itself). The cookie: readable by script, SameSite=Lax,
//    `__Host-` + Secure in prod, never on a static asset.
// 3. RATE LIMITS: sign-in per IP (login + callback share it), RPC per user and
//    per IP, 429 with Retry-After; X-Forwarded-For believed only from
//    TRUSTED_PROXY_CIDRS.
// 4. BODY CAPS: an RPC body over MAX_RPC_BODY_KB → 413 while a larger upload
//    under MAX_UPLOAD_MB passes.
// 5. TIMEOUT: an RPC past RPC_TIMEOUT_SECONDS → 504, and its DuckDB query is
//    interrupted (the org's worker answers the next query at once).
//
// Session fixation and logout-everywhere need Postgres: scripts/test-auth-db.ts.
// Real bearer tokens on RPC without a CSRF pair: scripts/test-tokens-db.ts.
//
//   npm run build:ts && node scripts/test-webHardening.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf, CSRF_TOKEN } from './csrfPair';
import { fastify, type FastifyInstance } from 'fastify';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const http: typeof import('http') = require('http');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const staticMod: typeof import('../src/server/static') = require('../src/server/static');
const headers: typeof import('../src/server/headers') = require('../src/server/headers');
const csrf: typeof import('../src/server/csrf') = require('../src/server/csrf');
const limits: typeof import('../src/server/limits') = require('../src/server/limits');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const poolMod: typeof import('../src/engine/duckdbPool') = require('../src/engine/duckdbPool');

type Res = Awaited<ReturnType<FastifyInstance['inject']>>;
type Hdrs = Record<string, string | string[] | number | undefined>;

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-t62-'));
const DIST = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-t62-web-'));
const HOST = 'ordinate.test';
const JSON_H = { 'content-type': 'application/json', host: HOST };
const HTML = { accept: 'text/html,application/xhtml+xml', host: HOST };
const BOUNDARY = 'b0undary';
const LONG = 'SELECT count(*) AS n FROM range(10000000000) t(x) WHERE x % 7 = 3';

const multipart = (bytes: number): string =>
  `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\nContent-Type: text/csv\r\n\r\n${'a'.repeat(bytes)}\r\n--${BOUNDARY}--\r\n`;
const csrfCookie = (r: { headers: Hdrs }): string | undefined =>
  ([] as string[]).concat((r.headers['set-cookie'] as string | string[] | undefined) ?? []).find((c) => /^(__Host-)?ordinate_csrf=/.test(c));

/** Every fixed header, and the CSP this response class must carry. */
function headersOk(label: string, h: Hdrs, csp: string, prod = false): void {
  const want: Record<string, string> = { ...headers.SECURITY_HEADERS, 'content-security-policy': csp };
  const wrong = Object.entries(want).filter(([k, v]) => h[k] !== v).map(([k]) => `${k}=${String(h[k])}`);
  ok(`headers: ${label} — CSP, nosniff, frame, referrer, permissions, COOP`, wrong.length === 0, wrong.join(' | '));
  ok(`headers: ${label} — CSP forbids framing`, String(h['content-security-policy']).includes("frame-ancestors 'none'"));
  ok(`headers: ${label} — HSTS ${prod ? 'present (prod)' : 'absent (dev)'}`, prod ? h['strict-transport-security'] === headers.HSTS : h['strict-transport-security'] === undefined,
    String(h['strict-transport-security']));
}

(async () => {
  // ── The CSP is the build's, plus framing; one named constant for map tiles ──
  ok('CSP: the app policy allows only self (+ data: images) and forbids inline script/style and framing',
    headers.APP_CSP === "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://a.tile.openstreetmap.org https://b.tile.openstreetmap.org https://c.tile.openstreetmap.org; font-src 'self'; connect-src 'self' https://a.tile.openstreetmap.org https://b.tile.openstreetmap.org https://c.tile.openstreetmap.org; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    headers.APP_CSP);
  // T1.3 shipped maps: exactly the three OSM raster hosts, only in img-src and connect-src, and
  // no other external host anywhere in the app's policy.
  const osm = ['a', 'b', 'c'].map((h) => `https://${h}.tile.openstreetmap.org`);
  const appCsp = String(headers.APP_CSP);
  const directive = (name: string): string => (appCsp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) ?? '');
  const external = appCsp.match(/https?:\/\/[^\s;]+/g) ?? [];
  ok('CSP: map tile hosts are exactly the three OSM hosts', JSON.stringify(headers.MAP_TILE_ORIGINS) === JSON.stringify(osm), JSON.stringify(headers.MAP_TILE_ORIGINS));
  ok('CSP: tiles allowed in img-src and connect-src', osm.every((o) => directive('img-src').includes(o) && directive('connect-src').includes(o)), appCsp);
  ok('CSP: no other external host anywhere', external.every((u) => osm.includes(u)) && !/tile\.openstreetmap/.test(directive('script-src') + directive('style-src') + directive('default-src')), JSON.stringify(external));
  ok('CSP: the web build no longer emits a second (meta) policy',
    !fs.readFileSync(path.join(__dirname, '..', 'web', 'vite.config.ts'), 'utf8').includes('http-equiv'));

  // ── env ───────────────────────────────────────────────────────────────────
  const d = envMod.parseEnv({ AUTH_MODE: 'dev' }).limits;
  ok('env: defaults — login 60/min/IP, RPC 1200/min/user and 3000/min/IP, JSON 1 MiB, RPC 60 s',
    d.loginPerMinute === 60 && d.rpcUserPerMinute === 1200 && d.rpcIpPerMinute === 3000 && d.jsonBodyBytes === 1024 * 1024 && d.rpcTimeoutMs === 60_000, JSON.stringify(d));
  for (const name of ['RATE_LIMIT_LOGIN_PER_MINUTE', 'RATE_LIMIT_RPC_PER_MINUTE', 'RATE_LIMIT_RPC_IP_PER_MINUTE', 'MAX_RPC_BODY_KB', 'RPC_TIMEOUT_SECONDS']) {
    let msg = '';
    try { envMod.parseEnv({ AUTH_MODE: 'dev', [name]: '0' }); } catch (err) { msg = (err as Error).message; }
    ok(`env: ${name}=0 is refused, naming the variable`, msg.startsWith(name), msg);
  }
  ok('env: TRUSTED_PROXY_CIDRS is read outside header mode too (rate-limit client IP)', envMod.parseEnv({ AUTH_MODE: 'dev', TRUSTED_PROXY_CIDRS: '10.0.0.0/8' }).auth.trustedProxies[0] === '10.0.0.0/8');

  // ── The real app, dev sign-in, server mode ────────────────────────────────
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  const cfg = envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA, RPC_TIMEOUT_SECONDS: '1', MAX_RPC_BODY_KB: '4' });
  const app = appMod.buildApp(cfg);
  // The built web app when present, else a stand-in dist (CI's test job does not build web/).
  let asset = '/assets/index-t62.js';
  if (fs.existsSync(path.join(staticMod.WEB_DIST, 'index.html'))) {
    const js = fs.readdirSync(path.join(staticMod.WEB_DIST, 'assets')).find((f) => f.endsWith('.js'));
    asset = `/assets/${js}`;
  } else {
    fs.mkdirSync(path.join(DIST, 'assets'));
    fs.writeFileSync(path.join(DIST, 'index.html'), '<!doctype html><div id="root"></div>');
    fs.writeFileSync(path.join(DIST, 'assets', 'index-t62.js'), 'export {}');
    staticMod.registerStatic(app, DIST);
  }
  // A slow channel for the time limit: its query runs in org `default`'s locked worker (T4.3).
  const { contracts }: typeof import('../src/api/index') = require('../src/api/index');
  const { rpc }: typeof import('../src/api/contract') = require('../src/api/contract');
  const { z }: typeof import('zod') = require('zod');
  (contracts as Record<string, unknown>)['test:slow'] = rpc({ access: 'read', org: true, input: z.undefined() });
  (require('../src/ipc/bus') as typeof import('../src/ipc/bus')).ipcMain.handle('test:slow', () => duck.queryAsync(LONG));
  const pool = poolMod.routeByOrg({ ...cfg.duckdb, dataDir: DATA, queryTimeoutMs: 60_000 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as import('net').AddressInfo).port;

  try {
    // ── 1. Headers on every route class ─────────────────────────────────────
    const page = await app.inject({ url: '/', headers: HTML });
    ok('html: / is the app', page.statusCode === 200 && page.body.includes('id="root"'), page.statusCode);
    headersOk('HTML document (/)', page.headers, headers.APP_CSP);
    headersOk('HTML client route (/data)', (await app.inject({ url: '/data/x', headers: HTML })).headers, headers.APP_CSP);
    const js = await app.inject({ url: asset, headers: { host: HOST } });
    ok('static: the asset is served', js.statusCode === 200, `${asset} ${js.statusCode}`);
    headersOk('static asset', js.headers, headers.APP_CSP);
    headersOk('static favicon/boot file or its 404', (await app.inject({ url: '/theme-boot.js', headers: { host: HOST } })).headers, headers.APP_CSP);
    // A revalidated index.html: the browser merges a 304's headers into the cached page.
    const etag = String(page.headers.etag ?? '');
    const revalidated = await app.inject({ url: '/', headers: { ...HTML, 'if-none-match': etag } });
    ok('html: a conditional reload of / is a 304', !!etag && revalidated.statusCode === 304, `${etag} ${revalidated.statusCode}`);
    headersOk('HTML 304 (its headers replace the cached page\'s)', revalidated.headers, headers.APP_CSP);
    const list = await app.inject({ method: 'POST', url: '/api/rpc/projects:list', headers: withCsrf(JSON_H), payload: wire.encode({ args: [] }) });
    ok('rpc: projects:list with the pair → 200', list.statusCode === 200 && Array.isArray(wire.decode(list.body)), list.body);
    headersOk('/api/rpc', list.headers, headers.API_CSP);
    const up = await app.inject({ method: 'POST', url: '/api/files', headers: withCsrf({ host: HOST, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }), payload: multipart(10) });
    ok('files: upload with the pair → 200', up.statusCode === 200 && typeof up.json().fileToken === 'string', up.body);
    headersOk('/api/files (upload)', up.headers, headers.API_CSP);
    headersOk('/api/files/<token> (download miss)', (await app.inject({ url: '/api/files/nope', headers: { host: HOST } })).headers, headers.API_CSP);
    const sse = await new Promise<import('http').IncomingMessage>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/api/events?client=6f1c2b7e-0d4a-4c1e-9a55-3b2f8e1d9c00`, resolve);
      req.on('error', reject);
    });
    ok('events: the stream opens', sse.statusCode === 200 && String(sse.headers['content-type']).startsWith('text/event-stream'));
    headersOk('/api/events (hijacked stream)', sse.headers, headers.API_CSP);
    sse.destroy();
    const me = await app.inject({ url: '/api/auth/me', headers: { host: HOST } });
    headersOk('/api/auth/me', me.headers, headers.API_CSP);
    headersOk('/api/auth/login (redirect)', (await app.inject({ url: '/api/auth/login', headers: { host: HOST } })).headers, headers.API_CSP);
    const mcp = await app.inject({ method: 'POST', url: '/api/mcp', headers: JSON_H, payload: '{}' });
    ok('mcp: no bearer → 401 (not a CSRF 403: the route refuses cookies itself)', mcp.statusCode === 401, `${mcp.statusCode} ${mcp.body}`);
    headersOk('/api/mcp', mcp.headers, headers.API_CSP);
    headersOk('/healthz', (await app.inject({ url: '/healthz' })).headers, headers.APP_CSP);
    headersOk('a JSON 404', (await app.inject({ url: '/api/nope', headers: { host: HOST } })).headers, headers.API_CSP);
    const refused403 = await app.inject({ method: 'POST', url: '/api/rpc/projects:list', headers: JSON_H, payload: '{"args":[]}' });
    headersOk('a CSRF 403', refused403.headers, headers.API_CSP);

    // ── 2. CSRF ────────────────────────────────────────────────────────────
    const issued = csrfCookie(page) ?? '';
    ok('cookie: the page sets one — script-readable, SameSite=Lax, Path=/, 43 chars',
      /^ordinate_csrf=[A-Za-z0-9_-]{43}; Path=\/; SameSite=Lax$/.test(issued) && !/HttpOnly/i.test(issued), issued);
    ok('cookie: an API response to a request without one sets one', !!csrfCookie(me));
    ok('cookie: a request that has a valid one is not given another', !csrfCookie(list));
    ok('cookie: never on a static asset (it is cached immutable)', !csrfCookie(js));

    const T = CSRF_TOKEN;
    const OTHER = 'o'.repeat(43);
    const cases: [string, Record<string, string>][] = [
      ['no token', {}],
      ['cookie only', { cookie: `ordinate_csrf=${T}` }],
      ['header only', { 'x-csrf-token': T }],
      ['cookie ≠ header', { cookie: `ordinate_csrf=${T}`, 'x-csrf-token': OTHER }],
      ['malformed pair', { cookie: 'ordinate_csrf=short', 'x-csrf-token': 'short' }],
    ];
    const routes: { name: string; send: (h: Record<string, string>) => Promise<Res>; okStatus: number }[] = [
      { name: 'POST /api/rpc', okStatus: 200, send: (h) => app.inject({ method: 'POST', url: '/api/rpc/projects:list', headers: { ...JSON_H, ...h }, payload: '{"args":[]}' }) },
      {
        name: 'POST /api/files', okStatus: 200,
        send: (h) => app.inject({ method: 'POST', url: '/api/files', headers: { host: HOST, 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, ...h }, payload: multipart(10) }),
      },
      { name: 'POST /api/auth/logout', okStatus: 204, send: (h) => app.inject({ method: 'POST', url: '/api/auth/logout', headers: { host: HOST, ...h } }) },
      { name: 'POST /api/auth/logout-everywhere', okStatus: 200, send: (h) => app.inject({ method: 'POST', url: '/api/auth/logout-everywhere', headers: { host: HOST, ...h } }) },
      { name: 'DELETE on a page path', okStatus: 404, send: (h) => app.inject({ method: 'DELETE', url: '/data', headers: { host: HOST, ...h } }) },
    ];
    const pair = { cookie: `ordinate_csrf=${T}`, 'x-csrf-token': T };
    for (const r of routes) {
      for (const [what, h] of cases) {
        const res = await r.send(h);
        ok(`csrf: ${r.name}, ${what} → 403 csrf`, res.statusCode === 403 && res.json().error === 'csrf', `${res.statusCode} ${res.body}`);
      }
      const good = await r.send(pair);
      ok(`csrf: ${r.name} with the pair → ${r.okStatus}`, good.statusCode === r.okStatus, `${good.statusCode} ${good.body}`);
      const same = await r.send({ ...pair, origin: `http://${HOST}` });
      ok(`origin: ${r.name}, same-origin Origin + pair → ${r.okStatus}`, same.statusCode === r.okStatus, `${same.statusCode} ${same.body}`);
      for (const [what, h] of [['cross-site Origin', { origin: 'https://evil.example' }], ['sibling-subdomain Origin', { origin: `http://x.${HOST}` }],
        ['Origin: null', { origin: 'null' }], ['Sec-Fetch-Site: cross-site, no Origin', { 'sec-fetch-site': 'cross-site' }]] as const) {
        const res = await r.send({ ...pair, ...h });
        ok(`origin: ${r.name}, ${what} → 403 even with the pair`, res.statusCode === 403 && res.json().error === 'origin', `${res.statusCode} ${res.body}`);
      }
    }
    const miss = await routes[0].send({});
    ok('csrf: the 403 carries a fresh cookie, so the client\'s one retry can succeed', !!csrfCookie(miss));
    ok('csrf: GET needs no token', (await app.inject({ url: '/api/auth/me', headers: { host: HOST } })).statusCode === 200);
    const devBearer = await routes[0].send({ authorization: 'Bearer ord_' + 'x'.repeat(43) });
    ok('bearer: without Postgres a bearer header decides nothing (dev sign-in still applies) → NOT exempt → 403', devBearer.statusCode === 403, devBearer.statusCode);

    // The exemption itself, where a bearer token does decide (a server with Postgres).
    const bare = fastify();
    csrf.registerCsrf(bare, { cookie: 'ordinate_csrf', secure: false, bearerDecides: true });
    bare.post('/api/rpc/:c', async () => ({ ran: true }));
    bare.post('/api/mcp', async () => ({ ran: true }));
    const b1 = await bare.inject({ method: 'POST', url: '/api/rpc/x', headers: { authorization: 'Bearer ord_abc' } });
    ok('bearer: a bearer request with no pair passes the CSRF check (no ambient credential to forge)', b1.statusCode === 200 && !csrfCookie(b1), `${b1.statusCode} ${b1.body}`);
    ok('bearer: …a cookie-only request to the same route does not', (await bare.inject({ method: 'POST', url: '/api/rpc/x', headers: { cookie: 'ordinate_session=s' } })).statusCode === 403);
    ok('mcp: exempt by route (it accepts nothing but a bearer token)', (await bare.inject({ method: 'POST', url: '/api/mcp' })).statusCode === 200);
    await bare.close();

    // ── Prod: HSTS and the __Host- cookie ─────────────────────────────────────
    const prod = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', ORDINATE_ENV: 'prod', DATA_DIR: DATA, LOG_LEVEL: 'silent' }), undefined,
      () => ({ user: { email: 'p@test', role: 'admin' }, org: { id: 'default' } }));
    await prod.ready();
    const pme = await prod.inject({ url: '/api/auth/me', headers: { host: HOST } });
    headersOk('prod /api/auth/me', pme.headers, headers.API_CSP, true);
    headersOk('prod /healthz', (await prod.inject({ url: '/healthz' })).headers, headers.APP_CSP, true);
    const pc = csrfCookie(pme) ?? '';
    ok('prod cookie: __Host-ordinate_csrf, Secure, Path=/, SameSite=Lax', /^__Host-ordinate_csrf=[A-Za-z0-9_-]{43}; Path=\/; Secure; SameSite=Lax$/.test(pc), pc);
    const pOk = await prod.inject({ method: 'POST', url: '/api/rpc/projects:list', headers: { ...JSON_H, cookie: `__Host-ordinate_csrf=${T}`, 'x-csrf-token': T }, payload: '{"args":[]}' });
    ok('prod: the __Host- pair passes', pOk.statusCode === 200, `${pOk.statusCode} ${pOk.body}`);
    const pDev = await prod.inject({ method: 'POST', url: '/api/rpc/projects:list', headers: { ...JSON_H, cookie: `ordinate_csrf=${T}`, 'x-csrf-token': T }, payload: '{"args":[]}' });
    ok('prod: an un-prefixed cookie (plantable by a sibling subdomain) does not', pDev.statusCode === 403, pDev.statusCode);
    await prod.close();

    // ── 4. Body caps: JSON separate from uploads ─────────────────────────────
    const big = await app.inject({ method: 'POST', url: '/api/rpc/projects:list', headers: withCsrf(JSON_H), payload: `{"args":[],"pad":"${'x'.repeat(5 * 1024)}"}` });
    ok('body: an RPC body over MAX_RPC_BODY_KB (4) → 413', big.statusCode === 413, `${big.statusCode} ${big.body}`);
    headersOk('a 413', big.headers, headers.API_CSP);
    const under = await app.inject({ method: 'POST', url: '/api/rpc/projects:list', headers: withCsrf(JSON_H), payload: `{"args":[],"pad":"${'x'.repeat(3 * 1024)}"}` });
    ok('body: …one under it is read (200)', under.statusCode === 200, `${under.statusCode} ${under.body}`);
    const bigUp = await app.inject({ method: 'POST', url: '/api/files', headers: withCsrf({ host: HOST, 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }), payload: multipart(64 * 1024) });
    ok('body: a 64 KB upload is not held to the JSON cap (MAX_UPLOAD_MB governs it) → 200', bigUp.statusCode === 200, `${bigUp.statusCode} ${bigUp.body}`);

    // ── 5. Time limit ────────────────────────────────────────────────────────
    let t0 = Date.now();
    const slow = await fetch(`http://127.0.0.1:${port}/api/rpc/test:slow`, { method: 'POST', headers: withCsrf({ 'content-type': 'application/json' }), body: wire.encode({ args: [] }) });
    const took = Date.now() - t0;
    ok(`timeout: an RPC past RPC_TIMEOUT_SECONDS=1 → 504 in ${took} ms`, slow.status === 504 && ((await slow.json()) as { error: string }).error === 'timeout' && took >= 900 && took < 5000,
      `${slow.status} ${took}`);
    t0 = Date.now();
    await context.runInContext({ user: { email: 'dev@local', role: 'admin' }, org: { id: 'default' } }, 'r', () => duck.queryAsync('SELECT 1 AS x'));
    const next = Date.now() - t0;
    ok(`timeout: …and its DuckDB query was interrupted — the org's worker answers next in ${next} ms`, next < 1000, next);
    const fast = await app.inject({ method: 'POST', url: '/api/rpc/projects:list', headers: withCsrf(JSON_H), payload: '{"args":[]}' });
    ok('timeout: a quick RPC is untouched by the limit', fast.statusCode === 200);
  } finally {
    await app.close();
    pool.shutdown();
  }

  // ── 3. Rate limits ─────────────────────────────────────────────────────────
  // RPC per user and per IP, on the real app (identity from a test header).
  const rl = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA, RATE_LIMIT_RPC_PER_MINUTE: '3', RATE_LIMIT_RPC_IP_PER_MINUTE: '6', RATE_LIMIT_LOGIN_PER_MINUTE: '3' }),
    undefined, (h) => ({ user: { email: String(h['x-test-user'] ?? 'u1'), role: 'admin' }, org: { id: 'default' }, ...(h['x-test-token'] ? { via: 'token' as const } : {}) }));
  await rl.ready();
  const call = (user: string, ip: string) =>
    rl.inject({ method: 'POST', url: '/api/rpc/projects:list', remoteAddress: ip, headers: withCsrf({ ...JSON_H, 'x-test-user': user }), payload: '{"args":[]}' });
  const u1 = [];
  for (let i = 0; i < 4; i++) u1.push(await call('u1', '198.51.100.1'));
  ok('rpc per user: 3 calls pass', u1.slice(0, 3).every((r) => r.statusCode === 200), u1.map((r) => r.statusCode).join());
  const over = u1[3];
  const after = Number(over.headers['retry-after']);
  ok(`rpc per user: the 4th → 429 with Retry-After ${after} s`, over.statusCode === 429 && after >= 1 && after <= 60 && over.json().error === 'rate limited', `${over.statusCode} ${over.headers['retry-after']}`);
  headersOk('a 429', over.headers, headers.API_CSP);
  const u2 = [await call('u2', '198.51.100.1'), await call('u2', '198.51.100.1'), await call('u2', '198.51.100.1')];
  ok('rpc per IP: another user from the same IP passes until the IP has made 6', u2[0].statusCode === 200 && u2[1].statusCode === 200, u2.map((r) => r.statusCode).join());
  ok('rpc per IP: …then 429 although that user made only 3', u2[2].statusCode === 429 && Number(u2[2].headers['retry-after']) >= 1);
  ok('rpc per user: u1 is still limited from another IP (the bucket is the person)', (await call('u1', '198.51.100.2')).statusCode === 429);
  ok('rpc: a fresh user from a fresh IP passes', (await call('u3', '198.51.100.3')).statusCode === 200);
  // T6.3: /api/mcp runs the same handlers, so it spends the same per-user and per-IP buckets (it had none).
  const mcpCall = (user: string, ip: string) =>
    rl.inject({ method: 'POST', url: '/api/mcp', remoteAddress: ip, headers: { ...JSON_H, 'x-test-user': user, 'x-test-token': '1' }, payload: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  const m1 = [];
  for (let i = 0; i < 4; i++) m1.push(await mcpCall('m1', '198.51.100.20'));
  ok('mcp per user: 3 tool calls pass, the 4th → 429 with Retry-After', m1.slice(0, 3).every((r) => r.statusCode === 200) && m1[3].statusCode === 429 && Number(m1[3].headers['retry-after']) >= 1, m1.map((r) => r.statusCode).join());
  const m2 = [await mcpCall('m2', '198.51.100.20'), await mcpCall('m2', '198.51.100.20'), await mcpCall('m2', '198.51.100.20')];
  ok('mcp per IP: another token user from that IP is refused once the IP has made 6', m2[0].statusCode === 200 && m2[1].statusCode === 200 && m2[2].statusCode === 429, m2.map((r) => r.statusCode).join());
  ok('mcp per user: the bucket is the person — RPC is refused too after the MCP calls', (await call('m1', '198.51.100.21')).statusCode === 429);
  const login = [];
  for (let i = 0; i < 4; i++) login.push(await rl.inject({ url: '/api/auth/login', remoteAddress: '203.0.113.7' }));
  ok('sign-in: 3 logins from one IP pass', login.slice(0, 3).every((r) => r.statusCode === 302), login.map((r) => r.statusCode).join());
  ok('sign-in: the 4th → 429 with Retry-After', login[3].statusCode === 429 && Number(login[3].headers['retry-after']) >= 1, `${login[3].statusCode}`);
  ok('sign-in: another IP still signs in', (await rl.inject({ url: '/api/auth/login', remoteAddress: '203.0.113.8' })).statusCode === 302);
  await rl.close();

  // Login + callback share one bucket; X-Forwarded-For only from a trusted proxy.
  const bare = fastify();
  const proxies = envMod.proxyList(['10.0.0.0/8']);
  limits.registerLimits(bare, { loginPerMinute: 2, rpcUserPerMinute: 99, rpcIpPerMinute: 99, jsonBodyBytes: 1024, rpcTimeoutMs: 1000, refreshHookMinIntervalSec: 60 }, proxies);
  bare.get('/api/auth/login', async () => 'login');
  bare.get('/api/auth/callback', async () => 'cb');
  bare.get('/other', async () => 'x');
  await bare.ready();
  const g = (url: string, ip: string, xff?: string) => bare.inject({ url, remoteAddress: ip, headers: xff ? { 'x-forwarded-for': xff } : {} });
  const seq = [await g('/api/auth/login', '192.0.2.1'), await g('/api/auth/callback', '192.0.2.1'), await g('/api/auth/callback', '192.0.2.1')];
  ok('sign-in: login and callback share the per-IP bucket (2 → the 3rd is 429)', seq[0].statusCode === 200 && seq[1].statusCode === 200 && seq[2].statusCode === 429, seq.map((r) => r.statusCode).join());
  ok('limits: other routes are not limited', (await g('/other', '192.0.2.1')).statusCode === 200);
  const viaProxy = [await g('/api/auth/login', '10.1.1.1', '198.51.100.9'), await g('/api/auth/login', '10.1.1.1', '198.51.100.9'), await g('/api/auth/login', '10.1.1.1', '198.51.100.10')];
  ok('xff: behind a trusted proxy each client has its own bucket', viaProxy[0].statusCode === 200 && viaProxy[1].statusCode === 200 && viaProxy[2].statusCode === 200, viaProxy.map((r) => r.statusCode).join());
  ok('xff: …the proxy-named client is limited on its own', (await g('/api/auth/login', '10.1.1.1', '198.51.100.9')).statusCode === 429);
  const spoof = [await g('/api/auth/login', '192.0.2.50', '1.1.1.1'), await g('/api/auth/login', '192.0.2.50', '2.2.2.2'), await g('/api/auth/login', '192.0.2.50', '3.3.3.3')];
  ok('xff: from an untrusted peer X-Forwarded-For is ignored (rotating it does not escape)', spoof[2].statusCode === 429, spoof.map((r) => r.statusCode).join());
  const req = (peer: string, xff?: string) => ({ socket: { remoteAddress: peer }, headers: xff ? { 'x-forwarded-for': xff } : {} }) as unknown as Parameters<typeof limits.clientIp>[0];
  ok('clientIp: right-most untrusted hop, trusted hops skipped', limits.clientIp(req('10.0.0.1', '6.6.6.6, 198.51.100.4, 10.0.0.9'), proxies) === '198.51.100.4');
  ok('clientIp: untrusted peer → the peer', limits.clientIp(req('192.0.2.9', '10.0.0.1'), proxies) === '192.0.2.9');
  await bare.close();
})()
  .catch((err) => ok('threw: ' + String(err && (err as Error).stack), false))
  .finally(() => {
    duck.shutdown();
    for (const dir of [DATA, DIST]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    finish();
  });
