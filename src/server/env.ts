// Server configuration, read from the environment ONCE into a frozen object.
//
// Every value is validated here, at startup, so a typo in a Helm value or a
// Compose file stops the pod with one line naming the variable — not a crash
// minutes later in whatever code first reads it. `parseEnv` is pure (the tests
// feed it plain objects); `env()` is the process-wide cached read.

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

  return Object.freeze({ port, dataDir, env, logLevel });
}

let cached: ServerEnv | null = null;

/** The process's configuration. Parsed on first call; throws `EnvError` if invalid. */
export function env(): ServerEnv {
  return (cached ??= parseEnv(process.env));
}
