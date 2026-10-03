// Server push: one server-sent-events stream per browser tab — what
// `webContents.send` was under Electron. `GET /api/events?client=<id>` opens it;
// `ctx().client.send(channel, payload)` (and so `senderOf(e).send`) writes one
// event to it: `event: <channel>` + `data: <payload, wire-encoded>` (./wire.ts).
//
// THE CLIENT ID is a UUID the tab makes for itself and sends on every RPC as
// X-Ordinate-Client. It is BOUND at stream open to the org + user who opened
// it: another user opening the same id gets 403, and an RPC naming an id bound
// to someone else gets no client (its pushes go nowhere). The same user
// reopening an id (EventSource reconnecting, a reload) replaces the old stream.
// Each stream gets a fresh numeric `Client.id`, never reused, so a job tagged
// with one (src/app/jobs.ts) can only ever reach that stream. There is no
// Last-Event-ID resume: events sent while a tab is disconnected are gone, and
// a reconnected tab re-reads state over RPC.
//
// BACKPRESSURE. While the socket buffer is full (`write()` returned false)
// events queue, at most MAX_QUEUED per stream. A state channel (`jobs:changed`:
// the tab's whole job list) replaces its queued older copy — stale progress is
// dropped, the latest state survives. Every other event (`jobs:finished`, the
// completion) is never dropped: if the queue still fills, the stream is CLOSED
// rather than grown or thinned — the tab sees a reconnect and re-reads.
//
// THE FIVE DESKTOP PUSH CHANNELS:
//   hub:new-entry        kept — a capture became an entry; its sender moves here with the capture port.
//   hub:open-settings    dropped — tray/menu "Settings…" is a URL route in the browser.
//   hub:show-permission  dropped — the macOS Screen Recording panel; the server never captures the screen.
//   menu:run             dropped — the native app menu; the web shell's own menus/palette run in the page.
//   overlay:frame        dropped — the screenshot overlay window; OS capture is gone (captures are uploads).
//
// ACROSS PODS (T5.4, when DATABASE_URL is set). `publish(target, channel,
// payload)` delivers to this pod's matching streams AND hands the event to the
// fan-out (./jobs/bus.ts: Postgres LISTEN/NOTIFY), so every other pod delivers
// it to ITS matching streams. A target is an org, a user in an org, or one tab
// (client id + its user + org). Binding is checked by the DELIVERING pod against
// the stream's own org/user, exactly as `clientFor` checks it here — a client
// id with the wrong user or org reaches nothing. An RPC whose tab's stream is
// on another pod gets a REMOTE client from `clientFor`: its `send` is such a
// targeted publish, and jobs tagged with it reach that tab the same way.
// Without a fan-out (desktop, a server without DATABASE_URL) none of this runs.
//
// Must load without Electron (scripts/test-server-boot.ts).

import type { ServerResponse } from 'http';
import type { FastifyInstance } from 'fastify';
import { isValidId } from '../app/ids';
import * as jobs from '../app/jobs';
import { ctx, type Client, type Identity } from './context';
import { encode } from './wire';

export const MAX_QUEUED = 256;
let heartbeatMs = 20_000;

/** Test hook: the heartbeat interval for streams opened after this call. */
export function setHeartbeatMsForTest(ms: number): void {
  heartbeatMs = ms;
}

/** Channels whose payload is the whole current state, so a newer one supersedes a queued older one. */
const STATE_CHANNELS: ReadonlySet<string> = new Set(['jobs:changed']);

// Proxies (nginx, ALBs) buffer or cache a response unless told not to.
const HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** Who an event is for: an org, one user in it, or one tab of that user. */
export interface Target {
  readonly org: string;
  readonly user?: string;
  readonly client?: string;
}

/** Hands an already-encoded event to the other pods (./jobs/bus.ts). */
export type FanOut = (target: Target, channel: string, data: string) => void;

interface Pushable extends Client {
  /** The last `jobs:changed` slice sent, encoded — another org's job ticking must not re-send it. */
  lastJobs?: string;
}

interface Stream extends Pushable {
  readonly owner: string;
  readonly org: string;
  readonly user: string;
  push(channel: string, data: string): void;
  close(): void;
}

const byKey = new Map<string, Stream>(); // the tab's client id → its stream
const byId = new Map<number, Pushable>(); // Client.id → this pod's stream, or a remote tab (jobs carry the number)
const remotes = new Map<string, Pushable>(); // owner + client id → the remote client handed to its RPCs
// ponytail: a cap, not an expiry — the oldest remote client is forgotten past
// it (a job still tagged with it then pushes nowhere). Expire on job finish if it bites.
const MAX_REMOTES = 10_000;
let nextId = 1;
let fanOut: FanOut | null = null;

const ownerOf = (who: Identity): string => `${who.org.id}\n${who.user.email}`;

/** Installs (or with null removes) the cross-pod fan-out. */
export function setFanOut(fn: FanOut | null): void {
  fanOut = fn;
}

/** Delivers an encoded event to this pod's streams bound to `t`. Returns how many got it. */
export function deliverLocal(t: Target, channel: string, data: string): number {
  if (t.client !== undefined) {
    const s = byKey.get(t.client);
    if (!s || t.user === undefined || s.org !== t.org || s.user !== t.user) return 0;
    s.push(channel, data);
    return 1;
  }
  let n = 0;
  for (const s of byKey.values()) {
    if (s.org !== t.org || (t.user !== undefined && s.user !== t.user)) continue;
    s.push(channel, data);
    n++;
  }
  return n;
}

