// Files over HTTP: what replaces the desktop app's open and save dialogs.
//
//   POST /api/files         multipart, ONE file, streamed to the org's temp()
//                           and never held in memory; capped at MAX_UPLOAD_MB,
//                           or lower when the org's admin set a lower cap.
//                           Replies { fileToken, name, size }. A handler takes
//                           the token instead of a path: `resolveUpload(token)`.
//   GET  /api/files/:token  streams a file a handler produced and handed over
//                           with `offerDownload(filePath, name)`.
//
// A token is 32 random bytes, bound to the org AND user that got it, single
// use, and dead after an hour. Its file is deleted once the token is done with
// (an upload's handler calls `done()`, a download is deleted after it is sent)
// or by the sweep when it expires. A wrong org, a used token and an expired one
// all look the same to the caller as an unknown one — no existence oracle.
//
// ANY POD (docs/any-pod/00-design.md). With DATABASE_URL a token is a row and
// its bytes are in the org's staging area (./sharedFiles.ts): the shared
// DATA_DIR, or S3 — so the upload, the RPC that uses it and the download can
// each land on a different pod. Without it (one process) the Map below.
//
// The client's filename is display text only: it never becomes a path. The
// file on disk is `upload-<random hex>` in the org's temp directory.
//
// Must load without @fastify/multipart until the routes are registered —
// src/ipc/datasetImport.ts imports `resolveUpload`.

import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as appPaths from '../app/paths';
import { ctx } from './context';
import * as tokens from './fileTokens';
import * as shared from './sharedFiles';
import * as staging from './staging';
import * as stageStore from '../data/stageStore';

export const TOKEN_TTL_MS = 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 1000;
// Multipart framing around the file: boundary lines and the part's headers.
// A declared Content-Length beyond cap + this is refused before a byte is read.
const FRAMING_SLACK = 64 * 1024;
// After a 413 the rest of the body is read and DISCARDED for at most this
// long / this much, then the socket is dropped (see tooLarge).
const LINGER_MS = 2000;
const LINGER_BYTES = 16 * 1024 * 1024;
// One S3 PUT carries at most 5 GiB: with S3 storage no upload may be larger.
const S3_PUT_MAX_MB = 5120;

type Reason = 'unknown' | 'forbidden' | 'used' | 'expired';

/** A token that cannot be used. `reason` is for logs and tests; the message is the same for all. */
export class FileTokenError extends Error {
  constructor(readonly reason: Reason) {
    super('This file has expired or was already used. Upload it again.');
    this.name = 'FileTokenError';
  }
}

interface Entry {
  readonly kind: 'upload' | 'download';
  readonly org: string;
  readonly user: string;
  readonly path: string;
  readonly name: string;
  readonly expires: number;
  used: boolean;
}

// Without a database: this process's tokens (there is one process).
const entries = new Map<string, Entry>();
let now = (): number => Date.now();

function issue(kind: Entry['kind'], filePath: string, name: string): string {
  const { org, user } = ctx();
  const token = randomBytes(32).toString('base64url');
  entries.set(token, { kind, org: org.id, user: user.email, path: filePath, name, expires: now() + TOKEN_TTL_MS, used: false });
  return token;
}

/** Drops a token and deletes its file. */
function forget(token: string): void {
  const e = entries.get(token);
  if (!e) return;
  entries.delete(token);
  fs.rm(e.path, { force: true }, () => {});
}

/** Marks a token used and returns it, or throws. A wrong caller does NOT burn the owner's token. */
function take(token: unknown, kind: Entry['kind']): Entry {
  const e = typeof token === 'string' ? entries.get(token) : undefined;
  if (!e || e.kind !== kind) throw new FileTokenError('unknown');
  const { org, user } = ctx();
  if (e.org !== org.id || e.user !== user.email) throw new FileTokenError('forbidden');
  if (now() >= e.expires) {
    forget(token as string);
    throw new FileTokenError('expired');
  }
  if (e.used) throw new FileTokenError('used');
  e.used = true;
  return e;
}

