// Server configuration, read from the environment ONCE into a frozen object.
//
// Every value is validated here, at startup, so a typo in a Helm value or a
// Compose file stops the pod with one line naming the variable — not a crash
// minutes later in whatever code first reads it. `parseEnv` is pure (the tests
// feed it plain objects); `env()` is the process-wide cached read.

import { createSecretKey, type KeyObject } from 'crypto';
import { BlockList, isIP } from 'net';
import * as os from 'os';
import * as path from 'path';

export type OrdinateEnv = 'dev' | 'prod';

/** pino's levels — what Fastify's logger accepts. */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface ServerEnv {
  readonly port: number;
  /** METRICS_PORT: GET /metrics listens here, never on `port` (./metrics.ts). Null when unset: no metrics listener. */
  readonly metricsPort: number | null;
  /** Absolute. Where Parquet files and per-org data live (a volume in a pod). */
  readonly dataDir: string;
  readonly env: OrdinateEnv;
  readonly logLevel: LogLevel;
  /** Postgres metadata DB (T3.1), or null when unset — then nothing touches Postgres. Holds a password: never log it. */
  readonly databaseUrl: string | null;
  /** Largest file `POST /api/files` accepts, in MB (MAX_UPLOAD_MB). */
  readonly maxUploadMb: number;
  /**
   * ORDINATE_MASTER_KEY (T5.3): wraps the per-org data keys that encrypt every
   * stored secret (src/server/secrets/). A `KeyObject`, so the bytes never
   * reach JSON, `util.inspect` or a log line. Null when unset.
   */
  readonly masterKey: KeyObject | null;
  /** Sign-in (T3.2). Holds the OIDC client secret: never log this object. */
  readonly auth: AuthEnv;
  /** The per-org DuckDB worker pool (T4.3, src/engine/duckdbPool.ts). */
  readonly duckdb: DuckEnv;
  /** Rate limits, the JSON body cap and the RPC time limit (T6.2, src/server/limits.ts). */
  readonly limits: LimitsEnv;
  /** Where Parquet tables live (T5.2, src/engine/storage.ts). */
  readonly storage: StorageEnv;
  /** ORDINATE_TEST_LIVE_FAKE=1: register the test harness's fake warehouse at boot (./main.ts). Refused in prod. */
  readonly testLiveFake: boolean;
}

export interface LimitsEnv {
  /** RATE_LIMIT_LOGIN_PER_MINUTE: sign-in starts plus IdP callbacks, per client IP. */
  readonly loginPerMinute: number;
  /** RATE_LIMIT_RPC_PER_MINUTE: RPC calls per signed-in user (all their tabs and tokens). */
  readonly rpcUserPerMinute: number;
  /** RATE_LIMIT_RPC_IP_PER_MINUTE: RPC calls per client IP, whoever is signed in. */
  readonly rpcIpPerMinute: number;
  /** MAX_RPC_BODY_KB, in bytes: the cap on every JSON body. Files go through /api/files (MAX_UPLOAD_MB). */
  readonly jsonBodyBytes: number;
  /** RPC_TIMEOUT_SECONDS: a call running longer answers 504 and its DuckDB queries are interrupted. */
  readonly rpcTimeoutMs: number;
}

/** STORAGE_URL=s3://bucket/prefix (T5.2). No keys here: the pod's credential chain signs. */
export interface S3Env {
  readonly bucket: string;
  /** '' or 'a/b' — no leading or trailing slash. */
  readonly prefix: string;
  /** S3_REGION, else AWS_REGION / AWS_DEFAULT_REGION, else us-east-1. */
  readonly region: string;
  /** S3_ENDPOINT's host[:port] for an S3-compatible store (MinIO); null = AWS. Path-style when set. */
  readonly endpoint: string | null;
  /** False only for an http:// S3_ENDPOINT. */
  readonly useSsl: boolean;
  /** DUCKDB_EXTENSION_DIR: where httpfs + aws are installed (the image bakes them); null = DuckDB's default. */
  readonly extensionDir: string | null;
}

