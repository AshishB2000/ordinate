// Self-check for the SSRF guard (T6.1, src/connectors/ssrf.ts) and every place
// it is wired: connectionRun's `host` pin for the DB drivers, the HTTP engines'
// transport, the URL source, the SaaS transport and the AI provider fetch.
//
// No network leaves the machine. Names under `.ssrf.test` resolve through a fake
// `dns.promises.lookup` (the one the guard calls); the OS resolver cannot resolve
// them, so a socket that lands on a local stub under such a name PROVES it went
// to the pinned address rather than to a second, unguarded DNS answer.

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as dns from 'dns';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

const ssrf: typeof import('../src/connectors/ssrf') = require('../src/connectors/ssrf');
const run: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
const context: typeof import('../src/server/context') = require('../src/server/context');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const saasHttp: typeof import('../src/connectors/saasHttp') = require('../src/connectors/saasHttp');
const oracle: typeof import('../src/connectors/oracle') = require('../src/connectors/oracle');
const { providerFetch }: typeof import('../src/ai/providerFetch') = require('../src/ai/providerFetch');

// ── fake DNS for *.ssrf.test ─────────────────────────────────────────────────

const FAKE: Record<string, string[]> = {
  'internal.ssrf.test': ['10.1.2.3'],
  'mixed.ssrf.test': ['93.184.216.34', '127.0.0.1'],
  'meta.ssrf.test': ['169.254.169.254'],
  'v6meta.ssrf.test': ['fd00:ec2::254'],
  'cgnat.ssrf.test': ['100.100.100.200'],
  'pinned.ssrf.test': ['127.0.0.1'],
};
// A DNS-rebinding attacker: 127.0.0.1 on the first lookup, 10.255.255.1 after.
// rebind.ssrf.test counts across a redirect; once.ssrf.test is reset per driver.
let rebindCount = 0;
let onceCount = 0;
const realLookup = dns.promises.lookup;
const fakeLookup = async (host: string, opts?: unknown): Promise<dns.LookupAddress[]> => {
  const h = host.toLowerCase();
  if (h === 'rebind.ssrf.test') return [{ address: rebindCount++ === 0 ? '127.0.0.1' : '10.255.255.1', family: 4 }];
  if (h === 'once.ssrf.test') return [{ address: onceCount++ === 0 ? '127.0.0.1' : '10.255.255.1', family: 4 }];
  if (FAKE[h]) return FAKE[h].map((address) => ({ address, family: net.isIP(address) }));
  return (realLookup as (h: string, o: unknown) => Promise<dns.LookupAddress[]>)(host, opts);
};
(dns.promises as unknown as { lookup: typeof fakeLookup }).lookup = fakeLookup;

// ── stubs ────────────────────────────────────────────────────────────────────

interface Hit { url: string; method: string; host: string; auth: string; body: string }
function httpStub(handler: (req: http.IncomingMessage, res: http.ServerResponse, port: number) => void) {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      hits.push({ url: req.url || '', method: req.method || '', host: String(req.headers.host), auth: String(req.headers.authorization ?? ''), body });
      handler(req, res, (server.address() as net.AddressInfo).port);
    });
  });
  return new Promise<{ port: number; hits: Hit[]; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, hits, close: () => server.close() }));
  });
}

/** A TCP listener that counts connections and hangs up — what a DB driver dials. */
function tcpStub() {
  const s = { port: 0, conns: 0, close: () => server.close() };
  const server = net.createServer((sock) => { s.conns += 1; sock.destroy(); });
  return new Promise<typeof s>((resolve) => server.listen(0, '127.0.0.1', () => { s.port = (server.address() as net.AddressInfo).port; resolve(s); }));
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '';
  } catch (e) {
    return e instanceof Error && e.name === 'SsrfError' ? e.message : `not an SsrfError: ${String(e)}`;
  }
}

const DB = ['postgres', 'mysql', 'sqlserver', 'oracle'] as const;
const dbValues = (id: string, host: string, port: number): Record<string, unknown> => ({
  host, port, database: 'db', user: 'u', serviceName: 'svc', encrypt: false, ...(id === 'mysql' ? { ssl: false } : {}),
});
const QUICK = { timeoutMs: 3000 };

