// Who is asking: the request context every handler can read without a
// signature change. Under the server, Fastify's onRequest hook (app.ts) runs
// the rest of each request inside `als.run(store, …)`, so `ctx()` anywhere
// below a handler — across awaits — returns THAT request's user and org.
//
// Server mode is an explicit switch, not a guess: `enterServerMode(dataDir)`
// is called once by src/server/main.ts (and by tests that want server
// behaviour). Until the switch is set the process is a plain-Node self-check or
// script: `ctx()` returns the fixed DESKTOP context (the single-user context a
// desktop install's records were written under) and src/app/paths.ts reads
// ORDINATE_LOCAL_DIR.

import { AsyncLocalStorage } from 'node:async_hooks';
import { EnvError, type ServerEnv } from './env';
import { markServerMode } from './mode';

/** The caller's browser tab — what an IPC `event.sender` was. */
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
  /** Set when the request signed in with a personal API token (`Authorization: Bearer`, ./auth/tokens.ts). */
  readonly via?: 'token';
  /**
   * Password sign-in with a temporary password (./auth/password.ts): until it
   * is changed, app.ts refuses every /api/ request outside /api/auth/*.
   */
  readonly mustChangePassword?: true;
}

export interface RequestContext extends Identity {
  readonly requestId: string;
  readonly client: Client;
  /** Aborts when the caller goes away before its reply is sent; its DuckDB queries are interrupted (src/engine/duckdbPool.ts). */
  readonly signal?: AbortSignal;
  /**
   * A published page's request (`/p/…`, ./published.ts), member or anonymous:
   * a Live figure read under it is at least LIVE_MIN_CACHE_AGE_PUBLIC_SEC old
   * (src/engine/live/liveBudget.ts cacheAgeFloorSec), so a public link cannot
   * run up the warehouse bill (live data L2.7, R-L2).
   */
  readonly published?: true;
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
  markServerMode();
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

/**
 * `key` scoped to the caller's org. For a module-level cache keyed by record
 * ids: on the server ids are unique within an org, not across orgs (an
 * imported desktop install or a crafted bundle repeats them), so a cache keyed
 * by id alone would hand org B what was computed for org A.
 */
export function orgKey(key: string): string {
  return ctx().org.id + '\u0000' + key;
}

/** Runs `fn` as a request with this identity (app.ts's hook; tests), pushing to `client`'s stream. */
export function runInContext<T>(identity: Identity, requestId: string, fn: () => T, client: Client = NO_CLIENT, signal?: AbortSignal): T {
  return als.run({ ...identity, requestId, client, signal }, fn);
}

/** Runs `fn` as a published page's request (./published.ts): `isPublishedRequest()` holds below it. No tab to push to. */
export function runAsPublished<T>(identity: Identity, requestId: string, fn: () => T): T {
  return als.run({ ...identity, requestId, client: NO_CLIENT, published: true }, fn);
}

/** True inside a published page's request (`/p/…`); false in every other request, and outside one. */
export function isPublishedRequest(): boolean {
  return als.getStore()?.published === true;
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
 * reason). Only an explicit AUTH_MODE=dev gets here — the default is password
 * sign-in — and it is for Ordinate's automated tests. This is the ONE gate for
 * "is dev sign-in allowed here": prod refuses to start with it — an open prod
 * server would make every caller an admin. AUTH_MODE=password|oidc|header
 * resolve through ./auth/ (they need Postgres), never through here.
 */
export function identityFor(cfg: ServerEnv): (headers: Headers) => Identity {
  if (cfg.env === 'prod' && cfg.auth.mode === 'dev') {
    throw new EnvError('ORDINATE_ENV=prod refuses dev sign-in (AUTH_MODE=dev makes every caller an admin): set AUTH_MODE=oidc, header or password');
  }
  if (cfg.auth.mode !== 'dev') throw new Error(`AUTH_MODE=${cfg.auth.mode} resolves through src/server/auth, not identityFor`);
  return () => DEV;
}

/**
 * Who sent this RPC call: `ctx().client` on the server (whose event carries no
 * sender); outside server mode, the `sender` a self-check put on the event.
 */
export function senderOf(e: unknown): Client {
  return dataDir === null ? (e as { sender: Client }).sender : ctx().client;
}