export interface StorageEnv {
  /** null: Parquet on DATA_DIR (STORAGE_URL unset or file://). */
  readonly s3: S3Env | null;
  /** STORAGE_CACHE_MB: local LRU cache of S3 Parquet, per pod; 0 = off. */
  readonly cacheBytes: number;
  /** STORAGE_GC_GRACE_MINUTES: an unreferenced version is deleted this long after it was first seen unreferenced. */
  readonly gcGraceMs: number;
}

export interface DuckEnv {
  /** DUCKDB_MAX_WORKERS: live org workers at once; the least recently used idle one is closed past it. */
  readonly maxWorkers: number;
  /** DUCKDB_MEMORY_LIMIT, per worker, as DuckDB spells it ('2GB', '512MiB'). */
  readonly memoryLimit: string;
  /** DUCKDB_THREADS, per worker. */
  readonly threads: number;
  /** DUCKDB_QUERY_TIMEOUT_SECONDS: a query running longer is interrupted. */
  readonly queryTimeoutMs: number;
  /** DUCKDB_IDLE_SECONDS: a worker unused this long is closed. */
  readonly idleMs: number;
}

/**
 * password: Ordinate's own email + password accounts (the default — for trying
 * Ordinate out; a warning at startup says to move to SSO). oidc: SSO sign-in.
 * header: trust a proxy's X-Forwarded-Email. dev: every request is the dev
 * admin — only when set explicitly, for Ordinate's automated tests; refused in prod.
 */
export type AuthMode = 'password' | 'oidc' | 'header' | 'dev';

export interface OidcEnv {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** This server's callback, exactly as registered at the IdP: https://<host>/api/auth/callback. */
  readonly redirectUrl: string;
}

export interface AuthEnv {
  readonly mode: AuthMode;
  /** The org every sign-in lands in (single-org deployments; the schema is multi-org). */
  readonly org: string;
  /** Lower-cased. Made (or kept) org admin at every sign-in — the bootstrap and the recovery path. */
  readonly adminEmail: string | null;
  /** Lower-cased email domains allowed to sign in; empty = any. */
  readonly allowedDomains: readonly string[];
  readonly sessionIdleMs: number;
  readonly sessionAbsoluteMs: number;
  /** Set when mode is oidc. */
  readonly oidc: OidcEnv | null;
  /** CIDRs of the proxies in front (TRUSTED_PROXY_CIDRS): in header mode they may assert X-Forwarded-Email; in every mode their X-Forwarded-For names the client for rate limits. */
  readonly trustedProxies: readonly string[];
}

const AUTH_MODES: readonly AuthMode[] = ['password', 'oidc', 'header', 'dev'];

/** Org ids become directory names (src/app/paths.ts applies the same rule). */
const ORG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

// Session lifetimes. Idle: a working day without a request signs you out.
// Absolute: a week, however active — a stolen cookie dies with it.
const IDLE_MINUTES = 8 * 60;
const ABSOLUTE_HOURS = 7 * 24;

const ENVS: readonly OrdinateEnv[] = ['dev', 'prod'];
const LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

