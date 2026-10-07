// Sign-in (T3.2): picks the AUTH_MODE, registers /api/auth/*, and returns the
// `Identify` app.ts runs on every other /api/ request — what feeds ctx().
//
//   password browser session cookie → `sessions` row → user; ./password.ts
//           signs in with Ordinate's own email + password (the default mode)
//   oidc    browser session cookie → `sessions` row → user (./oidc.ts signs in)
//   header  X-Forwarded-Email from a proxy (oauth2-proxy), believed ONLY when
//           the TCP peer is inside TRUSTED_PROXY_CIDRS
//   dev     everyone is dev@local, admin (context.ts; explicit only, refused in prod)
//   bearer  with Postgres, in every mode: `Authorization: Bearer ord_…` is a
//           personal API token (./tokens.ts). A request that carries one is
//           decided by it alone — a bad token is a 401, never a fall-through
//           to the cookie or the proxy header.
//
// /api/auth/* is outside app.ts's 401 gate (you cannot need a session to get
// one); `me` and `logout-everywhere` run `identify` themselves.

import fastifyCookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BlockList, isIP } from 'net';
import type { Pool } from 'pg';
import { identityFor, type Identify } from '../context';
import { proxyList, type AuthEnv, type ServerEnv } from '../env';
import { audit, type AuditAction } from '../authz/audit';
import { cookieNames, cookieOpts, safeNext } from './cookies';
import { registerOidc } from './oidc';
import { registerPassword } from './password';
import { setupOpen } from './passwordStore';
import { hasBearer, tokenIdentity } from './tokens';
import { endAllSessions, endSession, ensureOrg, member, normalEmail, provision, sessionIdentity } from './store';

/**
 * Is `peer` (a socket's remoteAddress) inside the trusted list? An IPv4 peer
 * on a dual-stack socket arrives as `::ffff:a.b.c.d`; BlockList matches that
 * against IPv4 subnets itself.
 */
export function isTrustedPeer(list: BlockList, peer: string | undefined): boolean {
  const family = peer ? isIP(peer) : 0;
  return family !== 0 && list.check(peer as string, family === 6 ? 'ipv6' : 'ipv4');
}

function headerIdentify(pool: Pool, auth: AuthEnv): Identify {
  const trusted = proxyList(auth.trustedProxies);
  return async (headers, peer) => {
    // The peer is the socket's address, handed in by app.ts — X-Forwarded-For
    // is never read: any client can write it.
    if (!isTrustedPeer(trusted, peer)) return null;
    const email = normalEmail(headers['x-forwarded-email']);
    if (!email) return null;
    const known = await member(pool, auth, email);
    if (known && !(auth.adminEmail === email && known.user.role !== 'admin')) return known;
    const m = await provision(pool, auth, email);
    return typeof m === 'string' ? null : m.identity;
  };
}

/** The value of cookie `name` in a raw Cookie header. */
function cookieValue(header: string | string[] | undefined, name: string): string | undefined {
  return typeof header === 'string' ? fastifyCookie.parse(header)[name] : undefined;
}

/**
 * Registers /api/auth/* and returns how every other /api/ request is
 * identified. `override` (tests) replaces the mode's identify.
 */
export function registerAuth(app: FastifyInstance, cfg: ServerEnv, pool: Pool | null, override?: Identify): Identify {
  void app.register(fastifyCookie);
  const auth = cfg.auth;
  const secure = cfg.env === 'prod';
  const names = cookieNames(secure);

  let identify: Identify;
  if (override) identify = override;
  else if (auth.mode === 'dev') identify = identityFor(cfg);
  else {
    if (!pool) throw new Error(`AUTH_MODE=${auth.mode} needs Postgres`); // env.ts already demands DATABASE_URL
    const db = pool;
    identify =
      auth.mode === 'header'
        ? headerIdentify(db, auth)
        : async (headers) => {
            const id = cookieValue(headers.cookie, names.session);
            return id ? sessionIdentity(db, auth, id) : null;
          };
    // Runs after app.ts's migration hook (registered first), so `orgs` exists.
    app.addHook('onReady', async () => ensureOrg(db, auth.org));
  }
  if (pool && !override) {
    const db = pool;
    const byMode = identify;
    identify = (headers, peer) => (hasBearer(headers.authorization) ? tokenIdentity(db, headers.authorization as string) : byMode(headers, peer));
  }

  const who = (req: FastifyRequest) => identify(req.headers, req.socket.remoteAddress);

  const sessions = auth.mode === 'oidc' || auth.mode === 'password';

  // The shell asks this on load. 200 with `user: null` when signed out — a 401
  // here would be a console error on every visit to the sign-in page.
  app.get('/api/auth/me', async (req) => {
    const id = await who(req);
    return {
      user: id ? { email: id.user.email, role: id.user.role, mustChangePassword: id.mustChangePassword === true } : null,
      org: id ? id.org.id : null,
      mode: auth.mode,
      // Only a session can be ended here; header mode signs out at the proxy.
      canSignOut: sessions,
      // Members, teams and API tokens live in Postgres: without it there is nothing to administer (T3.4).
      accounts: pool !== null,
      // Password mode before its first admin: the sign-in page shows "Create admin account" (./password.ts).
      setup: !id && auth.mode === 'password' && pool !== null ? await setupOpen(pool, auth.org) : false,
    };
  });

  if (pool && auth.mode === 'oidc') registerOidc(app, cfg, pool, names);
  else {
    if (pool && auth.mode === 'password') registerPassword(app, cfg, pool, names);
    // No redirect-based sign-in step: the server (dev) or the proxy (header)
    // already knows who you are, and password mode signs in on /sign-in itself.
    app.get<{ Querystring: { next?: string } }>('/api/auth/login', async (req, reply) => reply.redirect(safeNext(req.query.next)));
  }

  // Sign-outs go to the audit trail (../authz/audit.ts) with who signed out.
  const trail = (req: FastifyRequest, org: string, actor: string, action: AuditAction) =>
    audit(pool, { org, actor, action, outcome: 'ok', requestId: String(req.id) }).catch((err: unknown) =>
      req.log.error({ err: { name: (err as Error | null)?.name, code: (err as { code?: unknown } | null)?.code } }, 'audit write failed'),
    );

  app.post('/api/auth/logout', async (req, reply) => {
    const id = req.cookies[names.session];
    if (id && pool) {
      // Who it was, before the session is gone — session modes only (the cookie is the identity).
      const was = sessions ? await sessionIdentity(pool, auth, id) : null;
      await endSession(pool, id);
      if (was) await trail(req, was.org.id, was.user.email, 'logout');
    }
    reply.clearCookie(names.session, cookieOpts(secure, '/'));
    return reply.code(204).send();
  });

  // Every session of the caller, on every device.
  app.post('/api/auth/logout-everywhere', async (req, reply) => {
    const id = await who(req);
    if (!id) return reply.code(401).send({ error: 'not signed in' });
    const ended = pool ? await endAllSessions(pool, id.org.id, id.user.email) : 0;
    await trail(req, id.org.id, id.user.email, 'logout_everywhere');
    reply.clearCookie(names.session, cookieOpts(secure, '/'));
    return reply.send({ ended });
  });

  return identify;
}
