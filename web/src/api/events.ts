// Server push (T0.5): this tab's one event stream, GET /api/events?client=<id>.
// The server routes a push to a tab by the id the tab sends on every RPC
// (X-Ordinate-Client, ./client.ts), so a reply streamed to "the asking tab"
// arrives here and nowhere else. Frames are named events whose data is
// wire-encoded (src/server/wire.ts) — decoded with the server's own codec.
//
// Opened on first subscribe and kept for the page's life; EventSource
// reconnects by itself, and nothing is resumed (the server has no
// Last-Event-ID): a reconnected tab re-reads state over RPC.

import { decode } from '../../../src/server/wire.ts';
import { CLIENT_ID } from './client';

type Handler = (payload: unknown) => void;

let source: EventSource | null = null;
const handlers = new Map<string, Set<Handler>>();

function dispatch(channel: string, e: MessageEvent<string>): void {
  let payload: unknown;
  try {
    payload = decode(e.data);
  } catch {
    return; // a frame this build cannot read is dropped, never thrown into a listener
  }
  for (const h of handlers.get(channel) ?? []) h(payload);
}

/** Starts this tab's stream if it is not open yet (a no-op where EventSource does not exist, e.g. jsdom). */
export function connectEvents(): void {
  if (source || typeof EventSource === 'undefined') return;
  source = new EventSource(`/api/events?client=${CLIENT_ID}`, { withCredentials: true });
  for (const channel of handlers.keys()) source.addEventListener(channel, (e) => dispatch(channel, e));
}

/** Calls `fn` with every `channel` event this tab receives; returns the unsubscribe. */
export function onServerEvent(channel: string, fn: Handler): () => void {
  let set = handlers.get(channel);
  if (!set) {
    set = new Set();
    handlers.set(channel, set);
    source?.addEventListener(channel, (e) => dispatch(channel, e));
  }
  set.add(fn);
  connectEvents();
  return () => {
    set.delete(fn);
  };
}
