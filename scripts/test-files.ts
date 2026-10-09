// Self-check for file upload/download (src/server/files.ts) and the one import
// converted to it (dataset:pickAndParse in src/ipc/datasetImport.ts), over REAL
// HTTP in server mode:
//
//   upload a CSV (multipart) → import it over RPC with the token → the dataset
//   exists with the right rows → the token is dead and its file gone; tokens are
//   org- and user-bound and expire; an oversize upload is 413 and cut off before
//   the client finishes sending; a download works once with safe headers; no
//   token ever reaches the log.
//
//   npm run build:ts && node scripts/test-files.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf, CSRF_TOKEN } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const http: typeof import('http') = require('http');
const net: typeof import('net') = require('net');
const { Writable }: typeof import('stream') = require('stream');

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const files: typeof import('../src/server/files') = require('../src/server/files');
const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const appPaths: typeof import('../src/app/paths') = require('../src/app/paths');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-files-'));
const MAX_MB = 2;
const as = (org: string, user = `${org}@test`): import('../src/server/context').Identity =>
  ({ user: { email: user, role: 'admin' }, org: { id: org } });
const tempOf = (org: string) => path.join(DATA, 'orgs', org, 'temp');
const uploadsIn = (org: string) => (fs.existsSync(tempOf(org)) ? fs.readdirSync(tempOf(org)).filter((f) => f.startsWith('upload-')) : []);
const settle = () => new Promise((r) => setTimeout(r, 50)); // fs.rm in forget() is async

let clock = Date.now();
let log = '';
const logSink = new Writable({ write(chunk, _enc, cb) { log += String(chunk); cb(); } });