/** Sends one event to every stream bound to `t`, on this pod and (with a fan-out) every other. */
export function publish(t: Target, channel: string, payload?: unknown): void {
  const data = encode(payload);
  deliverLocal(t, channel, data);
  fanOut?.(t, channel, data);
}

/** A tab whose stream is on another pod: pushes go out as a publish targeted at it. */
function remoteClient(key: string, who: Identity): Pushable {
  const rk = `${ownerOf(who)}\n${key}`;
  let r = remotes.get(rk);
  if (r) return r;
  const target: Target = { org: who.org.id, user: who.user.email, client: key };
  const id = nextId++;
  r = { id, send: (channel, payload) => publish(target, channel, payload), isDestroyed: () => false, once: () => r };
  if (remotes.size >= MAX_REMOTES) {
    const [oldKey, old] = remotes.entries().next().value as [string, Pushable];
    remotes.delete(oldKey);
    byId.delete(old.id);
  }
  remotes.set(rk, r);
  byId.set(id, r);
  return r;
}

/** Open streams in this process. */
export function streamCount(): number {
  return byKey.size;
}

/**
 * The stream an RPC's X-Ordinate-Client names — only if it is open AND bound to
 * this caller. With a fan-out, a valid id with no stream here is a REMOTE client
 * (its stream may be on another pod; that pod checks the binding on delivery).
 */
export function clientFor(key: unknown, who: Identity): Client | null {
  const s = typeof key === 'string' ? byKey.get(key) : undefined;
  if (s) return s.owner === ownerOf(who) ? s : null;
  return fanOut && isValidId(key) ? remoteClient(key, who) : null;
}

function open(key: string, who: Identity, res: ServerResponse): Stream {
  const owner = ownerOf(who);
  const id = nextId++;
  const queue: { channel: string; frame: string }[] = [];
  const onDestroyed: (() => void)[] = [];
  let blocked = false;
  let closed = false;
  const write = (frame: string): void => {
    blocked = !res.write(frame);
  };
  const timer = setInterval(() => {
    if (!blocked) write(': hb\n\n');
  }, heartbeatMs);

  const s: Stream = {
    id,
    owner,
    org: who.org.id,
    user: who.user.email,
    send(channel: string, payload?: unknown): void {
      s.push(channel, encode(payload));
    },
    push(channel: string, data: string): void {
      if (closed) return;
      const frame = `event: ${channel}\ndata: ${data}\n\n`;
      if (!blocked) return write(frame);
      if (STATE_CHANNELS.has(channel)) {
        const i = queue.findIndex((q) => q.channel === channel);
        if (i >= 0) queue.splice(i, 1);
      }
      if (queue.length >= MAX_QUEUED) return s.close();
      queue.push({ channel, frame });
    },
    isDestroyed: () => closed,
    once(_event: 'destroyed', fn: () => void) {
      onDestroyed.push(fn);
      return s;
    },
    close(): void {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      queue.length = 0;
      if (byKey.get(key) === s) byKey.delete(key);
      byId.delete(id);
      res.end();
      for (const fn of onDestroyed) {
        try { fn(); } catch (_) { /* a listener must not keep a stream open */ }
      }
    },
  };
  res.on('drain', () => {
    blocked = false;
    while (queue.length && !blocked) write(queue.shift()!.frame);
  });
  res.on('close', () => s.close());
  byKey.set(key, s);
  byId.set(id, s);
  return s;
}

/** Adds `GET /api/events`. Runs under app.ts's onRequest hook, so `ctx()` is the caller. */
export function registerEvents(app: FastifyInstance): void {
  const mine = new Set<Stream>();
  app.get('/api/events', async (req, reply) => {
    const key = (req.query as { client?: unknown }).client;
    if (!isValidId(key)) return reply.code(400).send({ error: 'invalid client id' });
    const who = ctx();
    const old = byKey.get(key);
    if (old && old.owner !== ownerOf(who)) return reply.code(403).send({ error: 'client id in use' });
    old?.close();
    reply.hijack();
    // The security headers set at onRequest (./headers.ts) — writeHead bypasses Fastify's own.
    reply.raw.writeHead(200, { ...(reply.getHeaders() as import('http').OutgoingHttpHeaders), ...HEADERS });
    reply.raw.write(': open\n\n'); // first bytes now, so the browser fires `open`
    const s = open(key, who, reply.raw);
    mine.add(s);
    s.once('destroyed', () => mine.delete(s));
    return reply;
  });
  // An open stream never goes idle, so the server could not close around it.
  app.addHook('preClose', (done) => {
    for (const s of mine) s.close();
    done();
  });
}

// Jobs → the tab that submitted each one. `jobs:changed` is that tab's slice of
// the list (what the desktop broadcast to every window); `jobs:finished` is the
// completion, once per job, standing in for the desktop's OS notification.
// ponytail: a tab whose last job leaves the global recent list gets no final
// empty list; send to last time's recipients too if a stale row ever shows.
jobs.onChange((snap) => {
  const per = new Map<number, jobs.JobsSnapshot>();
  for (const k of ['active', 'recent'] as const) {
    for (const j of snap[k]) {
      if (!j.client || !byId.has(j.client)) continue;
      let s = per.get(j.client);
      if (!s) per.set(j.client, (s = { active: [], recent: [] }));
      s[k].push(j);
    }
  }
  for (const [id, s] of per) {
    const stream = byId.get(id)!;
    const now = encode(s);
    if (stream.lastJobs === now) continue;
    stream.lastJobs = now;
    stream.send('jobs:changed', s);
  }
});
jobs.onFinish((job) => {
  if (job.client) byId.get(job.client)?.send('jobs:finished', job);
});
