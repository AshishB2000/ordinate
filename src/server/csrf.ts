// CSRF (T6.2): every request that is not GET/HEAD/OPTIONS must prove it was
// sent by this app, not by another site riding the browser's credentials.
//
// Two checks, both before sign-in is looked up (a refusal costs no query):
//
//   1. Origin. A browser stamps every non-GET with its page's origin; one that
//      is not this server's host is refused (403 `origin`). Without an Origin,
//      `Sec-Fetch-Site: cross-site` is refused the same way. The ingress must
//      pass the browser's Host through (nginx-ingress, ALB and GKE do).
//   2. Double-submit token. A random token rides a cookie (`ordinate_csrf`,
//      `__Host-ordinate_csrf` in prod — a sibling subdomain cannot plant or
//      shadow a __Host- cookie) that the web client reads and echoes in
//      `X-CSRF-Token`. Another site can make the browser SEND the cookie but
//      cannot READ it, so it cannot write the header: missing or unequal →
//      403 `csrf`. The cookie is issued on any page or /api/ response to a
//      request that arrived without a valid one — the 403 included, so the
//      client's one retry (web/src/api/client.ts) carries the fresh token.
//
// Exempt — they carry no ambient credential, so there is nothing to forge:
//   - `Authorization: Bearer` requests, when a bearer token is what decides
//     who is asking (Postgres is configured: ./auth/index.ts then never falls
//     back to the cookie or proxy header). A cross-site page cannot add an
//     Authorization header without a CORS preflight, which this server never
//     answers.
//   - /api/mcp, which accepts nothing BUT a bearer token (cookie → 401 there).
// Every other mode is checked, dev included: a dev server answers every
// caller on loopback as an admin, which a page in the same browser can reach.

import { randomBytes, timingSafeEqual } from 'crypto';
import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hasBearer } from './auth/tokens';

export const CSRF_HEADER = 'x-csrf-token';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Routes that refuse ambient credentials themselves. */
const BEARER_ONLY = new Set(['/api/mcp']);

/** Origin header → is it this server, by host (scheme and port as the browser saw them). */
export function sameOrigin(origin: string, host: string | undefined): boolean {
  try {
    return !!host && new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false; // includes the literal "null" origin of sandboxed and file: pages
  }
}

/** 256 random bits, base64url (43 chars). */
export const newCsrfToken = (): string => randomBytes(32).toString('base64url');

function cookieToken(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie;
  const v = typeof raw === 'string' ? fastifyCookie.parse(raw)[name] : undefined;
  return v && TOKEN_RE.test(v) ? v : null;
}

function matches(cookie: string | null, header: unknown): boolean {
  if (!cookie || typeof header !== 'string' || !TOKEN_RE.test(header)) return false;
  return timingSafeEqual(Buffer.from(cookie), Buffer.from(header)); // both 43 ASCII chars
}

export interface CsrfOptions {
  /** The cookie's name (./auth/cookies.ts). */
  readonly cookie: string;
  /** Secure flag (prod). */
  readonly secure: boolean;
  /** A bearer token alone decides who is asking (Postgres is configured and no test identify overrides it). */
  readonly bearerDecides: boolean;
}

/** Registers the check and the cookie. Registered before sign-in's hook (app.ts). */
export function registerCsrf(app: FastifyInstance, o: CsrfOptions): void {
  app.addHook('onRequest', (req, reply, done) => {
    const bearer = o.bearerDecides && hasBearer(req.headers.authorization);
    const token = cookieToken(req, o.cookie);
    const path = req.url.split('?')[0];
    // Issue one to whatever page or API call arrives without it. Not to
    // static files: an immutable asset must not carry a Set-Cookie into a cache.
    if (!token && !bearer && (path.startsWith('/api/') || (req.headers.accept ?? '').includes('text/html'))) {
      reply.header(
        'set-cookie',
        fastifyCookie.serialize(o.cookie, newCsrfToken(), { path: '/', sameSite: 'lax', secure: o.secure, httpOnly: false }),
      );
    }
    if (SAFE.has(req.method) || bearer || BEARER_ONLY.has(req.routeOptions.url ?? '')) return done();

    const origin = req.headers.origin;
    const crossSite = origin !== undefined ? !sameOrigin(origin, req.headers.host) : req.headers['sec-fetch-site'] === 'cross-site';
    if (crossSite) return void reply.code(403).send({ error: 'origin' });
    if (!matches(token, req.headers[CSRF_HEADER])) return void reply.code(403).send({ error: 'csrf' });
    done();
  });
}