(async () => {
  // ── Pure helpers ──────────────────────────────────────────────────────────
  ok('displayName drops any path', files.displayName('../../etc/sales.csv') === 'sales.csv' && files.displayName('C:\\x\\y.csv') === 'y.csv');
  ok('displayName drops control characters', files.displayName('a\r\nb\u0000.csv') === 'ab.csv');
  ok('displayName never yields "", "." or ".."', ['', '..', '/', '\r\n'].every((n) => files.displayName(n) === 'file'));
  ok('displayName drops a lone surrogate', files.displayName('a\uD800b.csv') === 'ab.csv');
  const evil = files.displayName('rapport "Q1"\r\nSet-Cookie: x=1 — é.csv');
  const cd = files.contentDisposition(evil);
  ok('contentDisposition: ASCII fallback + RFC 8187 filename*', cd === `attachment; filename="rapport _Q1_Set-Cookie: x=1 _ _.csv"; filename*=UTF-8''rapport%20%22Q1%22Set-Cookie%3A%20x%3D1%20%E2%80%94%20%C3%A9.csv`, cd);
  ok('maskFileToken masks only the token segment', files.maskFileToken('/api/files/abc?x=1') === '/api/files/[redacted]?x=1' && files.maskFileToken('/api/rpc/x') === '/api/rpc/x');

  // ── Server mode, real HTTP ────────────────────────────────────────────────
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  files.resetForTest(() => clock);
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'info', DATA_DIR: DATA, MAX_UPLOAD_MB: String(MAX_MB) }), logSink, (h) =>
    typeof h['x-test-org'] === 'string' ? as(h['x-test-org'], typeof h['x-test-user'] === 'string' ? h['x-test-user'] : undefined) : null);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as import('net').AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const hdr = (org: string, user?: string) => withCsrf({ 'x-test-org': org, ...(user ? { 'x-test-user': user } : {}) });

  const upload = async (org: string, name: string, body: string) => {
    const form = new FormData();
    form.append('file', new Blob([body], { type: 'text/csv' }), name);
    const res = await fetch(`${base}/api/files`, { method: 'POST', body: form, headers: hdr(org) });
    return { status: res.status, json: (await res.json()) as { fileToken: string; name: string; size: number } };
  };
  const call = async (org: string, channel: string, payload: unknown, user?: string) => {
    const res = await fetch(`${base}/api/rpc/${channel}`, {
      method: 'POST', body: wire.encode({ args: [payload] }), headers: { 'content-type': 'application/json', ...hdr(org, user) },
    });
    return { status: res.status, body: wire.decode(await res.text()) as any }; // any: each channel's own reply
  };

  const ROWS = Array.from({ length: 250 }, (_, i) => [String(i).padStart(3, '0'), i * 1.5, `r${i}`]);
  const CSV = 'zip,amount,label\n' + ROWS.map((r) => r.join(',')).join('\n') + '\n';

  // Upload
  const up = await upload('org-a', '../../etc/orders.csv', CSV);
  ok('upload: 200 with { fileToken, name, size }', up.status === 200 && typeof up.json.fileToken === 'string' && up.json.size === Buffer.byteLength(CSV), JSON.stringify(up.json));
  ok('upload: the token is 32 random bytes, base64url', /^[A-Za-z0-9_-]{43}$/.test(up.json.fileToken));
  ok('upload: the client name is display-only and path-free', up.json.name === 'orders.csv');
  const onDisk = uploadsIn('org-a');
  ok('upload: bytes landed as upload-<hex> in org-a\'s temp, nowhere else', onDisk.length === 1 && /^upload-[0-9a-f]{32}$/.test(onDisk[0])
    && fs.readFileSync(path.join(tempOf('org-a'), onDisk[0]), 'utf8') === CSV && !fs.existsSync(path.join(DATA, 'etc')), onDisk.join(','));

  // Wrong org / wrong user: refused, and the owner's token is NOT burned
  const tok = { fileToken: up.json.fileToken };
  const cross = await call('org-b', 'dataset:pickAndParse', tok);
  ok('org-b using org-a\'s token: refused', cross.status === 200 && cross.body.ok === false && !('preview' in cross.body), JSON.stringify(cross.body));
  const otherUser = await call('org-a', 'dataset:pickAndParse', tok, 'mallory@test');
  ok('another user in org-a: refused', otherUser.body.ok === false, JSON.stringify(otherUser.body));
  ok('…and the refusals left the file in place', uploadsIn('org-a').length === 1);

  // Import over RPC, then save and list
  const imp = await call('org-a', 'dataset:pickAndParse', tok);
  ok('import: dataset:pickAndParse with the token is ok', imp.status === 200 && imp.body.ok === true, JSON.stringify(imp.body).slice(0, 300));
  ok('import: fileName/sourceKind from the upload, no server path returned',
    imp.body.fileName === 'orders.csv' && imp.body.sourceKind === 'csv' && !('filePath' in imp.body) && !JSON.stringify(imp.body).includes(DATA));
  ok('import: the parse has every row and column', imp.body.preview?.rowCount === ROWS.length && imp.body.preview.columns.length === 3, JSON.stringify(imp.body.preview?.columns));
  await settle();
  ok('import: the uploaded file is deleted once the import is done', uploadsIn('org-a').length === 0, uploadsIn('org-a').join(','));

  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
  const pid = await context.runInContext(as('org-a'), 'seed', async () => (await projects.createProject('Files')).id);
  const saved = await context.runInContext(as('org-a'), 'save', async () => rpc.handlers.get('dataset:save')!({}, {
    projectId: pid, name: 'Orders', sourceKind: 'csv', stagedId: imp.body.preview.stagedId,
  })) as { id: string };
  const listed = await call('org-a', 'dataset:list', { projectId: pid });
  const row = (listed.body as { id: string; rowCount: number }[]).find((d) => d.id === saved.id);
  ok('dataset exists in org-a with the right row count', row?.rowCount === ROWS.length, JSON.stringify(listed.body));
  const full = await context.runInContext(as('org-a'), 'get', () => datasets.getDataset(pid, saved.id));
  ok('…and the right rows (zip "007" stays text)', JSON.stringify(full?.rows) === JSON.stringify(ROWS.map((r) => [r[0], r[1], r[2]])), JSON.stringify(full?.rows.slice(0, 3)));

  const again = await call('org-a', 'dataset:pickAndParse', tok);
  ok('second use of the token: refused', again.status === 200 && again.body.ok === false && typeof again.body.error === 'string', JSON.stringify(again.body));
  ok('a malformed token never reaches the handler: 400 from the contract', (await call('org-a', 'dataset:pickAndParse', { fileToken: '../x' })).status === 400);

  // Expiry: refused, file deleted; the sweep deletes an abandoned upload
  const old = await upload('org-a', 'old.csv', CSV);
  clock += files.TOKEN_TTL_MS;
  const expired = await call('org-a', 'dataset:pickAndParse', { fileToken: old.json.fileToken });
  await settle();
  ok('expired token: refused and its file deleted', expired.body.ok === false && uploadsIn('org-a').length === 0, JSON.stringify(expired.body));
  await upload('org-a', 'abandoned.csv', CSV);
  clock += files.TOKEN_TTL_MS - 1;
  files.sweep();
  ok('sweep: an upload younger than an hour stays', uploadsIn('org-a').length === 1);
  clock += 1;
  files.sweep();
  await settle();
  ok('sweep: an hour-old abandoned upload is deleted', uploadsIn('org-a').length === 0);

  // Download
  const produced = context.runInContext(as('org-a'), 'export', () => {
    const p = path.join(appPaths.temp(), 'export-test.bin');
    fs.writeFileSync(p, 'a,b\n1,2\n');
    return { p, ...files.offerDownload(p, 'rapport "Q1"\r\nSet-Cookie: x=1 — é.csv') };
  });
  const dl = (org: string) => fetch(`${base}/api/files/${produced.downloadToken}`, { headers: hdr(org) });
  ok('download from org-b: 404', (await dl('org-b')).status === 404);
  const d1 = await dl('org-a');
  ok('download: 200 with the bytes', d1.status === 200 && (await d1.text()) === 'a,b\n1,2\n');
  ok('download: attachment, RFC 6266 filename, no injected header', d1.headers.get('content-disposition') === cd && d1.headers.get('set-cookie') === null, d1.headers.get('content-disposition'));
  ok('download: octet-stream, nosniff, no-store, content-length',
    d1.headers.get('content-type') === 'application/octet-stream' && d1.headers.get('x-content-type-options') === 'nosniff'
      && d1.headers.get('cache-control') === 'no-store' && d1.headers.get('content-length') === '8');
  await settle();
  ok('download: second fetch 404, and the file is deleted', (await dl('org-a')).status === 404 && !fs.existsSync(produced.p));

  // Oversize, streamed from a generator with no Content-Length (so only the
  // byte count can stop it). A browser stops sending once the 413 arrives; a
  // hostile client (a raw half-open socket, chunked) ignores the 413 and the
  // FIN and keeps writing, and must be cut off anyway.
  const TOTAL = 200 * 1024 * 1024;
  const CHUNK = Buffer.alloc(1024 * 1024, 120);
  const browserStream = () => new Promise<{ status: number | null; sent: number; rssGrowth: number }>((resolve) => {
    const rssBefore = process.memoryUsage().rss;
    let rssPeak = rssBefore;
    let sent = 0;
    let status: number | null = null;
    const B = 'xBOUNDARYx';
    const req = http.request(`${base}/api/files`, { method: 'POST', headers: { ...hdr('org-a'), 'content-type': `multipart/form-data; boundary=${B}` } });
    req.on('response', (res) => { status = res.statusCode ?? null; res.resume(); });
    req.on('close', () => resolve({ status, sent, rssGrowth: rssPeak - rssBefore }));
    req.on('error', () => {}); // EPIPE/ECONNRESET when the server hangs up: expected
    void (async () => {
      req.write(`--${B}\r\nContent-Disposition: form-data; name="file"; filename="big.csv"\r\nContent-Type: text/csv\r\n\r\n`);
      while (sent < TOTAL && !req.destroyed && status === null) {
        sent += CHUNK.length;
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
        if (!req.write(CHUNK)) {
          await new Promise<void>((r) => { const go = () => { req.off('drain', go); req.off('close', go); r(); }; req.on('drain', go); req.on('close', go); });
        }
      }
      // What a browser does with an early response: stop sending.
      if (status !== null) req.destroy();
      else if (!req.destroyed) req.end(`\r\n--${B}--\r\n`);
    })();
  });
  const hostileStream = () => new Promise<{ status: number | null; sent: number; rssGrowth: number }>((resolve) => {
    const rssBefore = process.memoryUsage().rss;
    let rssPeak = rssBefore;
    let sent = 0;
    let head = '';
    const B = 'xBOUNDARYx';
    const sock = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true });
    sock.on('data', (d) => { head += String(d); });
    sock.on('error', () => {});
    sock.on('close', () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]) || null, sent, rssGrowth: rssPeak - rssBefore }));
    const frame = (b: Buffer | string) => `${Buffer.byteLength(b).toString(16)}\r\n`;
    void (async () => {
      sock.write(`POST /api/files HTTP/1.1\r\nHost: x\r\nx-test-org: org-a\r\ncookie: ordinate_csrf=${CSRF_TOKEN}\r\nx-csrf-token: ${CSRF_TOKEN}\r\ntransfer-encoding: chunked\r\ncontent-type: multipart/form-data; boundary=${B}\r\n\r\n`);
      const first = `--${B}\r\nContent-Disposition: form-data; name="file"; filename="big.csv"\r\n\r\n`;
      sock.write(frame(first) + first + '\r\n');
      while (sent < TOTAL && !sock.destroyed && sock.writable) {
        sent += CHUNK.length;
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
        sock.write(frame(CHUNK));
        sock.write(CHUNK);
        if (!sock.write('\r\n')) {
          await new Promise<void>((r) => { const go = () => { sock.off('drain', go); sock.off('close', go); r(); }; sock.on('drain', go); sock.on('close', go); });
        }
      }
      sock.destroy();
    })();
  });
  const MB = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
  const polite = await browserStream();
  ok(`oversize, browser-like client: 413 after sending ${MB(polite.sent)} of ${MB(TOTAL)}`, polite.status === 413 && polite.sent < 32 * 1024 * 1024, JSON.stringify(polite));
  const hostile = await hostileStream();
  ok(`oversize, client that never stops: cut off after ${MB(hostile.sent)} of ${MB(TOTAL)}`, hostile.sent < 48 * 1024 * 1024, JSON.stringify(hostile));
  for (const [who, r] of [['browser-like', polite], ['never-stops', hostile]] as const) {
    ok(`oversize, ${who}: RSS grew ${MB(r.rssGrowth)}, not the body size`, r.rssGrowth < 64 * 1024 * 1024);
  }
  await settle();
  ok('oversize: no partial file left behind', uploadsIn('org-a').length === 0, uploadsIn('org-a').join(','));

  const declared = await new Promise<number | null>((resolve) => {
    const req = http.request(`${base}/api/files`, { method: 'POST', headers: { ...hdr('org-a'), 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(TOTAL) } });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? null); });
    req.on('error', () => resolve(null));
    req.write('--x\r\n'); // headers plus 5 bytes; the other 200 MB are never sent
  });
  ok('oversize (declared Content-Length): 413 before the body is read', declared === 413, declared);

  // Logs: requests were logged, tokens never
  const tokens = [up.json.fileToken, old.json.fileToken, produced.downloadToken];
  ok('log: the download URL is logged masked', log.includes('/api/files/[redacted]'));
  ok('log: no token appears anywhere in the log', tokens.every((t) => !log.includes(t)));

  await app.close();
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
