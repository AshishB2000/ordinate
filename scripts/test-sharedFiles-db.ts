// The S3 side of shared file tokens, in-process against a fake S3 (src/server/sharedFiles.ts;
// docs/any-pod/00-design.md §3.1–3.2, refutation findings 2, 8 and 11):
//
//   1. a token is issued row-first, its bytes PUT, and this pod keeps a local copy;
//   2. a TRANSIENT S3 failure (503, retried once) does not burn the token: the take
//      is undone, and the next take works and gets the bytes;
//      control: a 404 (the bytes are gone) leaves the token spent;
//   3. a failed PUT deletes its row;
//   4. local copies: one whose token was taken on another pod is dropped by the
//      60 s pass; one held by an open Upload is kept even past its expiry, and goes
//      when its holder finishes; control: one still waiting is kept.
//
// Needs DATABASE_URL and DuckDB's aws extension (the S3 credential chain); else one skip line.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-sharedFiles-db.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { createHash, randomBytes } from 'crypto';
import * as H from './podHarness';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const http: typeof import('http') = require('http');

const context: typeof import('../src/server/context') = require('../src/server/context');
const storage: typeof import('../src/engine/storage') = require('../src/engine/storage');
const tokens: typeof import('../src/server/fileTokens') = require('../src/server/fileTokens');
const shared: typeof import('../src/server/sharedFiles') = require('../src/server/sharedFiles');
const staging: typeof import('../src/server/staging') = require('../src/server/staging');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-sharedfiles-'));
const ACME = { user: { email: 'u1@acme.test', role: 'admin' as const }, org: { id: 'acme' } };
const as = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(ACME, 't', fn);
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** A fake S3: PUT stores, DELETE forgets, GET answers per `mode`. */
function fakeS3() {
  const objects = new Map<string, Buffer>();
  const seen = { gets: 0, puts: 0, deletes: 0 };
  const state = { mode: 'ok' as 'ok' | '503' | '404', putStatus: 200, putFailures: Infinity, putDelayMs: 0 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const key = decodeURIComponent(req.url ?? '');
      if (req.method === 'PUT' && state.putDelayMs > 0) {
        const wait = state.putDelayMs;
        state.putDelayMs = 0;
        setTimeout(() => { objects.set(key, Buffer.concat(chunks)); seen.puts++; res.end(); }, wait);
        return;
      }
      if (req.method === 'PUT') {
        seen.puts++;
        const status = state.putStatus !== 200 && state.putFailures > 0 ? state.putStatus : 200;
        if (status !== 200) state.putFailures--;
        if (status === 200) objects.set(key, Buffer.concat(chunks));
        res.statusCode = status;
        return res.end();
      }
      if (req.method === 'DELETE') {
        seen.deletes++;
        objects.delete(key);
        res.statusCode = 204;
        return res.end();
      }
      seen.gets++;
      const body = objects.get(key);
      if (state.mode === '503') { res.statusCode = 503; return res.end(); }
      if (state.mode === '404' || !body) { res.statusCode = 404; return res.end(); }
      res.setHeader('content-length', body.length);
      res.end(body);
    });
  });
  return { server, objects, seen, state };
}

