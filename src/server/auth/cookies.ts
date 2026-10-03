// The auth cookies' names and flags, in one place.
//
// httpOnly (no script reads them), SameSite=Lax (sent on the IdP's top-level
// redirect back to the callback, never on a cross-site POST), Secure in prod.
// In prod the names carry the browser-enforced prefixes: `__Host-` (Secure,
// Path=/, no Domain — a sibling subdomain cannot plant or shadow it) and
// `__Secure-` for the path-scoped login cookie.

import type { CookieSerializeOptions } from '@fastify/cookie';

export interface CookieNames {
  readonly session: string;
  readonly tx: string;
  /** The CSRF token (../csrf.ts): NOT httpOnly — the web client reads it and echoes it in a header. */
  readonly csrf: string;
}

export const cookieNames = (secure: boolean): CookieNames =>
  secure
    ? { session: '__Host-ordinate_session', tx: '__Secure-ordinate_login', csrf: '__Host-ordinate_csrf' }
    : { session: 'ordinate_session', tx: 'ordinate_login', csrf: 'ordinate_csrf' };

export const cookieOpts = (secure: boolean, path: string): CookieSerializeOptions => ({
  httpOnly: true,
  secure,
  sameSite: 'lax',
  path,
});

/** A same-origin path to land on after sign-in; anything else (`//evil`, `https:`, `/\evil`) is `/`. */
export function safeNext(raw: unknown): string {
  return typeof raw === 'string' && /^\/(?![/\\])[^\s\\]*$/.test(raw) && raw.length < 512 ? raw : '/';
}
