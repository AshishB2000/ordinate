// The few S3 calls Node makes itself — SERVER ONLY (T5.2). No AWS SDK (plan §2).
//
// DuckDB's httpfs does every read and write of a table (src/engine/storage.ts).
// What SQL cannot do is fetch an object's exact bytes into the local cache,
// delete an object (GC), make a bucket (tests, the bench), or move a file's
// raw bytes to and from the org's staging prefix (uploads and downloads that
// any pod serves, docs/any-pod/00-design.md §3.2). Those are here: SigV4-signed
// requests, ~40 lines of stdlib crypto. A PUT signs the body's real sha256 and
// goes through http(s).request with an explicit Content-Length: S3 refuses a
// chunked body, and fetch's 300 s headers/body timers would bound a slow
// multi-GB upload; a plain request has no such timer.
//
// CREDENTIALS come from the SAME chain the org workers use — DuckDB's `aws`
// extension, `PROVIDER credential_chain` (env, shared config, web identity /
// IRSA, ECS, instance profile). A private, never-locked DuckDB instance in this
// process resolves them with `allow_unredacted_secrets`; it runs nothing but
// the three statements below, never user SQL, so the unredacted secret cannot
// leak through a query. Nothing is read from config and nothing is logged:
// a failure message names the call and the HTTP status, never a header.
// Re-resolved every CRED_TTL_MS, and at once after a 403 (rotated keys).
//
// ponytail: path-style URLs always (https://s3.<region>.amazonaws.com/<bucket>/…),
// still served by AWS for every bucket; virtual-hosted when AWS finally drops it.

