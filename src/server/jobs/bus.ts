// Cross-pod event fan-out over Postgres LISTEN/NOTIFY (T5.4).
//
// Every pod LISTENs on one channel on a dedicated connection (a pooled one can
// be handed to anyone between queries, so it cannot hold a LISTEN). A publish
// on pod A (../sse.ts `publish`) is delivered to A's own streams directly and
// NOTIFYd here as `{ p: pod, s: seq, t: target, c: channel, d: wire-encoded
// payload }`; every other pod hands it to `deliverLocal`, which checks the
// target's org/user/client binding against its own streams. A pod ignores its
// own notifications (it has already delivered).
//
// SIZE. Postgres refuses a NOTIFY payload of 8000 bytes or more. A message
// over MAX_NOTIFY_BYTES goes BY REFERENCE: the same statement inserts its body
// into `event_payloads` and NOTIFYs `{ p, s, ref: <uuid> }`; NOTIFY is
// delivered at commit, so the row is visible to every receiver, which reads it
// by id. That statement also deletes rows older than 5 minutes.
//
// ORDER AND BATCHING. One flush at a time per pod: everything published while
// a flush is in flight goes out together in the NEXT flush — one statement,
// its NOTIFYs in publish order (Postgres delivers a transaction's
// notifications in the order sent, transactions in commit order). So a newer
// `jobs:changed` never overtakes an older one, and a burst costs one round
// trip, not one each. `s` keeps two identical events distinct (Postgres folds
// duplicate payloads within a transaction). Receivers deliver in arrival
// order too, including a by-reference body that needs a read first.
//
// LOSS. Like a tab's own reconnect (../sse.ts header): an event published while
// the LISTEN connection is down is not replayed. The connection is re-opened
// after RECONNECT_MS; a tab re-reads state over RPC when it matters.
//
// Must load without Electron (scripts/test-server-boot.ts).

import { randomUUID } from 'crypto';
import { Client, type Notification, type Pool } from 'pg';
import type { FastifyBaseLogger } from 'fastify';
import { scrubbed } from '../db/pool';
import { deliverLocal, setFanOut, type Target } from '../sse';
import { POD } from './runner';

export const CHANNEL = 'ordinate_events';
/** Under Postgres's 8000-byte NOTIFY cap. */
export const MAX_NOTIFY_BYTES = 7_900;
const RECONNECT_MS = 1_000;
const CHANNEL_RE = /^[\w:.-]{1,100}$/;

interface Body {
  t: Target;
  c: string;
  d: string;
}

const validTarget = (t: unknown): t is Target => {
  const o = t as Partial<Target> | null;
  return !!o && typeof o.org === 'string'
    && (o.user === undefined || typeof o.user === 'string')
    && (o.client === undefined || typeof o.client === 'string');
};

/** Opens the LISTEN connection and installs the fan-out. `stop()` removes both. */
export async function startBus(pool: Pool, url: string, log: FastifyBaseLogger): Promise<{ stop(): Promise<void> }> {
  let listener: Client | null = null;
  let stopped = false;
  let retry: NodeJS.Timeout | null = null;
  let seq = 0;

  // ── Receive ──────────────────────────────────────────────────────────────
  let received: Promise<void> = Promise.resolve();
  const deliver = (b: Partial<Body>): void => {
    // A channel or payload with a line break would forge SSE frames; ours never carry one.
    if (!validTarget(b.t) || typeof b.c !== 'string' || !CHANNEL_RE.test(b.c) || typeof b.d !== 'string' || /[\r\n]/.test(b.d)) return;
    deliverLocal(b.t, b.c, b.d);
  };
  const handle = async (payload: string): Promise<void> => {
    let m: { p?: unknown; ref?: unknown } & Partial<Body>;
    try {
      m = JSON.parse(payload) as typeof m;
    } catch {
      return;
    }
    if (m.p === POD) return;
    if (typeof m.ref !== 'string') return deliver(m);
    const r = await pool.query<{ body: string }>('SELECT body FROM event_payloads WHERE id = $1', [m.ref]);
    if (r.rows[0]) deliver(JSON.parse(r.rows[0].body) as Partial<Body>);
  };
  const onNotify = (n: Notification): void => {
    received = received
      .then(() => handle(n.payload ?? ''))
      .catch((err: unknown) => log.warn({ err: scrubbed(err, url) }, 'event delivery from another pod failed'));
  };

  const scheduleRetry = (): void => {
    if (!stopped && !retry) retry = setTimeout(() => { retry = null; void listen().catch(onListenFail); }, RECONNECT_MS);
  };
  const onListenFail = (err: unknown): void => {
    log.warn({ err: scrubbed(err, url) }, 'event listener could not connect; retrying');
    scheduleRetry();
  };
  async function listen(): Promise<void> {
    const c = new Client({ connectionString: url, application_name: 'ordinate-events' });
    c.on('notification', onNotify);
    c.on('error', (err) => {
      log.warn({ err: scrubbed(err, url) }, 'event listener lost its connection; reconnecting');
      c.removeAllListeners('notification');
      void c.end().catch(() => undefined);
      if (listener === c) listener = null;
      scheduleRetry();
    });
    await c.connect();
    await c.query(`LISTEN ${CHANNEL}`);
    if (stopped) {
      await c.end();
      return;
    }
    listener = c;
  }
  try {
    await listen();
  } catch (err) {
    throw scrubbed(err, url);
  }

  // ── Send ─────────────────────────────────────────────────────────────────
  let pending: Array<{ t: Target; c: string; d: string }> = [];
  let flushing: Promise<void> | null = null;

  async function flush(): Promise<void> {
    while (pending.length) {
      const batch = pending;
      pending = [];
      const notes: string[] = [];
      const ids: string[] = [];
      const bodies: string[] = [];
      for (const { t, c, d } of batch) {
        const s = seq++;
        const inline = JSON.stringify({ p: POD, s, t, c, d });
        if (Buffer.byteLength(inline) <= MAX_NOTIFY_BYTES) {
          notes.push(inline);
          continue;
        }
        const id = randomUUID();
        ids.push(id);
        bodies.push(JSON.stringify({ t, c, d }));
        notes.push(JSON.stringify({ p: POD, s, ref: id }));
      }
      try {
        // unnest yields in array order, so the NOTIFYs go out in publish order.
        await pool.query(
          ids.length
            ? `WITH gc AS (DELETE FROM event_payloads WHERE created_at < now() - interval '5 minutes'),
                    ins AS (INSERT INTO event_payloads (id, body) SELECT * FROM unnest($3::uuid[], $4::text[]))
               SELECT pg_notify($1, n) FROM unnest($2::text[]) AS n`
            : 'SELECT pg_notify($1, n) FROM unnest($2::text[]) AS n',
          ids.length ? [CHANNEL, notes, ids, bodies] : [CHANNEL, notes],
        );
      } catch (err) {
        log.warn({ err: scrubbed(err, url), events: batch.length }, 'event fan-out failed');
      }
    }
  }

  setFanOut((t, c, d) => {
    pending.push({ t, c, d });
    flushing ??= flush().finally(() => { flushing = null; });
  });

  return {
    async stop() {
      stopped = true;
      setFanOut(null);
      if (retry) clearTimeout(retry);
      await flushing;
      await listener?.end().catch(() => undefined);
      listener = null;
      await received;
    },
  };
}
