// The backstop for a stream close the bus lost (docs/sso-lifecycle §3.9, R5).
//
// `closeStreamsOf` (./sse.ts) reaches other pods over Postgres NOTIFY, which
// does not replay a message sent while a pod's LISTEN connection was down
// (./jobs/bus.ts "LOSS"). So every SWEEP_MS each pod asks, in two queries over
// its OWN open streams — whatever their number — which belong to a disabled
// user, and which opened under a session that is gone (logged out, expired,
// idle past SESSION_IDLE_MINUTES), and closes those. A browser that reconnects
// is refused at /api/events like any other request. Bound: about a second with
// the bus, SWEEP_MS without it.

import type { Pool } from 'pg';
import { localStreams } from './sse';

export const SWEEP_MS = 30_000;

interface SweepLog {
  warn(obj: object, msg: string): void;
}

/** One pass: closes this pod's streams of disabled users and of ended sessions. Returns how many it closed. */
export async function sweepStreams(pool: Pool, idleMs: number): Promise<number> {
  const streams = localStreams();
  if (!streams.length) return 0;
  const owners = [...new Map(streams.map((s) => [`${s.org}\n${s.user}`, s])).values()];
  const disabled = await pool.query<{ org: string; email: string }>(
    `SELECT u.org_id AS org, u.email FROM users u JOIN unnest($1::text[], $2::text[]) AS o(org, email)
       ON u.org_id = o.org AND u.email = o.email WHERE u.disabled_at IS NOT NULL`,
    [owners.map((s) => s.org), owners.map((s) => s.user)],
  );
  const gone = new Set(disabled.rows.map((r) => `${r.org}\n${r.email}`));
  const hashes = [...new Set(streams.flatMap((s) => (s.session ? [s.session] : [])))];
  const alive = new Set<string>();
  if (hashes.length) {
    const r = await pool.query<{ h: string }>(
      `SELECT id_hash AS h FROM sessions WHERE id_hash = ANY($1::text[]) AND expires_at > now() AND last_seen_at > now() - $2 * interval '1 millisecond'`,
      [hashes, idleMs],
    );
    for (const row of r.rows) alive.add(row.h);
  }
  let n = 0;
  for (const s of streams) {
    if (gone.has(`${s.org}\n${s.user}`) || (s.session && !alive.has(s.session))) {
      s.close();
      n++;
    }
  }
  return n;
}

/** Sweeps every `everyMs` until stopped. A failed pass is logged and tried again at the next. */
export function startStreamSweep(pool: Pool, idleMs: number, log: SweepLog, everyMs = SWEEP_MS): { stop(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweepStreams(pool, idleMs)
      .catch((err: unknown) => log.warn({ err: { name: (err as Error | null)?.name, code: (err as { code?: unknown } | null)?.code } }, 'stream sweep failed'))
      .finally(() => { running = false; });
  }, everyMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
