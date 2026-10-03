// The one door from the browser to the server: `rpc(channel, ...args)` →
// POST /api/rpc/<channel>. Bodies go through the wire codec both ways, so a
// NaN or a Date arrives as what the handler returned, not what JSON makes of it.

// The contracts are imported TYPE-ONLY: a renamed channel or a changed input
// fails tsc here as well as on the server, and no zod reaches the bundle. The
// codec is the server's own file (no Node imports), so both halves agree.
import type { z } from 'zod';
import type { Channel, contracts } from '../../../src/api/index.ts';
import { decode, encode } from '../../../src/server/wire.ts';

export type { Channel };

/** The payload a channel's contract accepts. */
export type RpcInput<C extends Channel> = z.input<(typeof contracts)[C]['input']>;

/** At most one payload (the server rejects more); optional when the contract allows undefined. */
export type RpcArgs<C extends Channel> = undefined extends RpcInput<C>
  ? [payload?: RpcInput<C>]
  : [payload: RpcInput<C>];

/** A failed call. `status` 0 means the server was never reached. */
export class RpcError extends Error {
  readonly status: number;
  readonly code: string;
  /** For a 400: the input paths that failed validation (never their values). */
  readonly paths?: readonly string[];

  constructor(status: number, code: string, message: string, paths?: readonly string[]) {
    super(message);
    this.name = 'RpcError';
    this.status = status;
    this.code = code;
    if (paths) this.paths = paths;
  }
}

/** This tab's id. The server routes SSE pushes to a tab by it (T0.5). */
export const CLIENT_ID: string = crypto.randomUUID();

/**
 * The CSRF token (T6.2, src/server/csrf.ts): the server sets it as a cookie
 * script can read (`ordinate_csrf`, `__Host-ordinate_csrf` behind https) and
 * refuses any non-GET whose X-CSRF-Token header does not repeat it. Another
 * site can make the browser send the cookie but cannot read it.
 */
export function csrfHeaders(): Record<string, string> {
  const m = /(?:^|;\s*)(?:__Host-)?ordinate_csrf=([A-Za-z0-9_-]{43})(?:;|$)/.exec(document.cookie);
  return m ? { 'X-CSRF-Token': m[1] } : {};
}

/**
 * A non-GET to this server with the CSRF header. A 403 `csrf` (no cookie yet —
 * the first call raced the page's own load — or it was cleared) carries a
 * fresh cookie, so it is tried once more with it.
 */
export async function send(url: string, init: RequestInit): Promise<Response> {
  const go = () =>
    fetch(url, { ...init, credentials: 'same-origin', headers: { ...(init.headers as Record<string, string>), ...csrfHeaders() } });
  const res = await go();
  if (res.status !== 403) return res;
  const again = await res
    .clone()
    .json()
    .then((b: { error?: unknown }) => b?.error === 'csrf', () => false);
  return again ? go() : res;
}

interface ErrorBody {
  error?: unknown;
  code?: unknown;
  message?: unknown;
  issues?: unknown;
}

function toError(status: number, statusText: string, text: string): RpcError {
  let body: ErrorBody = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') body = parsed as ErrorBody;
  } catch {
    // not JSON (a proxy's HTML error page): status alone says it
  }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const code = str(body.code) ?? str(body.error) ?? `http_${status}`;
  const message = str(body.message) ?? str(body.error) ?? (statusText || `Request failed (${status})`);
  const paths = Array.isArray(body.issues)
    ? body.issues.map((i: { path?: unknown }) => String(i?.path ?? ''))
    : undefined;
  return new RpcError(status, code, message, paths);
}

/** Where the app goes on a 401 — a seam so tests can watch it (jsdom cannot navigate). */
export const nav = {
  assign: (url: string): void => window.location.assign(url),
};

/**
 * A 401 means the session ended under us (idle or absolute expiry, signed out
 * in another tab, logged out everywhere): go to sign-in, and come back here
 * afterwards. Same path rule as features/auth's `signInPath`.
 */
function toSignIn(): void {
  const { pathname, search } = window.location;
  if (pathname === '/sign-in') return;
  const next = pathname + search;
  nav.assign(next === '/' ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`);
}

/**
 * Calls a contracted channel. Contracts carry inputs only, so the result is
 * `unknown` here; each hook in this folder narrows it to the shape its handler
 * returns.
 */
export async function rpc<C extends Channel>(channel: C, ...args: RpcArgs<C>): Promise<unknown> {
  let res: Response;
  try {
    res = await send(`/api/rpc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ordinate-Client': CLIENT_ID },
      body: encode({ args }),
    });
  } catch {
    throw new RpcError(0, 'network', 'Could not reach the Ordinate server.');
  }
  const text = await res.text();
  if (res.status === 401) toSignIn();
  if (!res.ok) throw toError(res.status, res.statusText, text);
  return decode(text);
}

/** What POST /api/files answers: the token an import channel takes instead of a path (T0.4). */
export interface Uploaded {
  fileToken: string;
  name: string;
  size: number;
}

/** Uploads one file (multipart, streamed by the server to the org's temp, capped at MAX_UPLOAD_MB). */
export async function upload(file: Blob, name: string): Promise<Uploaded> {
  const form = new FormData();
  form.append('file', file, name);
  let res: Response;
  try {
    res = await send('/api/files', { method: 'POST', body: form });
  } catch {
    throw new RpcError(0, 'network', 'Could not reach the Ordinate server.');
  }
  const text = await res.text();
  if (res.status === 401) toSignIn();
  if (!res.ok) throw toError(res.status, res.statusText, text);
  return JSON.parse(text) as Uploaded; // the server's own reply shape (src/server/files.ts)
}
