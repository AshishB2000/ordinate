// Socket Mode: Ordinate calls Slack, so nothing has to reach in (a firewall, no public address). A pod takes one of
// ten lease rows per install (`slack_socket_slots`), asks Slack for a socket with the app-level token
// (`apps.connections.open`, xapp-…), connects with Node 24's built-in WebSocket (no dependency), and acknowledges each
// envelope by its `envelope_id` AFTER the event is queued (a failed queue is not acknowledged, so Slack sends it again; the
// event id makes a repeat a no-op). On `disconnect` or a closed socket it reconnects, backing off. A lease that lapses (a
// pod that died) frees its slot for another pod. Pods without a slot still claim and answer questions (./worker.ts).
//
// The socket URL must be slack.com's (./base.ts isSlackUrl) and its host is checked by the SSRF guard before connecting.
// shortcut: the WebSocket resolves its own address, so the guard checks the host but cannot pin it; fine for slack.com, revisit if the URL ever comes from anywhere else.

import type { FastifyBaseLogger } from 'fastify';
import { checkHost } from '../../connectors/ssrf';
import { isSlackUrl } from './base';
import { slackCall } from './client';
import * as store from './db';
import { handleEvent, handleInteraction } from './events';

let tickMs = 10_000;
let leaseMs = 30_000;
let backoffBaseMs = 1_000;
/** Test hook: a faster tick, a shorter lease and a short reconnect backoff. */
export function tuneSocketForTest(o: { tickMs?: number; leaseMs?: number; backoffMs?: number }): void {
  if (o.tickMs) tickMs = o.tickMs;
  if (o.leaseMs) leaseMs = o.leaseMs;
  if (o.backoffMs) backoffBaseMs = o.backoffMs;
}

type Log = Pick<FastifyBaseLogger, 'error' | 'warn'>;
interface Envelope { type?: string; envelope_id?: string; payload?: unknown }

class Link {
  ws: WebSocket | null = null;
  connecting = false;
  failures = 0;
  retryAt = 0;
  closed = false;
  constructor(readonly team: string, readonly org: string, readonly slot: number, private readonly log: Log) {}

  async connect(): Promise<void> {
    if (this.closed || this.connecting || this.ws || Date.now() < this.retryAt) return;
    this.connecting = true;
    try {
      const token = await store.getSecret(this.org, 'appToken');
      if (!token) throw new Error('no app-level token');
      const url = String((await slackCall('apps.connections.open', token)).url ?? '');
      if (!isSlackUrl(url)) throw new Error('Slack gave a socket URL outside slack.com');
      await checkHost(new URL(url).hostname);
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onmessage = (e: MessageEvent) => void this.onMessage(ws, e.data);
      ws.onopen = () => { this.failures = 0; };
      ws.onerror = () => undefined; // onclose follows
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        this.backoff();
      };
    } catch (err) {
      this.log.warn({ team: this.team, err: (err as Error).message }, 'slack socket did not connect');
      this.backoff();
    } finally {
      this.connecting = false;
    }
  }

  private backoff(): void {
    this.failures += 1;
    this.retryAt = Date.now() + Math.min(60_000, backoffBaseMs * 2 ** Math.min(this.failures, 6));
  }

  private async onMessage(ws: WebSocket, raw: unknown): Promise<void> {
    let env: Envelope;
    try {
      env = JSON.parse(String(raw)) as Envelope;
    } catch {
      return;
    }
    if (env.type === 'disconnect') { // Slack is moving us: onclose reconnects
      ws.close();
      return;
    }
    if (!env.envelope_id) return; // hello
    try {
      if (env.type === 'events_api') await handleEvent(env.payload as Parameters<typeof handleEvent>[0]);
      else if (env.type === 'interactive') await handleInteraction(env.payload as Parameters<typeof handleInteraction>[0]);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ envelope_id: env.envelope_id }));
    } catch (err) {
      this.log.error({ team: this.team, err: (err as Error).message }, 'slack socket envelope not handled'); // not acknowledged: Slack sends it again
    }
  }

  close(): void {
    this.closed = true;
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* already closed */ }
  }
}

export interface SocketManager { tick(): Promise<void>; stop(): Promise<void>; connected(): number }

export function startSocketManager(owner: string, log: Log): SocketManager {
  const links = new Map<string, Link>();
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> = Promise.resolve();

  const drop = async (team: string): Promise<void> => {
    const l = links.get(team);
    if (!l) return;
    l.close();
    links.delete(team);
    await store.releaseSlot(team, l.slot, owner).catch(() => undefined);
  };

  async function tick(): Promise<void> {
    if (stopped || !store.dbOrNull()) return;
    try {
      const wanted = new Map((await store.socketInstalls()).map((i) => [i.teamId, i]));
      for (const team of links.keys()) if (!wanted.has(team)) await drop(team); // switched to Events, off, or uninstalled
      for (const inst of wanted.values()) {
        const have = links.get(inst.teamId);
        if (have) {
          if (!(await store.renewSlot(inst.teamId, have.slot, owner, leaseMs))) { await drop(inst.teamId); continue; } // the lease lapsed: another pod may hold the slot
          void have.connect();
          continue;
        }
        const slot = await store.takeSlot(inst.teamId, owner, leaseMs);
        if (slot === null) continue; // all ten held by other pods; they carry the sockets, this pod still answers questions
        const link = new Link(inst.teamId, inst.orgId, slot, log);
        links.set(inst.teamId, link);
        void link.connect();
      }
    } catch (err) {
      if (!stopped) log.warn({ err: (err as Error).message }, 'slack socket tick failed');
    }
  }

  const loop = (): void => {
    if (stopped) return;
    timer = setTimeout(() => { running = tick().finally(loop); }, tickMs);
    timer.unref();
  };
  loop();
  return {
    tick,
    connected: () => [...links.values()].filter((l) => l.ws && l.ws.readyState === WebSocket.OPEN).length,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running.catch(() => undefined);
      for (const team of links.keys()) await drop(team);
    },
  };
}