/** Thrown for a bad value; `message` is the one line printed at startup. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

function oneOf<T extends string>(name: string, raw: string | undefined, allowed: readonly T[], dflt: T): T {
  if (raw === undefined || raw === '') return dflt;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new EnvError(`${name} must be one of ${allowed.join('|')}, got ${JSON.stringify(raw)}`);
}

export function parseEnv(src: Readonly<Record<string, string | undefined>>): ServerEnv {
  const env = oneOf('ORDINATE_ENV', src.ORDINATE_ENV, ENVS, 'dev');
  const logLevel = oneOf('LOG_LEVEL', src.LOG_LEVEL, LEVELS, 'info');

  const rawPort = src.PORT ?? '';
  // 0 is allowed: the OS picks a free port (the boot test relies on it).
  if (rawPort !== '' && !/^\d{1,5}$/.test(rawPort)) {
    throw new EnvError(`PORT must be an integer 0-65535, got ${JSON.stringify(rawPort)}`);
  }
  const port = rawPort === '' ? 8080 : Number(rawPort);
  if (port > 65535) throw new EnvError(`PORT must be an integer 0-65535, got ${JSON.stringify(rawPort)}`);

  // Its own listener so the ingress, which routes PORT, can never expose it.
  const rawMetrics = src.METRICS_PORT ?? '';
  if (rawMetrics !== '' && (!/^\d{1,5}$/.test(rawMetrics) || Number(rawMetrics) < 1 || Number(rawMetrics) > 65535)) {
    throw new EnvError(`METRICS_PORT must be an integer 1-65535, got ${JSON.stringify(rawMetrics)}`);
  }
  const metricsPort = rawMetrics === '' ? null : Number(rawMetrics);
  if (metricsPort !== null && metricsPort === port) throw new EnvError('METRICS_PORT must differ from PORT: /metrics is never served on the app port');

  // In prod the data directory must be declared: a pod writing to its own
  // container filesystem loses every dataset on restart.
  // STORAGE_URL=file:///data names the same directory, so either may declare it.
  const fileDir = storageFileDir(src.STORAGE_URL ?? '');
  const rawDir = src.DATA_DIR ?? '';
  if (fileDir !== null && rawDir !== '' && path.resolve(rawDir) !== fileDir) {
    throw new EnvError('STORAGE_URL=file://… and DATA_DIR name different directories; set one of them');
  }
  if (rawDir === '' && fileDir === null && env === 'prod') throw new EnvError('DATA_DIR is required when ORDINATE_ENV=prod');
  const dataDir = fileDir ?? path.resolve(rawDir === '' ? 'data' : rawDir);

  // The value is NEVER echoed in the error: it usually carries a password.
  const rawDb = src.DATABASE_URL ?? '';
  let databaseUrl: string | null = null;
  if (rawDb !== '') {
    let protocol = '';
    try {
      protocol = new URL(rawDb).protocol;
    } catch {
      // falls through to the error below
    }
    if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
      throw new EnvError('DATABASE_URL must be a postgres:// or postgresql:// URL (value not shown: it may hold a password)');
    }
    databaseUrl = rawDb;
  }

  const rawMax = src.MAX_UPLOAD_MB ?? '';
  if (rawMax !== '' && !/^[1-9]\d{0,5}$/.test(rawMax)) {
    throw new EnvError(`MAX_UPLOAD_MB must be a whole number of megabytes 1-999999, got ${JSON.stringify(rawMax)}`);
  }
  const maxUploadMb = rawMax === '' ? 200 : Number(rawMax);

  // Required in prod once there is a database to hold secrets: without it a
  // pod could store nothing, and would fail on the first connection save.
  const rawKey = src.ORDINATE_MASTER_KEY ?? '';
  if (rawKey === '' && env === 'prod' && databaseUrl !== null) {
    throw new EnvError('ORDINATE_MASTER_KEY is required when ORDINATE_ENV=prod and DATABASE_URL is set (32 random bytes: `openssl rand -base64 32`)');
  }
  const masterKey = rawKey === '' ? null : parseMasterKey('ORDINATE_MASTER_KEY', rawKey);

  const auth = parseAuth(src, env, databaseUrl);
  // SSRF_ALLOW (T6.1): internal ranges connectors may reach. Read by src/connectors/ssrf.ts; a typo stops startup here.
  proxyList(csv(src.SSRF_ALLOW), 'SSRF_ALLOW');
  // LIVE_MAX_BYTES_BILLED (live data, L1.3): read by src/connectors/bigquery.ts at each query; a typo stops startup here.
  maxBytesBilled(src.LIVE_MAX_BYTES_BILLED);
  // LIVE_QUERY_TIMEOUT_MS, LIVE_MAX_CONCURRENT (live data, L2.3): read by src/engine/live/ at each query, the same way.
  liveQueryTimeoutMs(src.LIVE_QUERY_TIMEOUT_MS);
  liveMaxConcurrent(src.LIVE_MAX_CONCURRENT);
  const testLiveFake = oneOf('ORDINATE_TEST_LIVE_FAKE', src.ORDINATE_TEST_LIVE_FAKE, ['0', '1'], '0') === '1';
  if (testLiveFake && env === 'prod') {
    throw new EnvError('ORDINATE_ENV=prod refuses ORDINATE_TEST_LIVE_FAKE=1: it registers a fake warehouse for the test harness only');
  }
  const duckdb = parseDuck(src);
  const limits = Object.freeze({
    loginPerMinute: positiveInt('RATE_LIMIT_LOGIN_PER_MINUTE', src.RATE_LIMIT_LOGIN_PER_MINUTE, 60),
    rpcUserPerMinute: positiveInt('RATE_LIMIT_RPC_PER_MINUTE', src.RATE_LIMIT_RPC_PER_MINUTE, 1200),
    rpcIpPerMinute: positiveInt('RATE_LIMIT_RPC_IP_PER_MINUTE', src.RATE_LIMIT_RPC_IP_PER_MINUTE, 3000),
    jsonBodyBytes: positiveInt('MAX_RPC_BODY_KB', src.MAX_RPC_BODY_KB, 1024) * 1024,
    rpcTimeoutMs: positiveInt('RPC_TIMEOUT_SECONDS', src.RPC_TIMEOUT_SECONDS, 60) * 1000,
  });
  const storage = parseStorage(src, databaseUrl);
  return Object.freeze({ port, metricsPort, dataDir, env, logLevel, databaseUrl, maxUploadMb, masterKey, auth, duckdb, limits, storage, testLiveFake });
}

/** The directory of a file:// STORAGE_URL, null for unset or s3://. */
function storageFileDir(raw: string): string | null {
  if (raw === '' || raw.startsWith('s3://')) return null;
  let u: URL | null = null;
  try {
    u = new URL(raw);
  } catch {
    // falls through
  }
  if (!u || u.protocol !== 'file:' || (u.host !== '' && u.host !== 'localhost') || u.search || u.hash) {
    throw new EnvError(`STORAGE_URL must be file:///absolute/dir or s3://bucket/prefix, got ${JSON.stringify(raw)}`);
  }
  return path.resolve(decodeURIComponent(u.pathname));
}

