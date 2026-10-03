// The few S3 calls Node makes itself — SERVER ONLY (T5.2). No AWS SDK (plan §2).
//
// DuckDB's httpfs does every read and write of a table (src/engine/storage.ts).
// What SQL cannot do is fetch an object's exact bytes into the local cache,
// delete an object (GC) or make a bucket (tests, the bench). Those three are
// here: SigV4-signed `fetch`, ~40 lines of stdlib crypto.
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
let conn: { runAndReadAll(sql: string): Promise<{ getRowObjectsJson(): Record<string, unknown>[] }> } | null = null;

async function resolveCreds(cfg: S3Env): Promise<Creds> {
  if (!conn) {
    const { DuckDBInstance } = require('@duckdb/node-api') as typeof import('@duckdb/node-api');
    const opts: Record<string, string> = {
      allow_unredacted_secrets: 'true',
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
    };
    if (cfg.extensionDir) opts.extension_directory = cfg.extensionDir;
    const c = await (await DuckDBInstance.create(':memory:', opts)).connect();
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

const enc = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** The object URL, path-style; `key` is bucket-relative ('' for the bucket itself). */
export function objectUrl(cfg: S3Env, key: string): URL {
  const host = cfg.endpoint ?? `s3.${cfg.region}.amazonaws.com`;
  const path = [cfg.bucket, ...(key ? key.split('/') : [])].map(enc).join('/');
  return new URL(`${cfg.useSsl ? 'https' : 'http'}://${host}/${path}`);
}

/** SigV4 headers for a body-less request (UNSIGNED-PAYLOAD, which S3 accepts). Exported for the tests. */
export function signedHeaders(cfg: S3Env, method: string, url: URL, creds: Creds, now = new Date()): Record<string, string> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: url.host, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', 'x-amz-date': amzDate };
  if (creds.token) headers['x-amz-security-token'] = creds.token;
  const names = Object.keys(headers).sort();
  const canonical = [method, url.pathname, '', names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
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
    throw new Error(`S3 GET failed: HTTP ${res.status}`);
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
