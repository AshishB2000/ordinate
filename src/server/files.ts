// Files over HTTP: what replaces the desktop app's open and save dialogs.
//
//   POST /api/files         multipart, ONE file, streamed to the org's temp()
//                           and never held in memory; capped at MAX_UPLOAD_MB.
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
// The client's filename is display text only: it never becomes a path. The
// file on disk is `upload-<random hex>` in the org's temp directory.
//
// Must load without Electron, and without @fastify/multipart until the routes
// are registered — the desktop app imports `resolveUpload` through
// src/ipc/datasetImport.ts.

import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { pipeline } from 'stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as appPaths from '../app/paths';
import { ctx } from './context';

export const TOKEN_TTL_MS = 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 1000;
// Multipart framing around the file: boundary lines and the part's headers.
// A declared Content-Length beyond cap + this is refused before a byte is read.
const FRAMING_SLACK = 64 * 1024;
// After a 413 the rest of the body is read and DISCARDED for at most this
// long / this much, then the socket is dropped (see tooLarge).
const LINGER_MS = 2000;
const LINGER_BYTES = 16 * 1024 * 1024;

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

// ponytail: per-process. Behind N pods an upload and the RPC that uses it must
// reach the same pod (sticky sessions) until tokens move to Postgres (P5).
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
  /** Absolute path of the uploaded bytes. Read it; never move or keep it. */
  readonly path: string;
  /** The client's filename, sanitized — for display and its extension only. */
  readonly name: string;
  /** Deletes the file. Call it when finished (in a `finally`); the sweep is only the backstop. */
  done(): void;
}

/** The upload behind `token`, for the current request's org and user. Throws FileTokenError. */
export function resolveUpload(token: unknown): Upload {
  const e = take(token, 'upload');
  return { path: e.path, name: e.name, done: () => forget(token as string) };
}

/**
 * Hands a server-produced file to the browser: the reply carries the token, the
 * browser fetches GET /api/files/<token>. The file is the server's to DELETE
 * after it is sent (or when the token expires), so write it to temp().
 */
export function offerDownload(filePath: string, name: string): { downloadToken: string } {
  return { downloadToken: issue('download', path.resolve(filePath), displayName(name)) };
}

/** Expires old tokens and deletes their files. Runs every minute while the server is up. */
export function sweep(): void {
  const t = now();
  for (const [token, e] of entries) if (t >= e.expires) forget(token);
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

/** Registers the multipart parser and both routes on `app`. Uploads above `maxMb` get 413. */
export function registerFileRoutes(app: FastifyInstance, maxMb: number): void {
  const maxBytes = maxMb * 1024 * 1024;
  // Lazy: only the server needs the multipart parser.
  void app.register((require('@fastify/multipart') as typeof import('@fastify/multipart')).default, {
    limits: { fileSize: maxBytes, files: 1, fields: 0, parts: 1 },
  });

  // ponytail: no role check — dev auth is an admin; T3.3 makes this `write`.
  app.post('/api/files', async (req, reply) => {
    const declared = Number(req.headers['content-length']);
    if (declared > maxBytes + FRAMING_SLACK) return tooLarge(req, reply, maxMb);

    let part;
    try {
      part = await req.file();
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
    try {
      await pipeline(file, fs.createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
    } catch (err) {
      fs.rmSync(dest, { force: true });
      if (file.truncated) return tooLarge(req, reply, maxMb);
      throw err;
    }
    const name = displayName(part.filename);
    const { size } = fs.statSync(dest);
    return { fileToken: issue('upload', dest, name), name, size };
  });

  app.get<{ Params: { token: string } }>('/api/files/:token', async (req, reply) => {
    const { token } = req.params;
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
  });

  const timer = setInterval(sweep, SWEEP_EVERY_MS);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

/** Test hooks. */
export function resetForTest(clock?: () => number): void {
  entries.clear();
  now = clock ?? (() => Date.now());
}
