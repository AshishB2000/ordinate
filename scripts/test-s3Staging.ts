// The org's staging area and the S3 calls it needs (src/server/staging.ts,
// src/engine/s3.ts; docs/any-pod/00-design.md §3.2).
//
//   1. a signed PUT of a multi-MB file to a local server that reads it slowly
//      (~3 s) completes: Content-Length sent, no chunked encoding, the payload
//      hash signed is the body's, every byte arrives — and no fetch timer
//      applies (it is http.request);
//   2. names and orgs: a place is only ever inside its own org — a name with a
//      separator, a `..`, an upper-case kind or an invalid org is refused, and
//      two orgs' keys and URLs differ only in the org segment;
//   3. against MinIO (STORAGE_URL=s3://, DATABASE_URL; else one skip line): a PUT
//      round-trips byte-identical through download and open; NEGATIVE CONTROL: a
//      body that is not what its sha256 says is refused by the store; a removed
//      object is gone (404).
//
//   npm run build:ts && node scripts/test-s3Staging.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { createHash, randomBytes } from 'crypto';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const http: typeof import('http') = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-s3staging-'));
const s3: typeof import('../src/engine/s3') = require('../src/engine/s3');
const storage: typeof import('../src/engine/storage') = require('../src/engine/storage');
const staging: typeof import('../src/server/staging') = require('../src/server/staging');
const context: typeof import('../src/server/context') = require('../src/server/context');
const s3Test: typeof import('./s3TestEnv') = require('./s3TestEnv');

type S3Env = import('../src/server/env').S3Env;
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const as = <T>(org: string, fn: () => T): T => context.runInContext({ user: { email: 'u@x.test', role: 'admin' }, org: { id: org } }, 't', fn);

async function slowPut(): Promise<void> {
  const body = randomBytes(4 * 1024 * 1024);
  const file = path.join(TMP, 'slow.bin');
  fs.writeFileSync(file, body);
  const seen: { length?: string; te?: string; hash?: string; got: Buffer[] } = { got: [] };
  const server = http.createServer((req, res) => {
    seen.length = req.headers['content-length'];
    seen.te = req.headers['transfer-encoding'];
    seen.hash = req.headers['x-amz-content-sha256'] as string;
    req.on('data', (c: Buffer) => {
      seen.got.push(c);
      req.pause();
      setTimeout(() => req.resume(), 45); // ~64 KB per 45 ms: a slow link
    });
    req.on('end', () => res.end());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as import('net').AddressInfo).port;
  const cfg: S3Env = { bucket: 'b', prefix: '', region: 'us-east-1', endpoint: `127.0.0.1:${port}`, useSsl: false, extensionDir: null };
  const t0 = Date.now();
  const status = await s3.putWithCreds(cfg, 'orgs/acme/staging/upload-x', file, sha(body), body.length, { keyId: 'AKIAFAKE', secret: 'fake', token: '' });
  const ms = Date.now() - t0;
  server.close();
  const got = Buffer.concat(seen.got);
  ok(`a slow 4 MB PUT completes (${ms} ms): 200, every byte, the same bytes`, status === 200 && got.length === body.length && got.equals(body), [status, got.length]);
  ok('…with Content-Length and no chunked encoding (S3 refuses chunked)', seen.length === String(body.length) && seen.te === undefined, JSON.stringify(seen.length) + ' ' + seen.te);
  ok('…and the payload hash it signed is the body\'s sha256, not UNSIGNED-PAYLOAD', seen.hash === sha(body));
  ok('a slow link really was slow (the test proves no short timer cut it)', ms > 2_000, ms);
}

/** Review L3: a PUT whose server stops reading and never answers is abandoned at the stall limit, its file closed. */
async function stalledPut(): Promise<void> {
  const body = randomBytes(8 * 1024 * 1024);
  const file = path.join(TMP, 'stalled.bin');
  fs.writeFileSync(file, body);
  const server = http.createServer((req) => { req.pause(); }); // reads nothing, answers nothing
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as import('net').AddressInfo).port;
  const cfg: S3Env = { bucket: 'b', prefix: '', region: 'us-east-1', endpoint: `127.0.0.1:${port}`, useSsl: false, extensionDir: null };
  s3.setPutIdleForTest(400);
  const t0 = Date.now();
  const r = await s3.putWithCreds(cfg, 'k', file, sha(body), body.length, { keyId: 'AKIAFAKE', secret: 'fake', token: '' }).then((s) => `status ${s}`, (e: Error) => e.message);
  const ms = Date.now() - t0;
  s3.setPutIdleForTest(120_000);
  server.closeAllConnections();
  server.close();
  ok(`a stalled PUT is abandoned at the stall limit (${ms} ms), not left hanging`, r === 'S3 PUT stalled' && ms < 5_000, r);
}

