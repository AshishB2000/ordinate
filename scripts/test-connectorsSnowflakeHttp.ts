// Self-check for the Snowflake transport (src/connectors/snowflakeHttp.ts):
// the one socket the connector opens, driven against a local http server.
//
//   • the SSRF guard: loopback is refused (and the server never sees a
//     request) until SSRF_ALLOW opens it — the negative control for "every
//     socket goes through ssrf.ts"; a redirect is refused, never followed
//   • a gzip body (the SQL API compresses result partitions) is decoded, a
//     leading U+FEFF inside it kept; a decompression bomb stops at the ceiling
//   • the byte ceiling on the wire, the wall clock and the abort signal (the
//     socket is torn down, which the server sees)
//
//   npm run build:ts && node scripts/test-connectorsSnowflakeHttp.js

export {}; // module scope — sibling test scripts share top-level names
import * as http from 'http';
import { gzipSync } from 'zlib';
import { ok, finish } from './selfcheck';

const transport: typeof import('../src/connectors/snowflakeHttp') = require('../src/connectors/snowflakeHttp');
type Req = import('../src/connectors/snowflakeHttp').SfHttpRequest;

const MB = 1024 * 1024;
let served = 0;
let closed = 0;

const server = http.createServer((req, res) => {
  served++;
  req.on('close', () => closed++);
  const route = req.url ?? '/';
  if (route === '/json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ seen: { method: req.method, ua: req.headers['user-agent'], auth: req.headers.authorization } }));
  } else if (route === '/gzip') {
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(gzipSync(JSON.stringify({ data: [['\uFEFFAcme', '1']] })));
  } else if (route === '/bomb') {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    res.end(gzipSync(Buffer.alloc(64 * MB))); // ~64 KB on the wire
  } else if (route === '/big') {
    res.writeHead(200);
    res.end(Buffer.alloc(3 * MB, 0x61));
  } else if (route === '/redirect') {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  } else if (route === '/hang') {
    // never answers
  } else {
    res.writeHead(404);
    res.end();
  }
});

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as import('net').AddressInfo).port;
  const req = (path: string, extra: Partial<Req> = {}): Req => ({
    url: new URL(`http://127.0.0.1:${port}${path}`), method: 'GET', headers: { authorization: 'Bearer t0k3n' }, timeoutMs: 5_000, maxBytes: 8 * MB, ...extra,
  });
  const failure = async (r: Req): Promise<Error | null> => {
    try { await transport.snowflakeFetch(r); return null; } catch (e) { return e as Error; }
  };

  delete process.env.SSRF_ALLOW;
  const refused = await failure(req('/json'));
  ok('SSRF: loopback is refused before a socket opens (negative control: the server saw nothing)', refused?.name === 'SsrfError' && served === 0, refused?.message);
  process.env.SSRF_ALLOW = '127.0.0.1/32';

  const plain = await transport.snowflakeFetch(req('/json', { method: 'POST', body: '{}' }));
  const seen = JSON.parse(plain.body).seen;
  ok('with SSRF_ALLOW: answered; method, the Ordinate user agent and the bearer sent', plain.status === 200 && !plain.truncated && seen.method === 'POST' && seen.ua === 'Ordinate' && seen.auth === 'Bearer t0k3n');

  const gz = await transport.snowflakeFetch(req('/gzip'));
  ok('gzip: a compressed partition is decoded; a leading U+FEFF inside it survives', JSON.parse(gz.body).data[0][0] === '\uFEFFAcme' && !gz.truncated);

  const t0 = Date.now();
  const bomb = await transport.snowflakeFetch(req('/bomb', { maxBytes: 1 * MB }));
  ok('gzip bomb: 64 MB inflated is stopped at the 1 MB ceiling and reported truncated', bomb.truncated && bomb.body === '' && Date.now() - t0 < 3_000);

  const big = await transport.snowflakeFetch(req('/big', { maxBytes: 1 * MB }));
  ok('byte ceiling: a 3 MB body is clipped at 1 MB and reported truncated', big.truncated && big.body.length === MB);

  const redirect = await failure(req('/redirect'));
  ok('a redirect is refused, never followed (a bearer must not ride a hop)', redirect !== null && /redirect/i.test(redirect.message), redirect?.message);

  const closedBefore = closed;
  const t1 = Date.now();
  const late = await failure(req('/hang', { timeoutMs: 300 }));
  ok('timeout: SfAbortError("timeout") at the wall clock', late instanceof transport.SfAbortError && late.reason === 'timeout' && Date.now() - t1 < 2_000, late?.message);
  await new Promise((r) => setTimeout(r, 100));
  ok('timeout: the socket was torn down (the server saw it close)', closed > closedBefore);

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const t2 = Date.now();
  const cancelled = await failure(req('/hang', { signal: ac.signal }));
  ok('abort: SfAbortError("cancelled") when the caller gives up', cancelled instanceof transport.SfAbortError && cancelled.reason === 'cancelled' && Date.now() - t2 < 2_000, cancelled?.message);
}

main()
  .catch((err) => ok('suite ran to the end', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    server.closeAllConnections();
    server.close();
    finish();
  });