const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const SEGMENT_RE = /^[A-Za-z0-9_.-]{1,200}$/;
const REGION_RE = /^[a-z0-9-]{1,32}$/;

// Bucket, prefix, region and endpoint are written into DuckDB SQL and S3 URLs,
// so each is held to a charset that cannot quote, escape or traverse.
function parseStorage(src: Readonly<Record<string, string | undefined>>, databaseUrl: string | null): StorageEnv {
  const raw = src.STORAGE_URL ?? '';
  const rawCache = src.STORAGE_CACHE_MB ?? '';
  if (rawCache !== '' && !/^\d{1,7}$/.test(rawCache)) {
    throw new EnvError(`STORAGE_CACHE_MB must be a whole number of megabytes (0 turns the cache off), got ${JSON.stringify(rawCache)}`);
  }
  const cacheBytes = (rawCache === '' ? 2048 : Number(rawCache)) * 2 ** 20;
  const gcGraceMs = positiveInt('STORAGE_GC_GRACE_MINUTES', src.STORAGE_GC_GRACE_MINUTES, 60) * 60_000;
  if (!raw.startsWith('s3://')) return Object.freeze({ s3: null, cacheBytes, gcGraceMs });

  const m = /^s3:\/\/([^/?#]+)(\/[^?#]*)?$/.exec(raw);
  const bucket = m ? m[1] : '';
  const segs = (m?.[2] ?? '').split('/').filter(Boolean);
  if (!BUCKET_RE.test(bucket) || segs.some((p) => !SEGMENT_RE.test(p) || p === '.' || p === '..')) {
    throw new EnvError(`STORAGE_URL must be s3://bucket/optional/prefix (bucket a-z 0-9 . -, prefix segments A-Z a-z 0-9 _ . -), got ${JSON.stringify(raw)}`);
  }
  // The version pointers live in Postgres (T5.1's records) and GC tracks objects there.
  if (databaseUrl === null) throw new EnvError('DATABASE_URL is required when STORAGE_URL is s3://');

  const region = src.S3_REGION || src.AWS_REGION || src.AWS_DEFAULT_REGION || 'us-east-1';
  if (!REGION_RE.test(region)) throw new EnvError(`S3_REGION must be an AWS region like eu-west-1, got ${JSON.stringify(region)}`);

  let endpoint: string | null = null;
  let useSsl = true;
  const rawEndpoint = src.S3_ENDPOINT ?? '';
  if (rawEndpoint !== '') {
    let u: URL | null = null;
    try {
      u = new URL(rawEndpoint);
    } catch {
      // falls through
    }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
      throw new EnvError(`S3_ENDPOINT must be http(s)://host[:port] with nothing after it, got ${JSON.stringify(rawEndpoint)}`);
    }
    endpoint = u.host;
    useSsl = u.protocol === 'https:';
  }

  const rawExt = src.DUCKDB_EXTENSION_DIR ?? '';
  if (rawExt !== '' && (!path.isAbsolute(rawExt) || /['\0\n]/.test(rawExt))) {
    throw new EnvError(`DUCKDB_EXTENSION_DIR must be an absolute path, got ${JSON.stringify(rawExt)}`);
  }
  const s3 = Object.freeze({ bucket, prefix: segs.join('/'), region, endpoint, useSsl, extensionDir: rawExt || null });
  return Object.freeze({ s3, cacheBytes, gcGraceMs });
}

// A DuckDB size literal. Validated here because it is written into a SET.
const SIZE_RE = /^\d{1,7}(\.\d{1,3})? ?(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/;

function parseDuck(src: Readonly<Record<string, string | undefined>>): DuckEnv {
  const maxWorkers = positiveInt('DUCKDB_MAX_WORKERS', src.DUCKDB_MAX_WORKERS, 8);
  const rawMem = src.DUCKDB_MEMORY_LIMIT ?? '';
  if (rawMem !== '' && !SIZE_RE.test(rawMem)) {
    throw new EnvError(`DUCKDB_MEMORY_LIMIT must be a size like 512MiB or 2GB, got ${JSON.stringify(rawMem)}`);
  }
  // Default: 80% of the memory this process may use (the cgroup limit in a
  // container, else the machine's), shared by the most workers that can be live.
  const limit = process.constrainedMemory();
  const total = limit > 0 && limit < os.totalmem() ? limit : os.totalmem();
  const memoryLimit = rawMem || `${Math.max(64, Math.floor((total * 0.8) / maxWorkers / 2 ** 20))}MiB`;
  return Object.freeze({
    maxWorkers,
    memoryLimit,
    threads: positiveInt('DUCKDB_THREADS', src.DUCKDB_THREADS, os.availableParallelism()),
    queryTimeoutMs: positiveInt('DUCKDB_QUERY_TIMEOUT_SECONDS', src.DUCKDB_QUERY_TIMEOUT_SECONDS, 60) * 1000,
    idleMs: positiveInt('DUCKDB_IDLE_SECONDS', src.DUCKDB_IDLE_SECONDS, 300) * 1000,
  });
}

/**
 * A 32-byte key written as 64 hex chars, or base64 / base64url (44 chars with
 * `=`, 43 without). Surrounding whitespace is ignored — a Kubernetes secret
 * made with `echo` carries a newline. The error NEVER echoes the value.
 */
export function parseMasterKey(name: string, raw: string): KeyObject {
  const v = raw.trim();
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(v)) buf = Buffer.from(v, 'hex');
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) buf = Buffer.from(v, 'base64');
  if (!buf || buf.length !== 32) {
    throw new EnvError(`${name} must be 32 bytes written as base64 (44 chars) or hex (64 chars) (value not shown)`);
  }
  const key = createSecretKey(buf);
  buf.fill(0);
  return key;
}


/** LIVE_MAX_BYTES_BILLED's default: 10 GiB (docs/live-data/00-plan.md §8). */
export const DEFAULT_MAX_BYTES_BILLED = 10_737_418_240;

/**
 * LIVE_MAX_BYTES_BILLED: the ceiling on BigQuery's `maximumBytesBilled`, in
 * bytes, for every query a BigQuery connection runs (a connection may set it
 * lower, never higher). Pure, so the connector re-reads the variable the same
 * way at each query. Not positiveInt: 10 GiB has eleven digits.
 */
export function maxBytesBilled(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_MAX_BYTES_BILLED;
  if (!/^\d{1,16}$/.test(raw) || Number(raw) === 0 || !Number.isSafeInteger(Number(raw))) {
    throw new EnvError(`LIVE_MAX_BYTES_BILLED must be a positive whole number of bytes, for example 10737418240 (10 GiB), got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

/** LIVE_QUERY_TIMEOUT_MS (plan §8): one live warehouse statement, cancelled in the warehouse past it. Pure: re-read per query. */
export const DEFAULT_LIVE_QUERY_TIMEOUT_MS = 60_000;
export function liveQueryTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LIVE_QUERY_TIMEOUT_MS;
  if (/^\d{3,7}$/.test(raw) && Number(raw) >= 100 && Number(raw) <= 3_600_000) return Number(raw);
  throw new EnvError(`LIVE_QUERY_TIMEOUT_MS must be a whole number of milliseconds from 100 to 3600000, got ${JSON.stringify(raw)}`);
}

/** LIVE_MAX_CONCURRENT (plan §8): live warehouse statements in flight per org per pod; more wait. Pure: re-read per query. */
export const DEFAULT_LIVE_MAX_CONCURRENT = 4;
export function liveMaxConcurrent(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LIVE_MAX_CONCURRENT;
  if (/^\d{1,4}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= 1000) return Number(raw);
  throw new EnvError(`LIVE_MAX_CONCURRENT must be a whole number from 1 to 1000, got ${JSON.stringify(raw)}`);
}

function positiveInt(name: string, raw: string | undefined, dflt: number): number {
  if (raw === undefined || raw === '') return dflt;
  if (!/^\d{1,7}$/.test(raw) || Number(raw) === 0) throw new EnvError(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

function required(src: Readonly<Record<string, string | undefined>>, name: string, why: string): string {
  const v = src[name] ?? '';
  if (v === '') throw new EnvError(`${name} is required when ${why}`);
  return v;
}

function httpUrl(name: string, raw: string, env: OrdinateEnv): string {
  let u: URL | null = null;
  try {
    u = new URL(raw);
  } catch {
    // falls through
  }
  // Plain http only in dev (a local mock IdP); prod speaks TLS to the IdP and to browsers.
  const okProto = u && (u.protocol === 'https:' || (env === 'dev' && u.protocol === 'http:'));
  if (!okProto) throw new EnvError(`${name} must be an ${env === 'dev' ? 'http(s)' : 'https'}:// URL, got ${JSON.stringify(raw)}`);
  return raw;
}

/**
 * CIDRs, comma-separated, v4 or v6 ("10.0.0.0/8, fd00::/8"); a bare address is
 * a /32 or /128. Built into a BlockList once here so a typo fails startup.
 */
export function proxyList(cidrs: readonly string[], name = 'TRUSTED_PROXY_CIDRS'): BlockList {
  const list = new BlockList();
  for (const c of cidrs) {
    const [addr, bits, extra] = c.split('/');
    const family = isIP(addr);
    const max = family === 6 ? 128 : 32;
    const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
    if (family === 0 || extra !== undefined || !(prefix >= 0 && prefix <= max)) {
      throw new EnvError(`${name}: ${JSON.stringify(c)} is not an IPv4 or IPv6 CIDR`);
    }
    list.addSubnet(addr, prefix, family === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

const csv = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

function parseAuth(src: Readonly<Record<string, string | undefined>>, env: OrdinateEnv, databaseUrl: string | null): AuthEnv {
  const mode = oneOf('AUTH_MODE', src.AUTH_MODE, AUTH_MODES, 'password');
  // dev + prod is refused by identityFor (context.ts) — the one gate main.ts runs.
  // dev is never the default: a server nobody configured asks for a password.

  const org = src.ORDINATE_ORG || 'default';
  if (!ORG_RE.test(org)) throw new EnvError(`ORDINATE_ORG must match ${ORG_RE.source}, got ${JSON.stringify(org)}`);

  const adminEmail = (src.ORDINATE_ADMIN_EMAIL ?? '').trim().toLowerCase() || null;
  if (adminEmail !== null && !EMAIL_RE.test(adminEmail)) throw new EnvError(`ORDINATE_ADMIN_EMAIL is not an email address, got ${JSON.stringify(adminEmail)}`);

  const allowedDomains = csv(src.ALLOWED_EMAIL_DOMAINS);
  for (const d of allowedDomains) {
    if (!DOMAIN_RE.test(d)) throw new EnvError(`ALLOWED_EMAIL_DOMAINS: ${JSON.stringify(d)} is not a domain`);
  }

  const sessionIdleMs = positiveInt('SESSION_IDLE_MINUTES', src.SESSION_IDLE_MINUTES, IDLE_MINUTES) * 60_000;
  const sessionAbsoluteMs = positiveInt('SESSION_ABSOLUTE_HOURS', src.SESSION_ABSOLUTE_HOURS, ABSOLUTE_HOURS) * 3_600_000;

  // Users, sessions and roles live in Postgres; only dev sign-in works without it.
  if (mode === 'password' && databaseUrl === null) {
    throw new EnvError(
      `DATABASE_URL is required when AUTH_MODE=password${src.AUTH_MODE ? '' : ' (the default)'}: accounts and sessions live in Postgres. See the README's Quick start`,
    );
  }
  if (mode !== 'dev' && databaseUrl === null) throw new EnvError(`DATABASE_URL is required when AUTH_MODE=${mode}`);

  let oidc: OidcEnv | null = null;
  if (mode === 'oidc') {
    const why = 'AUTH_MODE=oidc';
    oidc = Object.freeze({
      issuer: httpUrl('OIDC_ISSUER', required(src, 'OIDC_ISSUER', why), env),
      clientId: required(src, 'OIDC_CLIENT_ID', why),
      // Never echoed: only its presence is checked.
      clientSecret: required(src, 'OIDC_CLIENT_SECRET', why),
      redirectUrl: httpUrl('OIDC_REDIRECT_URL', required(src, 'OIDC_REDIRECT_URL', why), env),
    });
  }

  // Read in every mode: the rate limits (T6.2) take the client's address from
  // X-Forwarded-For only when the TCP peer is one of these proxies. Header
  // mode also believes their X-Forwarded-Email, so there it is required.
  if (mode === 'header') required(src, 'TRUSTED_PROXY_CIDRS', 'AUTH_MODE=header');
  const trustedProxies = csv(src.TRUSTED_PROXY_CIDRS);
  if (mode === 'header' && trustedProxies.length === 0) throw new EnvError('TRUSTED_PROXY_CIDRS is required when AUTH_MODE=header');
  proxyList(trustedProxies);

  return Object.freeze({
    mode,
    org,
    adminEmail,
    allowedDomains: Object.freeze(allowedDomains),
    sessionIdleMs,
    sessionAbsoluteMs,
    oidc,
    trustedProxies: Object.freeze(trustedProxies),
  });
}

let cached: ServerEnv | null = null;

/** The process's configuration. Parsed on first call; throws `EnvError` if invalid. */
export function env(): ServerEnv {
  return (cached ??= parseEnv(process.env));
}