function names(): void {
  const refused = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };
  ok('a name with a separator, a `..`, an upper-case kind or no id is refused',
    ['upload-../../x', 'a/b', '../upload-' + 'a'.repeat(32), 'UPLOAD-' + 'a'.repeat(32), 'upload', 'stage-' + 'a'.repeat(36) + '.parquet/x'].every((n) => refused(() => staging.checkName(n))));
  ok('control: server-made names pass', ['upload-' + 'ab'.repeat(16), 'stage-0f0e0d0c-0b0a-4090-8070-605040302010.parquet', 'export-0f0e0d0c-0b0a-4090-8070-605040302010.ordinate'].every((n) => !refused(() => staging.checkName(n))));
  ok('an org id that is not a slug is refused', refused(() => staging.placeIn('../evil', 'upload-' + 'ab'.repeat(16))) && refused(() => staging.placeIn('Acme', 'upload-' + 'ab'.repeat(16))));
  const cfg: S3Env = { bucket: 'bkt', prefix: 'pre', region: 'us-east-1', endpoint: '127.0.0.1:1', useSsl: false, extensionDir: null };
  storage.configure(path.join(TMP, 'data'), cfg, 0);
  const name = 'upload-' + 'cd'.repeat(16);
  const [a, b] = [as('acme', () => staging.here(name)), as('globex', () => staging.here(name))];
  ok('the org comes from the request: acme\'s and globex\'s places differ only there',
    staging.s3Key(a) === `pre/orgs/acme/staging/${name}` && staging.s3Key(b) === `pre/orgs/globex/staging/${name}`
      && staging.parquetTarget(a) === `s3://bkt/pre/orgs/acme/staging/${name}`, staging.s3Key(a) + ' ' + staging.s3Key(b));
  storage.configure(path.join(TMP, 'data'), null, 0);
}

async function minio(t: import('./s3TestEnv').S3Test): Promise<void> {
  const body = randomBytes(3 * 1024 * 1024 + 17);
  const file = path.join(TMP, 'up.bin');
  fs.writeFileSync(file, body);
  const key = `${t.s3.prefix}/orgs/acme/staging/upload-${'ef'.repeat(16)}`;
  await s3.put(t.s3, key, file, sha(body), body.length);
  const back = path.join(TMP, 'back.bin');
  await s3.download(t.s3, key, back);
  ok('MinIO: a signed PUT round-trips byte-identical through download', fs.readFileSync(back).equals(body));
  const o = await s3.open(t.s3, key);
  const chunks: Buffer[] = [];
  for await (const c of o.body) chunks.push(c as Buffer);
  ok('MinIO: …and through a streamed open, with its size', Buffer.concat(chunks).equals(body) && o.size === body.length);
  const wrong = await s3.put(t.s3, key + '-x', file, sha(Buffer.from('not the body')), body.length).then(() => 'stored', (e: Error) => e.message);
  ok('NEGATIVE CONTROL: a body that is not what its sha256 says is refused by the store', wrong !== 'stored' && /HTTP 4\d\d/.test(wrong), wrong);
  await s3.remove(t.s3, key);
  const gone = await s3.open(t.s3, key).then(() => 0, (e: { status?: number }) => e.status ?? -1);
  ok('MinIO: a removed object is gone (404)', gone === 404, gone);
}

(async () => {
  await slowPut();
  await stalledPut();
  names();
  const t = await s3Test.setup('staging');
  if (typeof t === 'string') {
    console.log(`skip MinIO staging checks: ${t}`);
    return;
  }
  try {
    await minio(t);
  } finally {
    await t.teardown();
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    finish();
  });
