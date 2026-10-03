// The Postgres pool (metadata DB, plan §2) and the one rule around it: the
// DATABASE_URL password never reaches a log line, an HTTP reply or a thrown
// message. pg's own errors are mostly safe ("password authentication failed
// for user …"), but a URL can surface in a parse or DNS error, so every error
// that leaves this layer goes through `scrubbed()`.

import { Pool } from 'pg';
import { safeError } from '../../connectors/types';

// Pool settings, per pod. 10 is pg's default and what a small RDS instance
// (max_connections ≈ 80–100) tolerates at 5–8 replicas with headroom for
// migrations and psql. ponytail: fixed values; a DATABASE_POOL_MAX env var
// when an operator needs more replicas than connections allow.
const POOL = {
  max: 10,
  idleTimeoutMillis: 30_000,
  // A dead DB fails /readyz in 3 s instead of hanging the probe.
  connectionTimeoutMillis: 3_000,
  application_name: 'ordinate',
} as const;

/** Both spellings of the password in `url` — percent-encoded as written, and decoded. */
function secretsOf(url: string): Record<string, string> {
  try {
    const raw = new URL(url).password;
    return { raw, decoded: decodeURIComponent(raw) };
  } catch {
    return {};
  }
}

/** A NEW error carrying `err`'s message with the URL's password removed (its stack is this frame's). */
export function scrubbed(err: unknown, url: string): Error {
  const out = new Error(safeError(err, secretsOf(url)));
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string') Object.assign(out, { code });
  return out;
}

export function createPool(url: string, onIdleError: (err: Error) => void): Pool {
  const pool = new Pool({ connectionString: url, ...POOL });
  // Without a listener an idle client's error (DB restart, failover) is an
  // uncaught 'error' event and kills the process.
  pool.on('error', (err) => onIdleError(scrubbed(err, url)));
  return pool;
}

/** Readiness: can this pod run a query right now? Never throws. */
export async function ping(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