(async () => {
  const extDir = process.env.DUCKDB_EXTENSION_DIR ?? path.resolve(__dirname, '..', '.duckdb-extensions');
  const db = await H.scratchDb('sharedfiles');
  if (!db || !fs.existsSync(extDir)) {
    console.log(`skip shared-file S3 checks: ${!db ? 'DATABASE_URL is unset' : 'no DuckDB extension dir for the S3 credential chain'}`);
    if (db) await db.drop();
    return finish();
  }
  process.env.AWS_ACCESS_KEY_ID ??= 'AKIAFAKE';
  process.env.AWS_SECRET_ACCESS_KEY ??= 'fake-secret';
  const s3 = fakeS3();
  await new Promise<void>((r) => s3.server.listen(0, '127.0.0.1', r));
  try {
    await mig.migrate(db.pool);
    context.enterServerMode(DATA);
    tokens.useFileTokenDb(db.pool);
    const port = (s3.server.address() as import('net').AddressInfo).port;
    storage.configure(DATA, { bucket: 'b', prefix: 'p', region: 'us-east-1', endpoint: `127.0.0.1:${port}`, useSsl: false, extensionDir: extDir }, 0);

    const newFile = (): { file: string; body: Buffer } => {
      const body = randomBytes(2048);
      const file = path.join(staging.tempDir('acme'), `upload-${randomBytes(16).toString('hex')}`);
      fs.writeFileSync(file, body);
      return { file, body };
    };
    const hasObject = (file: string): boolean => [...s3.objects.keys()].some((k) => k.endsWith('/' + path.basename(file)));
    const rowUsed = async (token: string): Promise<Date | null | 'gone'> => {
      const r = (await db.pool.query<{ used_at: Date | null }>('SELECT used_at FROM file_tokens WHERE token_hash = $1', [tokens.hashOf(token)])).rows[0];
      return r ? r.used_at : 'gone';
    };

    // 1. Issue: row, PUT, local copy.
    const one = newFile();
    const t1 = await as(() => shared.issue('upload', one.file, 'one.csv', one.body.length, 3_600_000, sha(one.body)));
    const hex1 = tokens.hashOf(t1).toString('hex');
    ok('issue: the row is written, the bytes PUT, and this pod keeps its copy', s3.seen.puts === 1 && (await rowUsed(t1)) === null && shared.copiesForTest().has(hex1));

    // 2. A transient GET failure does not burn the token.
    fs.rmSync(one.file); // as if the take landed on another pod: it must GET
    s3.state.mode = '503';
    const gets0 = s3.seen.gets;
    const failed = await as(async () => { const t = await shared.take(t1, 'upload'); return shared.localFile(t).then(() => 'got', (e: unknown) => (e instanceof shared.NoToken ? 'NoToken' : String(e))); });
    ok('a 503 is retried once, then the take is UNDONE: the token is unused again', failed === 'NoToken' && s3.seen.gets - gets0 === 2 && (await rowUsed(t1)) === null, JSON.stringify({ failed, gets: s3.seen.gets - gets0 }));
    s3.state.mode = 'ok';
    const again = await as(async () => { const t = await shared.take(t1, 'upload'); const l = await shared.localFile(t); const bytes = fs.readFileSync(l.file); shared.finish(t, l); return bytes; });
    ok('…so the next take works, with the same bytes', again.equals(one.body));
    const cleaned = await H.until(async () => (await rowUsed(t1)) === 'gone' && !s3.objects.size, 3_000);
    ok('…and finishing it deletes the object, then the row', cleaned);

    const two = newFile();
    const t2 = await as(() => shared.issue('upload', two.file, 'two.csv', two.body.length, 3_600_000, sha(two.body)));
    fs.rmSync(two.file);
    s3.state.mode = '404';
    await as(async () => { const t = await shared.take(t2, 'upload'); return shared.localFile(t).catch(() => null); });
    ok('control: a 404 (the bytes are gone) leaves the token spent', (await rowUsed(t2)) instanceof Date);
    s3.state.mode = 'ok';

    // 2b. A download whose GET fails for a moment is not destroyed (review M2): the take is undone, the bytes kept.
    const dl = newFile();
    const tdl = await as(() => shared.issue('download', dl.file, 'export.zip', dl.body.length, 3_600_000, sha(dl.body)));
    fs.rmSync(dl.file); // taken on another pod: it must GET
    s3.state.mode = '503';
    const flaky = await as(async () => { const t = await shared.take(tdl, 'download'); return shared.openTaken(t).then(() => 'opened', (e: unknown) => (e instanceof shared.TryAgain ? 'TryAgain' : e instanceof shared.NoToken ? 'NoToken' : String(e))); });
    ok('a download\'s GET failing twice (503) answers try-again: the take is undone and its bytes are still in the store', flaky === 'TryAgain' && (await rowUsed(tdl)) === null && hasObject(dl.file), JSON.stringify({ flaky, objects: [...s3.objects.keys()] }));
    s3.state.mode = 'ok';
    const later = await as(async () => { const t = await shared.take(tdl, 'download'); const o = await shared.openTaken(t); const parts: Buffer[] = []; for await (const c of o.body) parts.push(c as Buffer); shared.finish(t); return Buffer.concat(parts); });
    ok('…so the same link then downloads the very bytes', later.equals(dl.body));
    ok('…and then its object goes', await H.until(() => !hasObject(dl.file), 3_000));

    // 3. A PUT that fails once is retried (review M5); one that keeps failing deletes its row AND its file.
    s3.state.putStatus = 500;
    s3.state.putFailures = 1;
    const once = newFile();
    const puts0 = s3.seen.puts;
    const retried = await as(() => shared.issue('download', once.file, 'once.zip', once.body.length, 3_600_000, sha(once.body)).then(() => 'issued', () => 'refused'));
    ok('a PUT that fails once (500) is retried, and the offer stands', retried === 'issued' && s3.seen.puts - puts0 === 2 && hasObject(once.file), JSON.stringify({ retried, puts: s3.seen.puts - puts0 }));
    s3.state.putFailures = Infinity;
    const three = newFile();
    const putFailed = await as(() => shared.issue('download', three.file, 'three.zip', three.body.length, 3_600_000, sha(three.body)).then(() => 'issued', () => 'refused'));
    const rows = Number((await db.pool.query(`SELECT count(*) AS n FROM file_tokens WHERE name = 'three.zip'`)).rows[0].n);
    ok('a PUT that keeps failing refuses the offer and leaves nothing: no row, no file (row first, then the bytes)', putFailed === 'refused' && rows === 0 && !fs.existsSync(three.file), JSON.stringify({ putFailed, rows, file: fs.existsSync(three.file) }));
    s3.state.putStatus = 200;
    s3.state.putFailures = 0;

    // 3b. The token's hour starts once its bytes have landed, not before a slow PUT (review L2).
    s3.state.putDelayMs = 1_500;
    const slow = newFile();
    const tslow = await as(() => shared.issue('upload', slow.file, 'slow.csv', slow.body.length, 10_000, sha(slow.body)));
    s3.state.putDelayMs = 0;
    const left = Number((await db.pool.query(`SELECT extract(epoch FROM expires_at - now()) * 1000 AS ms FROM file_tokens WHERE token_hash = $1`, [tokens.hashOf(tslow)])).rows[0].ms);
    ok(`a token whose PUT took 1.5 s still has its whole 10 s once issued (${Math.round(left)} ms left)`, left > 9_000, left);

    // 4. Local copies.
    const [a, b, c] = [newFile(), newFile(), newFile()];
    const [ta, tb, tc] = await as(() => Promise.all([a, b, c].map((x, i) => shared.issue('upload', x.file, `c${i}.csv`, x.body.length, 3_600_000, sha(x.body)))));
    await db.pool.query('UPDATE file_tokens SET used_at = now() WHERE token_hash = $1', [tokens.hashOf(ta)]); // taken on another pod
    const held = await as(async () => { const t = await shared.take(tb, 'upload'); return { t, l: await shared.localFile(t) }; });
    await shared.sweepCopies(Date.now());
    ok('the 60 s pass drops a copy whose token was taken on another pod', !fs.existsSync(a.file) && !shared.copiesForTest().has(tokens.hashOf(ta).toString('hex')));
    ok('control: …and keeps one whose token still waits', fs.existsSync(c.file) && shared.copiesForTest().has(tokens.hashOf(tc).toString('hex')));
    await shared.sweepCopies(Date.now() + 2 * 3_600_000); // both b and c are past their expiry now
    ok('past its expiry an unheld copy goes, but one held by an open Upload stays (refcount)', !fs.existsSync(c.file) && held.l.held && fs.existsSync(b.file));
    shared.finish(held.t, held.l);
    ok('…and goes once its holder finishes', await H.until(() => !fs.existsSync(b.file), 2_000));
  } finally {
    tokens.useFileTokenDb(null);
    storage.configure(DATA, null, 0);
    s3.server.close();
    await db.drop();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
  finish();
})().catch((err) => {
  ok('the suite ran to the end', false, err instanceof Error ? err.stack : err);
  finish();
});