async function main(): Promise<void> {
  // ── 1. hostile URLs through safeFetch (no allowlist) ──────────────────────
  delete process.env.SSRF_ALLOW;
  const HOSTILE = [
    // loopback in every spelling the WHATWG parser and getaddrinfo accept
    'http://127.0.0.1/', 'http://127.0.0.1:5432/', 'http://localhost/', 'http://2130706433/', 'http://0x7f000001/',
    'http://0x7f.1/', 'http://0177.0.0.1/', 'http://017700000001/', 'http://127.1/', 'http://127.0.1/', 'http://①②⑦.0.0.1/',
    'http://[::1]/', 'http://[0:0:0:0:0:0:0:1]/',
    // unspecified
    'http://0/', 'http://0.0.0.0/', 'http://[::]/',
    // IPv4 inside IPv6
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:169.254.169.254]/', 'http://[::127.0.0.1]/',
    'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/', 'http://[2001::7f00:1]/',
    // cloud metadata
    'http://169.254.169.254/latest/meta-data/iam/', 'http://2852039166/', 'http://0xa9fea9fe/', 'http://[fd00:ec2::254]/',
    'http://100.100.100.200/', 'http://meta.ssrf.test/computeMetadata/v1/',
    // private, CGNAT, ULA, link-local, site-local, multicast, broadcast, reserved
    'http://10.0.0.1/', 'http://172.16.0.1/', 'http://172.31.255.254/', 'http://192.168.0.1/', 'http://100.64.0.1/',
    'http://[fc00::1]/', 'http://[fe80::1]/', 'http://[fec0::1]/', 'http://224.0.0.1/', 'http://255.255.255.255/',
    'http://198.18.0.1/', 'http://192.0.0.170/',
    // DNS names resolving inside
    'http://internal.ssrf.test/', 'http://mixed.ssrf.test/', 'http://v6meta.ssrf.test/', 'http://cgnat.ssrf.test/',
    // not http(s), or credentials in the URL
    'file:///etc/passwd', 'ftp://127.0.0.1/', 'gopher://127.0.0.1:6379/_INFO', 'https://user:pw@example.com/',
  ];
  let refused = 0;
  for (const u of HOSTILE) {
    const why = await refusal(ssrf.safeFetch(u, { signal: AbortSignal.timeout(3000) }));
    if (why.startsWith('Refused')) refused += 1;
    else ok(`hostile ${u} refused`, false, why || 'it was fetched');
  }
  ok(`${refused} of ${HOSTILE.length} hostile URLs refused before any socket opened (need 30+)`, refused === HOSTILE.length && refused >= 30);
  const named = await refusal(ssrf.safeFetch('http://169.254.169.254/'));
  ok('the refusal names the range and the remedy', /link-local \(cloud metadata\)/.test(named) && /SSRF_ALLOW/.test(named), named);

  // DB host field spellings (checkHost) — no port, path, credentials or socket path slips through
  const HOSTS = ['127.0.0.1', 'localhost', '2130706433', '0177.0.0.1', '0x7f.1', '127.1', '0', '::1', '[::1]', '::ffff:127.0.0.1',
    '169.254.169.254', 'fd00:ec2::254', '', '   ', 'db.example.com:5432', 'u@db.example.com', '/var/run/postgresql', 'a b',
    'internal.ssrf.test', 'mixed.ssrf.test'];
  for (const h of HOSTS) ok(`host field ${JSON.stringify(h)} refused`, (await refusal(ssrf.checkHost(h))) !== '');
  for (const h of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) {
    ok(`public ${h} passes and pins itself`, (await ssrf.checkHost(h)).address === h);
  }
  ok('172.32.0.1 (just outside 172.16/12) is public', ssrf.refusedRange('172.32.0.1') === null);
  ok('100.128.0.1 (just outside 100.64/10) is public', ssrf.refusedRange('100.128.0.1') === null);

  // pinnedLookup answers the pin whatever name it is asked, in both callback shapes
  process.env.SSRF_ALLOW = '127.0.0.1/32';
  const pin = await ssrf.checkHost('pinned.ssrf.test');
  delete process.env.SSRF_ALLOW;
  const look = ssrf.pinnedLookup(pin) as unknown as (h: string, o: object, cb: (...a: unknown[]) => void) => void;
  let one: unknown[] = [];
  let all: unknown[] = [];
  look('evil.example', {}, (...a) => { one = a; });
  look('evil.example', { all: true }, (...a) => { all = a; });
  ok('pinnedLookup → the checked address', one[1] === '127.0.0.1' && JSON.stringify(all[1]) === '[{"address":"127.0.0.1","family":4}]');

  // ── 2. env validation ──────────────────────────────────────────────────────
  ok('SSRF_ALLOW accepts v4 and v6 CIDRs', (() => { try { envMod.parseEnv({ SSRF_ALLOW: '10.20.0.0/16, fd00::/8, 192.168.1.5' }); return true; } catch { return false; } })());
  let envErr = '';
  try { envMod.parseEnv({ SSRF_ALLOW: '10.0.0.0/33' }); } catch (e) { envErr = (e as Error).message; }
  ok('a bad SSRF_ALLOW stops startup naming the variable', envErr.startsWith('SSRF_ALLOW:'), envErr);

  // ── 3. desktop: unchanged — localhost is the use case ──────────────────────
  const ch = await httpStub((_req, res) => { res.writeHead(500); res.end('stub'); });
  const tcp = await tcpStub();
  ok('desktop: guard off', ssrf.guardOn() === false);
  await run.listTables('clickhouse', { host: '127.0.0.1', port: ch.port, insecureHttp: true }, {}, QUICK);
  ok('desktop: an HTTP engine still reaches 127.0.0.1', ch.hits.length === 1);
  await run.listTables('postgres', dbValues('postgres', '127.0.0.1', tcp.port), {}, QUICK);
  ok('desktop: a DB driver still reaches 127.0.0.1', tcp.conns === 1);

  // ── 4. server, nothing allowed ─────────────────────────────────────────────
  context.enterServerMode(fs.mkdtempSync(path.join(os.tmpdir(), 'ssrf-')));
  ok('server: guard on', ssrf.guardOn() === true);
  tcp.conns = 0;
  ch.hits.length = 0;
  for (const id of DB) {
    for (const host of ['localhost', '127.0.0.1', '2130706433', 'meta.ssrf.test', '']) {
      const res = await run.listTables(id, dbValues(id, host, tcp.port), {}, QUICK);
      ok(`server: ${id} host ${JSON.stringify(host)} refused`, !res.ok && /^(Refused|Could not)/.test(res.error), JSON.stringify(res));
    }
    const ex = await run.explainSql(id, dbValues(id, '10.0.0.1', tcp.port), {}, 'select 1');
    const desc = await run.describeTable(id, dbValues(id, '169.254.169.254', tcp.port), {}, 't', QUICK);
    const rows = await run.runConnection(id, dbValues(id, '192.168.0.10', tcp.port), {}, { table: 't' }, QUICK);
    ok(`server: ${id} explain / describe / run refused`, !ex.ok && !!desc && !desc.ok && !rows.ok && /^Refused/.test(rows.error));
  }
  ok('server: no DB socket opened for any refused host', tcp.conns === 0, tcp.conns);
  const chRes = await run.listTables('clickhouse', { host: 'localhost', port: ch.port, insecureHttp: true }, {}, QUICK);
  ok('server: HTTP engine on localhost refused, stub untouched', !chRes.ok && /^Refused/.test(chRes.error) && ch.hits.length === 0, JSON.stringify(chRes));
  for (const u of ['https://169.254.169.254/latest/meta-data/', 'https://2130706433/', 'https://[::ffff:10.0.0.1]/', 'https://internal.ssrf.test/x.json']) {
    const res = await run.runConnection('url', { url: u }, {}, {}, QUICK);
    ok(`server: URL source ${u} refused (the refresh path runs the same call)`, !res.ok && /^Refused/.test(res.error), JSON.stringify(res));
  }
  const adb = ['tcps://adb.us-ashburn-1.oraclecloud.com:1522/x_high.adb.oraclecloud.com',
    '(description=(address=(protocol=tcps)(port=1522)(host=169.254.169.254))(connect_data=(service_name=x)))',
    'tcps://h1.example.com,[::1]:1522/svc?https_proxy=10.0.0.1&https_proxy_port=80'];
  ok('Oracle connect strings: every host and proxy is found', JSON.stringify(adb.map(oracle.connectStringHosts)) ===
    JSON.stringify([['adb.us-ashburn-1.oraclecloud.com'], ['169.254.169.254'], ['h1.example.com', '::1', '10.0.0.1']]));
  const adbRes = await run.listTables('oracle-autonomous', { connectString: adb[1], user: 'u' }, { password: 'p' }, QUICK);
  ok('server: Oracle ADB connect string to metadata refused', !adbRes.ok && /^Refused/.test(adbRes.error), JSON.stringify(adbRes));

  process.env[saasHttp.FIXTURE_ENV] = `http://127.0.0.1:${ch.port}`;
  const ctx = run.buildContext({}, {}, QUICK);
  const saasRes = await saasHttp.saasRequest(ctx, ['api.github.com'], { url: new URL('https://api.github.com/repos/a/b/issues') });
  ok('server: SaaS transport goes through the guard (a loopback fixture is refused)', !saasRes.ok && /loopback/.test(saasRes.error) && ch.hits.length === 0, JSON.stringify(saasRes));
  ok('server: AI gateway base URL to metadata refused', /^Refused/.test(await refusal(providerFetch('http://169.254.169.254/v1/chat/completions', { method: 'POST', body: '{}' }))));

  // ── 5. server, 127.0.0.1 allowlisted: allowed private hosts work, pinned ───
  process.env.SSRF_ALLOW = '127.0.0.1/32';
  for (const id of DB) {
    // Any second resolution answers 10.255.255.1, so the stub is reached only through the pin.
    const before = tcp.conns;
    onceCount = 0;
    const res = await run.listTables(id, dbValues(id, 'once.ssrf.test', tcp.port), {}, QUICK);
    ok(`allowlisted: ${id} dials the PINNED address, never a second DNS answer`, tcp.conns > before && onceCount === 1 && !res.ok, `conns+${tcp.conns - before} lookups=${onceCount} ${JSON.stringify(res)}`);
  }
  ch.hits.length = 0;
  await run.listTables('clickhouse', { host: 'pinned.ssrf.test', port: ch.port, insecureHttp: true }, {}, QUICK);
  ok('allowlisted: HTTP engine dials the pinned address, Host header keeps the name', ch.hits.length === 1 && ch.hits[0].host === `pinned.ssrf.test:${ch.port}`, JSON.stringify(ch.hits));
  ch.hits.length = 0;
  const saasOk = await saasHttp.saasRequest(ctx, ['api.github.com'], { url: new URL('https://api.github.com/repos/a/b/issues') });
  ok('allowlisted: the SaaS fixture is reached', ch.hits.length === 1 && !saasOk.ok && saasOk.status === 500);
  ok('allowlisted: ::1 stays refused (only 127.0.0.1/32 was allowed)', (await refusal(ssrf.checkHost('::1'))) !== '');
  delete process.env[saasHttp.FIXTURE_ENV];

  const PAGE = 'hello from an allowed host';
  const a = await httpStub((req, res, port) => {
    const u = req.url || '';
    if (u === '/ok') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(PAGE); return; }
    if (u === '/loop') { res.writeHead(302, { location: `http://127.0.0.1:${port}/loop` }); res.end(); return; }
    if (u === '/same') { res.writeHead(302, { location: '/ok' }); res.end(); return; }
    if (u === '/see-other') { res.writeHead(303, { location: '/ok' }); res.end(); return; }
    if (u === '/rebind') { res.writeHead(302, { location: `http://rebind.ssrf.test:${port}/ok` }); res.end(); return; }
    if (u.startsWith('/to?')) { res.writeHead(302, { location: decodeURIComponent(u.slice(4)) }); res.end(); return; }
    res.writeHead(404); res.end();
  });
  const b = await httpStub((_req, res) => { res.writeHead(200); res.end('b'); });
  const base = `http://127.0.0.1:${a.port}`;

  const okRes = await ssrf.safeFetch(`${base}/ok`);
  ok('allowlisted: safeFetch reads an allowed private host', okRes.status === 200 && (await okRes.text()) === PAGE);
  const viaName = await ssrf.safeFetch(`http://pinned.ssrf.test:${a.port}/ok`).catch((e: Error) => e);
  ok('allowlisted: a name is fetched from its pinned address', viaName instanceof Response && (await viaName.text()) === PAGE, viaName);
  const ai = await providerFetch(`${base}/ok`, { method: 'GET' });
  ok('allowlisted: providerFetch streams from an allowed gateway', ai.ok && (await new Response(ai.body).text()) === PAGE);

  const REDIRECT_TARGETS = ['http://169.254.169.254/latest/meta-data/', 'http://2852039166/', 'http://[::ffff:a9fe:a9fe]/',
    'http://[::1]/', 'http://10.0.0.1/', 'http://meta.ssrf.test/', 'file:///etc/passwd', 'gopher://127.0.0.1:6379/'];
  for (const t of REDIRECT_TARGETS) {
    const hitsBefore = a.hits.length;
    const why = await refusal(ssrf.safeFetch(`${base}/to?${encodeURIComponent(t)}`, { signal: AbortSignal.timeout(3000) }));
    ok(`redirect hop to ${t} refused`, why.startsWith('Refused') && a.hits.length === hitsBefore + 1, why);
  }
  rebindCount = 0;
  const rebind = await refusal(ssrf.safeFetch(`http://rebind.ssrf.test:${a.port}/rebind`, { signal: AbortSignal.timeout(3000) }));
  ok('DNS rebinding: the redirect hop re-resolves, sees 10.255.255.1, refuses', /10\.255\.255\.1/.test(rebind) && rebindCount === 2, rebind);
  a.hits.length = 0;
  const loop = await refusal(ssrf.safeFetch(`${base}/loop`));
  ok(`redirects capped at ${ssrf.MAX_REDIRECTS}`, /more than 5 redirects/.test(loop) && a.hits.length === ssrf.MAX_REDIRECTS + 1, `${loop} hits=${a.hits.length}`);
  const manual = await ssrf.safeFetch(`${base}/loop`, { redirect: 'manual' });
  ok("redirect: 'manual' hands the 3xx back", manual.status === 302);

  a.hits.length = 0;
  const same = await ssrf.safeFetch(`${base}/same`, { headers: { authorization: 'Bearer same-origin' } });
  ok('same-origin redirect keeps the credential', same.status === 200 && a.hits[1]?.auth === 'Bearer same-origin');
  b.hits.length = 0;
  await ssrf.safeFetch(`${base}/to?${encodeURIComponent(`http://127.0.0.1:${b.port}/`)}`, { headers: { authorization: 'Bearer secret', 'x-api-key': 'k' } });
  ok('cross-origin redirect drops every credential header', b.hits.length === 1 && b.hits[0].auth === '');
  a.hits.length = 0;
  await ssrf.safeFetch(`${base}/see-other`, { method: 'POST', body: '{"q":1}', headers: { 'content-type': 'application/json' } });
  ok('303 after POST continues as a body-less GET', a.hits[1]?.method === 'GET' && a.hits[1]?.body === '');

  // a real Postgres, when one is configured: refused, then allowlisted and working through the pin
  if (process.env.DATABASE_URL) {
    const u = new URL(process.env.DATABASE_URL);
    const values = { host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1), user: decodeURIComponent(u.username) };
    const secrets = { password: decodeURIComponent(u.password) };
    process.env.SSRF_ALLOW = '';
    const no = await run.listTables('postgres', values, secrets, QUICK);
    ok('real Postgres on localhost: refused without SSRF_ALLOW', !no.ok && /^Refused/.test(no.error), JSON.stringify(no));
    process.env.SSRF_ALLOW = '127.0.0.0/8,::1/128';
    const yes = await run.runConnection('postgres', values, secrets, { query: 'select 42 as answer' });
    ok('real Postgres on localhost: works once allowlisted', yes.ok && yes.result.rows[0]?.[0] === 42, JSON.stringify(yes));
  } else {
    console.log('skip real Postgres check (DATABASE_URL unset)');
  }

  for (const s of [a, b, ch, tcp]) s.close();
}

main().then(finish, (e) => { console.error(e); process.exit(1); });
