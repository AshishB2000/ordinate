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
  // A number, like a WebContents id: each browser tab's event stream gets one (./sse.ts), never reused.
  readonly id: number;
  send(channel: string, payload?: unknown): void;
  isDestroyed(): boolean;
  once(event: 'destroyed', fn: () => void): unknown;
}

/** The caller's role in the org (stored on the org membership, `users.role`). T3.3 enforces it. */
export type Role = 'admin' | 'editor' | 'viewer';

export interface Identity {
  readonly user: { readonly email: string; readonly role: Role };
  readonly org: { readonly id: string };
}

export interface RequestContext extends Identity {
  readonly requestId: string;
  readonly client: Client;
}

export type Headers = Readonly<Record<string, string | string[] | undefined>>;

/**
 * Turns a request into who is asking, or null (→ 401). `peer` is the TCP
 * peer's address (never X-Forwarded-For): header mode trusts a proxy by it.
 * Async because real sign-in looks the session up in Postgres (./auth/).
 */
export type Identify = (headers: Headers, peer?: string) => Identity | null | Promise<Identity | null>;

// A request with no open event stream (no X-Ordinate-Client, or a tab that
// never opened one): pushes to it go nowhere, as to a closed window.
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

/** Runs `fn` as a request with this identity (app.ts's hook; tests), pushing to `client`'s stream. */
export function runInContext<T>(identity: Identity, requestId: string, fn: () => T, client: Client = NO_CLIENT): T {
  return als.run({ ...identity, requestId, client }, fn);
}

/**
 * The browser tab behind the current server request, or null — under the
 * desktop app, outside a request, or when the tab has no event stream open.
 * src/app/jobs.ts tags a job with it so the job's events reach that tab only.
 */
export function requestClient(): Client | null {
  const c = als.getStore()?.client;
  return c && c !== NO_CLIENT ? c : null;
}

/**
 * Dev sign-in: everyone is the dev admin (main.ts binds loopback only for that
 * reason). This is the ONE gate for "is dev sign-in allowed here": prod
 * refuses to start with it, whether AUTH_MODE=dev was set or left unset — an
 * open prod server would make every caller an admin. AUTH_MODE=oidc|header
 * resolve through ./auth/ (they need Postgres), never through here.
 */
export function identityFor(cfg: ServerEnv): (headers: Headers) => Identity {
  if (cfg.env === 'prod' && cfg.auth.mode === 'dev') {
    throw new EnvError('ORDINATE_ENV=prod needs sign-in configured: set AUTH_MODE=oidc or AUTH_MODE=header (dev sign-in makes every caller an admin)');
  }
  if (cfg.auth.mode !== 'dev') throw new Error(`AUTH_MODE=${cfg.auth.mode} resolves through src/server/auth, not identityFor`);
  return () => DEV;
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
