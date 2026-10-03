// Who is asking: the request context every handler can read without a
// signature change. Under the server, Fastify's onRequest hook (app.ts) runs
// the rest of each request inside `als.run(store, …)`, so `ctx()` anywhere
// below a handler — across awaits — returns THAT request's user and org.
//
// Server mode is an explicit switch, not a guess: `enterServerMode(dataDir)`
// is called once by src/server/main.ts (and by tests that want server
// behaviour). Nothing can infer it — plain-Node unit tests run without
// Electron too, against a stubbed `require('electron')`. Until the switch is
// set the process is the desktop app (or a test of it): `ctx()` returns the
// fixed DESKTOP context and src/app/paths.ts asks Electron.
//
// Must load without Electron (scripts/test-server-boot.ts).

import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrowserWindow, WebContents } from 'electron';
import { EnvError, type ServerEnv } from './env';

/** The caller's browser tab (server) or window (desktop) — what `event.sender` was. */
export interface Client {
  // A number, like a WebContents id; T0.5 numbers each browser tab's stream.
  readonly id: number;
  send(channel: string, payload?: unknown): void;
  isDestroyed(): boolean;
  once(event: 'destroyed', fn: () => void): unknown;
}

export interface Identity {
  // Only dev auth exists so far; T3.3 widens the role set.
  readonly user: { readonly email: string; readonly role: 'admin' };
  readonly org: { readonly id: string };
}

export interface RequestContext extends Identity {
  readonly requestId: string;
  readonly client: Client;
}

/** Turns a request's headers into who is asking, or null (→ 401). */
export type Identify = (headers: Readonly<Record<string, string | string[] | undefined>>) => Identity | null;

// ponytail: a no-op until T0.5 gives each tab an SSE stream to write to.
const NO_CLIENT: Client = Object.freeze({ id: 0, send() {}, isDestroyed: () => false, once: () => undefined });

const DESKTOP: RequestContext = Object.freeze({
  user: Object.freeze({ email: 'desktop', role: 'admin' as const }),
  org: Object.freeze({ id: 'desktop' }),
  requestId: 'desktop',
  client: NO_CLIENT,
});

const DEV: Identity = Object.freeze({
  user: Object.freeze({ email: 'dev@local', role: 'admin' as const }),
  org: Object.freeze({ id: 'default' }),
});

const als = new AsyncLocalStorage<RequestContext>();
let dataDir: string | null = null;

/** Marks this process as the server, storing per-org data under `dir`. Once, at boot. */
export function enterServerMode(dir: string): void {
  dataDir = dir;
}

/** DATA_DIR when this process is the server; null under the desktop app. */
export function serverDataDir(): string | null {
  return dataDir;
}

/** The current request's context. Throws outside a request on the server — a call there has no org to act for. */
export function ctx(): RequestContext {
  const store = als.getStore();
  if (store) return store;
  if (dataDir === null) return DESKTOP;
  throw new Error('ctx() called outside a request');
}

/** Runs `fn` as a request with this identity (app.ts's hook; tests). */
export function runInContext<T>(identity: Identity, requestId: string, fn: () => T): T {
  return als.run({ ...identity, requestId, client: NO_CLIENT }, fn);
}

/**
 * How requests are authenticated, decided once at startup. dev: everyone is
 * the dev admin (main.ts binds loopback only for that reason). prod: refuse to
 * start — no sign-in exists until T3.2 adds AUTH_MODE, and an open prod server
 * would make every caller an admin.
 */
export function identityFor(cfg: ServerEnv): Identify {
  if (cfg.env === 'dev') return () => DEV;
  throw new EnvError('ORDINATE_ENV=prod needs sign-in configured, and none exists yet (AUTH_MODE arrives with T3.2)');
}

/**
 * Who sent this IPC/RPC call: the window's WebContents under the desktop app,
 * `ctx().client` on the server (whose event carries no sender).
 */
export function senderOf(e: { sender: Client }): Client {
  return dataDir === null ? e.sender : ctx().client;
}

/**
 * The window a native dialog should be parented to. The server has no windows
 * (its dialogs become T0.4's upload/download flows), so: null there.
 */
export function windowOf(e: { sender: WebContents }): BrowserWindow | null {
  if (dataDir !== null) return null;
  return (require('electron') as typeof import('electron')).BrowserWindow.fromWebContents(e.sender);
}
