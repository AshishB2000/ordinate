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

interface Stream extends Client {
  readonly owner: string;
  /** The last `jobs:changed` slice sent, encoded — another org's job ticking must not re-send it. */
  lastJobs?: string;
  close(): void;
}

const byKey = new Map<string, Stream>(); // the tab's client id → its stream
const byId = new Map<number, Stream>(); // Client.id → stream (jobs carry the number)
let nextId = 1;

const ownerOf = (who: Identity): string => `${who.org.id}\n${who.user.email}`;

/** Open streams in this process. */
export function streamCount(): number {
  return byKey.size;
}

/** The stream an RPC's X-Ordinate-Client names — only if it is open AND bound to this caller. */
export function clientFor(key: unknown, who: Identity): Client | null {
  const s = typeof key === 'string' ? byKey.get(key) : undefined;
  return s && s.owner === ownerOf(who) ? s : null;
}

function open(key: string, owner: string, res: ServerResponse): Stream {
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
    send(channel: string, payload?: unknown): void {
      if (closed) return;
      const frame = `event: ${channel}\ndata: ${encode(payload)}\n\n`;
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
    const owner = ownerOf(ctx());
    const old = byKey.get(key);
    if (old && old.owner !== owner) return reply.code(403).send({ error: 'client id in use' });
    old?.close();
    reply.hijack();
    reply.raw.writeHead(200, HEADERS);
    reply.raw.write(': open\n\n'); // first bytes now, so the browser fires `open`
    const s = open(key, owner, reply.raw);
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