import { createHash, createHmac, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { S3Env } from '../server/env';

interface Creds {
  keyId: string;
  secret: string;
  token: string;
}

const CRED_TTL_MS = 5 * 60_000;

let cached: { creds: Creds; at: number } | null = null;
let resolving: Promise<Creds> | null = null;
// @duckdb/node-api's connection, loaded lazily so nothing pays for it outside S3 mode.
let conn: { runAndReadAll(sql: string): Promise<{ getRowObjectsJson(): Record<string, unknown>[] }>; closeSync(): void } | null = null;
let instance: { closeSync(): void } | null = null;
// Set by close(): the process is ending, and this instance must not start again.
let closed = false;

async function resolveCreds(cfg: S3Env): Promise<Creds> {
  if (closed) throw new Error('S3: the server is shutting down');
  if (!conn) {
    const { DuckDBInstance } = require('@duckdb/node-api') as typeof import('@duckdb/node-api');
    const opts: Record<string, string> = {
      allow_unredacted_secrets: 'true',
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
    };
    if (cfg.extensionDir) opts.extension_directory = cfg.extensionDir;
    const db = await DuckDBInstance.create(':memory:', opts);
    instance = db;
    const c = await db.connect();
    await c.runAndReadAll('LOAD httpfs; LOAD aws;');
    conn = c;
  }
  // cfg.region passed REGION_RE in env.ts: it cannot close the literal.
  await conn.runAndReadAll(`CREATE OR REPLACE SECRET ordinate_node (TYPE s3, PROVIDER credential_chain, REGION '${cfg.region}');`);
  const rows = await conn.runAndReadAll("SELECT secret_string FROM duckdb_secrets(redact=false) WHERE name = 'ordinate_node';");
  const kv = new Map<string, string>();
  for (const part of String(rows.getRowObjectsJson()[0]?.secret_string ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) kv.set(part.slice(0, i), part.slice(i + 1));
  }
  const creds = { keyId: kv.get('key_id') ?? '', secret: kv.get('secret') ?? '', token: kv.get('session_token') ?? '' };
  if (!creds.keyId || !creds.secret) throw new Error('S3: the credential chain found no credentials');
  return creds;
}

async function credsFor(cfg: S3Env, fresh = false): Promise<Creds> {
  if (!fresh && cached && Date.now() - cached.at < CRED_TTL_MS) return cached.creds;
  resolving ??= resolveCreds(cfg).then(
    (creds) => { cached = { creds, at: Date.now() }; resolving = null; return creds; },
    (err: unknown) => { resolving = null; throw err; },
  );
  return resolving;
}

/** Test hook: a credential lookup in flight (one that never settles, to test the shutdown's deadline). */
export function setResolvingForTest(p: Promise<Creds> | null): void {
  resolving = p;
}

/**
 * Server shutdown (src/server/shutdown.ts): this module's DuckDB runs on the MAIN
 * thread, so the exit must not cut a resolve in half. Waits for one in flight
 * (until `deadlineAt`), then closes the connection and the instance. False when
 * a resolve was still running at the deadline: it is left alone, never closed under.
 */
export async function close(deadlineAt: number): Promise<boolean> {
  closed = true;
  if (resolving) {
    const settled = await Promise.race([
      resolving.then(() => true, () => true),
      // Ref'd on purpose: this wait holds the process until the deadline, never lets it end around a lookup.
      new Promise<false>((r) => setTimeout(() => r(false), Math.max(0, deadlineAt - Date.now()))),
    ]);
    if (!settled) return false;
  }
  try { conn?.closeSync(); } catch { /* already closed */ }
  try { instance?.closeSync(); } catch { /* already closed */ }
  conn = null;
  instance = null;
  cached = null;
  return true;
}

const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** The object URL, path-style; `key` is bucket-relative ('' for the bucket itself). */
export function objectUrl(cfg: S3Env, key: string): URL {
  const host = cfg.endpoint ?? `s3.${cfg.region}.amazonaws.com`;
  const path = [cfg.bucket, ...(key ? key.split('/') : [])].map(enc).join('/');
  return new URL(`${cfg.useSsl ? 'https' : 'http'}://${host}/${path}`);
}

/** SigV4 headers: a body-less request is UNSIGNED-PAYLOAD (S3 accepts it); a PUT names its body's sha256. Exported for the tests. */
export function signedHeaders(cfg: S3Env, method: string, url: URL, creds: Creds, now = new Date(), payloadHash = 'UNSIGNED-PAYLOAD'): Record<string, string> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (creds.token) headers['x-amz-security-token'] = creds.token;
  const names = Object.keys(headers).sort();
  const canonical = [method, url.pathname, '', names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  let key: Buffer = hmac('AWS4' + creds.secret, day);
  for (const part of [cfg.region, 's3', 'aws4_request']) key = hmac(key, part);
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  delete headers.host; // fetch sets it from the URL; it was signed above
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return headers;
}

async function send(cfg: S3Env, method: string, key: string): Promise<Response> {
  const url = objectUrl(cfg, key);
  let res = await fetch(url, { method, headers: signedHeaders(cfg, method, url, await credsFor(cfg)) });
  if (res.status === 403) {
    await res.body?.cancel();
    res = await fetch(url, { method, headers: signedHeaders(cfg, method, url, await credsFor(cfg, true)) });
  }
  return res;
}

/** Download `key` to `file` (written via a temp sibling, renamed into place). Throws on any non-200 or a short body. */
export async function download(cfg: S3Env, key: string, file: string): Promise<number> {
  const res = await send(cfg, 'GET', key);
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel();
    throw Object.assign(new Error(`S3 GET failed: HTTP ${res.status}`), { status: res.status });
  }
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await pipeline(Readable.fromWeb(res.body as import('stream/web').ReadableStream), fs.createWriteStream(tmp, { flags: 'wx' }));
    const size = (await fs.promises.stat(tmp)).size;
    const want = Number(res.headers.get('content-length') ?? size);
    if (size !== want) throw new Error(`S3 GET was cut short: ${size} of ${want} bytes`);
    await fs.promises.rename(tmp, file);
    return size;
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

/** Delete `key`. A missing key is success (S3 answers 204 either way). */
export async function remove(cfg: S3Env, key: string): Promise<void> {
  const res = await send(cfg, 'DELETE', key);
  await res.body?.cancel();
  if (res.status !== 204 && res.status !== 200 && res.status !== 404) throw new Error(`S3 DELETE failed: HTTP ${res.status}`);
}

/** Create the bucket; an existing one of ours is fine. Tests and the bench only — an operator owns the real bucket. */
export async function createBucket(cfg: S3Env): Promise<void> {
  const res = await send(cfg, 'PUT', '');
  const body = await res.text();
  if (res.status !== 200 && !/BucketAlreadyOwnedByYou/.test(body)) throw new Error(`S3 create bucket failed: HTTP ${res.status}`);
}

/** Upload `file` (`size` bytes whose sha256 is `sha256`, hex) as `key`. Throws on anything but 200. */
export async function put(cfg: S3Env, key: string, file: string, sha256: string, size: number): Promise<void> {
  let status = await putWithCreds(cfg, key, file, sha256, size, await credsFor(cfg));
  if (status === 403) status = await putWithCreds(cfg, key, file, sha256, size, await credsFor(cfg, true));
  if (status !== 200) throw Object.assign(new Error(`S3 PUT failed: HTTP ${status}`), { status });
}

/** A PUT with no progress (no byte sent, no answer) for this long is abandoned: no total limit, a stall limit. */
let putIdleMs = 120_000;
/** Test hook: a shorter stall limit. */
export function setPutIdleForTest(ms: number): void {
  putIdleMs = ms;
}

/** One signed PUT with these credentials; the HTTP status. Exported for the tests (a local server, fake keys). */
export function putWithCreds(cfg: S3Env, key: string, file: string, sha256: string, size: number, creds: Creds): Promise<number> {
  const url = objectUrl(cfg, key);
  const headers = { ...signedHeaders(cfg, 'PUT', url, creds, new Date(), sha256), 'content-length': String(size) };
  return new Promise<number>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, { method: 'PUT', headers }, (res) => {
      res.resume(); // the body is an XML error at most: never read, never logged
      res.on('end', () => resolve(res.statusCode ?? 0));
      res.on('error', reject);
    });
    const body = fs.createReadStream(file);
    req.setTimeout(putIdleMs, () => req.destroy(new Error('S3 PUT stalled')));
    req.on('error', reject);
    req.on('close', () => body.destroy()); // never leave the file open behind a dead request
    body.on('error', (err) => req.destroy(err));
    body.pipe(req);
  });
}

/** An object's bytes as a stream, and its size. Throws on anything but 200 (`status` on the error). */
export async function open(cfg: S3Env, key: string): Promise<{ body: Readable; size: number }> {
  const res = await send(cfg, 'GET', key);
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel();
    throw Object.assign(new Error(`S3 GET failed: HTTP ${res.status}`), { status: res.status });
  }
  return { body: Readable.fromWeb(res.body as import('stream/web').ReadableStream), size: Number(res.headers.get('content-length') ?? 0) };
}