export interface Upload {
  /** A LOCAL file holding the uploaded bytes, on this pod's filesystem (positioned reads are fine). Read it; never move, keep or delete it. */
  readonly path: string;
  /** The client's filename, sanitized — for display and its extension only. */
  readonly name: string;
  /** Deletes the file, the shared bytes and the token. Call it when finished (in a `finally`); never throws; the sweep is only the backstop. */
  done(): void;
}

/** The upload behind `token`, for the current request's org and user, as a local file. Throws FileTokenError. */
export async function resolveUpload(token: unknown): Promise<Upload> {
  if (!tokens.dbOn()) {
    const e = take(token, 'upload');
    return { path: e.path, name: e.name, done: () => forget(token as string) };
  }
  let t: shared.Taken;
  let local: Awaited<ReturnType<typeof shared.localFile>>;
  try {
    t = await shared.take(token, 'upload');
    local = await shared.localFile(t);
  } catch (err) {
    if (err instanceof shared.NoToken) throw new FileTokenError('unknown');
    throw err;
  }
  let finished = false;
  return { path: local.file, name: t.name, done: () => { if (!finished) { finished = true; shared.finish(t, local); } } };
}

/**
 * Hands a server-produced file to the browser: the reply carries the token, the
 * browser fetches GET /api/files/<token>. The file is the server's to DELETE
 * after it is sent (or when the token expires), so write it to temp() — with
 * a database it MUST be directly in the caller's org temp(), named like
 * `export-<uuid>.ordinate`. `sha256` (hex), when the caller hashed the bytes as
 * it wrote them, saves a second read before an S3 upload.
 */
export async function offerDownload(filePath: string, name: string, sha256?: string): Promise<{ downloadToken: string }> {
  const file = path.resolve(filePath);
  if (!tokens.dbOn()) return { downloadToken: issue('download', file, displayName(name)) };
  if (path.dirname(file) !== path.resolve(appPaths.temp())) throw new Error('offerDownload: the file must be in the org temp directory');
  const { size } = await fs.promises.stat(file);
  return { downloadToken: await shared.issue('download', file, displayName(name), size, TOKEN_TTL_MS, sha256) };
}

// A USED upload may still be read by a job (a restore runs longer than the
// token's hour); its handler deletes it (`done()`). The sweep leaves it a day —
// in the Map here, and in Postgres (`fileTokens.USED_GRACE_MS`, the same day).
const USED_GRACE_MS = 24 * 60 * 60 * 1000;

/** Expires old tokens and deletes their files (with a database: this pod's local copies). Runs every minute while the server is up. */
export function sweep(): void {
  const t = now();
  for (const [token, e] of entries) if (t >= e.expires + (e.used ? USED_GRACE_MS : 0)) forget(token);
  void shared.sweepCopies().catch(() => undefined);
  stageStore.pruneMemory(); // a staged import nobody saved leaves this pod's heap with its TTL
}

/**
 * Boot: what a crash left in every org's temp dir — a bundle's staging, a
 * restore's or a backup's file, an export not yet downloaded — once a day old,
 * so a sibling pod's live file on a shared volume is never touched. Returns how
 * many went.
 */
export function sweepLeftovers(dataDir: string, olderThanMs = USED_GRACE_MS): number {
  let n = 0;
  const cutoff = Date.now() - olderThanMs;
  let orgs: string[] = [];
  try { orgs = fs.readdirSync(path.join(dataDir, 'orgs')); } catch { return 0; }
  for (const org of orgs) {
    const temp = path.join(dataDir, 'orgs', org, 'temp');
    let names: string[] = [];
    try { names = fs.readdirSync(temp); } catch { continue; }
    for (const name of names) {
      if (!/^(bundle|restore|backup|export)-/.test(name)) continue;
      const p = path.join(temp, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) {
          fs.rmSync(p, { recursive: true, force: true });
          n++;
        }
      } catch { /* gone meanwhile */ }
    }
  }
  return n;
}

