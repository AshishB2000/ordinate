// Server push: the ONE EventSource this tab holds on `GET /api/events` (T0.5),
// and `useServerEvent(channel, fn)` to listen on it. What `ipcRenderer.on` was
// on the desktop.
//
// The stream is opened by the first listener and named by CLIENT_ID — the id
// every RPC sends as X-Ordinate-Client — so a job this tab starts reports to
// this tab. Payloads are wire-decoded (a NaN stays a NaN).
//
// RECONNECT. The browser retries a dropped connection by itself, but gives up
// for good on an HTTP error (a pod restarting behind the ingress answers 502;
// a 401 is handled by the next RPC). Then we reopen with backoff, 1 s doubling
// to 30 s. There is no replay (the server keeps no Last-Event-ID), so every
// open after the first tells `onReconnect` listeners to re-read their state.

import { useEffect, useRef } from 'react';
import { decode } from '../../../src/server/wire.ts';
import { CLIENT_ID } from './client';

type Listener = (payload: unknown) => void;

const listeners = new Map<string, Set<Listener>>();
const reconnectListeners = new Set<() => void>();
let source: EventSource | null = null;
let opened = false;
let backoff = 1000;
let timer: ReturnType<typeof setTimeout> | undefined;

const MAX_BACKOFF = 30_000;

function dispatch(channel: string, e: MessageEvent<string>): void {
  let payload: unknown;
  try {
    payload = decode(e.data);
  } catch {
    return; // a frame the codec cannot read is dropped, never half-applied
  }
  for (const fn of listeners.get(channel) ?? []) fn(payload);
}

function attach(es: EventSource, channel: string): void {
  es.addEventListener(channel, (e) => dispatch(channel, e as MessageEvent<string>));
}

function connect(): void {
  timer = undefined;
  if (typeof EventSource === 'undefined') return; // jsdom; very old browsers
  const es = new EventSource(`/api/events?client=${encodeURIComponent(CLIENT_ID)}`);
  source = es;
  for (const ch of listeners.keys()) attach(es, ch);
  es.onopen = () => {
    backoff = 1000;
    if (opened) for (const fn of reconnectListeners) fn();
    opened = true;
  };
  es.onerror = () => {
    if (es.readyState !== EventSource.CLOSED) return; // the browser is already retrying
    es.close();
    if (source === es) source = null;
    clearTimeout(timer);
    timer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  };
}

/** Listens on `channel` until the returned function is called. Opens the stream on first use. */
export function subscribe(channel: string, fn: Listener): () => void {
  let set = listeners.get(channel);
  if (!set) {
    listeners.set(channel, (set = new Set()));
    if (source) attach(source, channel);
  }
  set.add(fn);
  if (!source && timer === undefined) connect();
  return () => set.delete(fn);
}

/** Runs `fn` each time the stream comes back after a drop — events in between are lost. */
export function onReconnect(fn: () => void): () => void {
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
}

/** `subscribe` for a component: always calls the latest `fn`, unsubscribes on unmount. */
export function useServerEvent(channel: string, fn: Listener): void {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => subscribe(channel, (p) => ref.current(p)), [channel]);
}

/** Test hook: forget the stream and every listener. */
export function resetEventsForTest(): void {
  source?.close();
  source = null;
  opened = false;
  backoff = 1000;
  clearTimeout(timer);
  timer = undefined;
  listeners.clear();
  reconnectListeners.clear();
}

// The names the Assistant dock (T2.12) calls — the same one stream per tab.
export const onServerEvent = subscribe;
export function connectEvents(): void {
  if (!source && timer === undefined) connect();
}
