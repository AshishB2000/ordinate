// Server configuration, read from the environment ONCE into a frozen object.
//
// Every value is validated here, at startup, so a typo in a Helm value or a
// Compose file stops the pod with one line naming the variable — not a crash
// minutes later in whatever code first reads it. `parseEnv` is pure (the tests
// feed it plain objects); `env()` is the process-wide cached read.

import { createSecretKey, type KeyObject } from 'crypto';
import * as path from 'path';

export type OrdinateEnv = 'dev' | 'prod';

/** pino's levels — what Fastify's logger accepts. */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface ServerEnv {
  readonly port: number;
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
}

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

  // In prod the data directory must be declared: a pod writing to its own
  // container filesystem loses every dataset on restart.
  const rawDir = src.DATA_DIR ?? '';
  if (rawDir === '' && env === 'prod') throw new EnvError('DATA_DIR is required when ORDINATE_ENV=prod');
  const dataDir = path.resolve(rawDir === '' ? 'data' : rawDir);

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

  return Object.freeze({ port, dataDir, env, logLevel, databaseUrl, maxUploadMb, masterKey });
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

let cached: ServerEnv | null = null;

/** The process's configuration. Parsed on first call; throws `EnvError` if invalid. */
export function env(): ServerEnv {
  return (cached ??= parseEnv(process.env));
}