/** A client-supplied filename made safe to show and to put in a header: no path, no control characters. */
export function displayName(raw: string | undefined): string {
  const base = (raw ?? '').split(/[/\\]/).pop() ?? '';
  const clean = base.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '').trim().slice(0, 200)
    // A lone surrogate (or one cut in half by the slice) would make encodeURIComponent throw.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  return clean === '' || clean === '.' || clean === '..' ? 'file' : clean;
}

/** RFC 6266: an ASCII `filename` fallback plus the exact name as RFC 8187 `filename*`. `name` is a displayName(). */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const exact = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${exact}`;
}

/** URL with any file token masked — what the request logger writes. */
export function maskFileToken(url: string): string {
  return url.replace(/^(\/api\/files\/)[^/?#]+/, '$1[redacted]');
}

function tooLarge(req: FastifyRequest, reply: FastifyReply, maxMb: number): FastifyReply {
  // A lingering close, as nginx does it. Closing a socket the client is still
  // writing to makes the kernel send a reset, and the client can lose the 413
  // with it. So: read and discard what is still arriving (nothing is kept),
  // half-close once the 413 is out, and drop the socket after LINGER_MS or
  // LINGER_BYTES — a client that never stops sending is cut off there.
  // No `connection: close` header: with it Node destroys the socket at once.
  const sock = req.raw.socket;
  let discarded = 0;
  req.raw.on('data', (chunk: Buffer) => {
    if ((discarded += chunk.length) > LINGER_BYTES) sock.destroy();
  });
  req.raw.resume();
  reply.raw.once('finish', () => {
    sock.end();
    setTimeout(() => sock.destroy(), LINGER_MS).unref();
  });
  return reply.code(413).send({ error: 'file too large', maxMb });
}

/**
 * A file route whose failure answers a bare 500 — never the error's message, which can carry a
 * server path or a storage URL (review L5). The message goes to the log only.
 */
function guarded<R extends FastifyRequest>(what: 'upload' | 'download', fn: (req: R, reply: FastifyReply) => Promise<unknown>) {
  return async (req: R, reply: FastifyReply): Promise<unknown> => {
    try {
      return await fn(req, reply);
    } catch (err) {
      req.log.error({ err }, `file ${what} failed`);
      if (reply.sent) return reply;
      return reply.code(500).send({ error: `${what} failed` });
    }
  };
}

/**
 * Registers the multipart parser and both routes on `app`. Uploads above the
 * cap get 413: `ceilingMb` (MAX_UPLOAD_MB) is the ceiling, and `capMb()` — the
 * caller's org cap (Admin → Settings, T3.4), asked per upload — may only lower it.
 */
export function registerFileRoutes(app: FastifyInstance, ceilingMb: number, capMb: () => Promise<number> = async () => ceilingMb): void {
  const ceilingBytes = ceilingMb * 1024 * 1024;
  shared.useFilesLog(app.log);
  // Lazy: only the server needs the multipart parser.
  void app.register((require('@fastify/multipart') as typeof import('@fastify/multipart')).default, {
    limits: { fileSize: ceilingBytes, files: 1, fields: 0, parts: 1 },
  });

  // ponytail: no role check — dev auth is an admin; T3.3 makes this `write`.
  app.post('/api/files', guarded('upload', async (req, reply) => {
    const maxMb = Math.min(ceilingMb, await capMb(), staging.isS3() ? S3_PUT_MAX_MB : Infinity);
    const maxBytes = maxMb * 1024 * 1024;
    const declared = Number(req.headers['content-length']);
    if (declared > maxBytes + FRAMING_SLACK) return tooLarge(req, reply, maxMb);

    let part;
    try {
      part = await req.file({ limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 1 } });
    } catch {
      return reply.code(400).send({ error: 'expected one file as multipart/form-data' });
    }
    if (!part) return reply.code(400).send({ error: 'expected one file as multipart/form-data' });

    const dest = path.join(appPaths.temp(), `upload-${randomBytes(16).toString('hex')}`);
    const file = part.file;
    // Over the cap busboy sets `truncated` but goes on reading (and discarding)
    // to the end of the part — a 50 GB body would still be read in full.
    // Destroying the stream unpipes the request; tooLarge() then ends it.
    file.once('limit', () => file.destroy(new Error('upload over MAX_UPLOAD_MB')));
    const hash = createHash('sha256'); // as it streams: an S3 PUT signs it, with no second read
    const hashing = new Transform({ transform(chunk: Buffer, _enc, cb) { hash.update(chunk); cb(null, chunk); } });
    try {
      await pipeline(file, hashing, fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
    } catch (err) {
      fs.rmSync(dest, { force: true });
      if (file.truncated) return tooLarge(req, reply, maxMb);
      throw err;
    }
    const name = displayName(part.filename);
    const { size } = fs.statSync(dest);
    if (!tokens.dbOn()) return { fileToken: issue('upload', dest, name), name, size };
    try {
      return { fileToken: await shared.issue('upload', dest, name, size, TOKEN_TTL_MS, hash.digest('hex')), name, size };
    } catch (err) {
      fs.rmSync(dest, { force: true });
      throw err;
    }
  }));

  app.get<{ Params: { token: string } }>('/api/files/:token', guarded('download', async (req: FastifyRequest<{ Params: { token: string } }>, reply) => {
    const { token } = req.params;
    if (tokens.dbOn()) return sendShared(token, reply);
    let e: Entry;
    try {
      e = take(token, 'download');
    } catch (err) {
      if (err instanceof FileTokenError) return reply.code(404).send({ error: 'not found' });
      throw err;
    }
    let size: number;
    try {
      size = fs.statSync(e.path).size;
    } catch {
      forget(token);
      return reply.code(404).send({ error: 'not found' });
    }
    const body = fs.createReadStream(e.path);
    body.on('close', () => forget(token));
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', size)
      .header('content-disposition', contentDisposition(e.name))
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .send(body);
  }));

  const timer = setInterval(sweep, SWEEP_EVERY_MS);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

/** GET /api/files/<token> with a database: the bytes from this pod's copy or the staging area, then deleted. */
async function sendShared(token: string, reply: FastifyReply): Promise<FastifyReply> {
  let t: shared.Taken;
  let src: Awaited<ReturnType<typeof shared.openTaken>>;
  try {
    t = await shared.take(token, 'download');
  } catch (err) {
    if (err instanceof shared.NoToken) return reply.code(404).send({ error: 'not found' });
    throw err;
  }
  try {
    src = await shared.openTaken(t);
  } catch (err) {
    // A moment's S3 failure: the take was undone and nothing deleted — the same link works again.
    if (err instanceof shared.TryAgain) return reply.code(503).header('retry-after', 5).send({ error: 'try again' });
    shared.finish(t);
    return reply.code(404).send({ error: 'not found' });
  }
  const held = { file: '', own: false, held: src.held };
  // 'close' also fires when the client hangs up — outside the request, where ctx() throws:
  // finish() uses only what the take captured, and never throws.
  src.body.once('close', () => shared.finish(t, held));
  return reply
    .header('content-type', 'application/octet-stream')
    .header('content-length', src.size)
    .header('content-disposition', contentDisposition(t.name))
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff')
    .send(src.body);
}

/** Test hooks. */
export function resetForTest(clock?: () => number): void {
  entries.clear();
  now = clock ?? (() => Date.now());
}

/** Where a download token's file is, without spending the token — for a self-check that reads what a handler offered. */
export function downloadPathForTest(token: string): string | null {
  const e = entries.get(token);
  return e && e.kind === 'download' ? e.path : null;
}
