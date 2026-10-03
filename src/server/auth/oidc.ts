// OIDC sign-in: authorization code + PKCE (S256) + state + nonce, through
// `openid-client` (plan §2). Two routes:
//
//   GET /api/auth/login     → 302 to the IdP; the login's state, nonce and PKCE
//                             verifier ride in a 10-minute httpOnly cookie
//                             scoped to the callback path (no server-side
//                             store, so any pod can finish any login)
//   GET /api/auth/callback  → code exchanged, id_token verified (signature via
//                             JWKS, iss, aud, exp, nonce), user provisioned,
//                             a NEW session issued (rotation), 302 into the app
//
// Every failure lands on /sign-in?error=<code> — never a stack or an IdP
// message in the browser. Logs carry the error's name and code only: the
// request URL (code, state) is stripped by app.ts's serializer, and nothing
// here logs a token, a verifier or a cookie.

import type { FastifyInstance, FastifyReply } from 'fastify';
import * as client from 'openid-client';
import type { Pool } from 'pg';
import type { ServerEnv } from '../env';
import { createSession, normalEmail, provision } from './store';
import { cookieOpts, safeNext, type CookieNames } from './cookies';

interface LoginTx {
  s: string; // state
  n: string; // nonce
  v: string; // PKCE verifier
  r: string; // where to land after sign-in
}

const TX_MAX_AGE_S = 600;
const CALLBACK = '/api/auth/callback';

function readTx(raw: string | undefined): LoginTx | null {
  if (!raw) return null;
  try {
    const t = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<LoginTx>;
    const str = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length < 512;
    return str(t.s) && str(t.n) && str(t.v) && str(t.r) ? { s: t.s, n: t.n, v: t.v, r: safeNext(t.r) } : null;
  } catch {
    return null;
  }
}

/** What an operator needs from a failed exchange: never a token, a body or a cause. */
function errInfo(err: unknown): Record<string, unknown> {
  const e = err as { name?: unknown; code?: unknown; error?: unknown; message?: unknown } | null;
  return { name: e?.name, code: e?.code, error: e?.error, message: e?.message };
}

export function registerOidc(app: FastifyInstance, cfg: ServerEnv, pool: Pool, names: CookieNames): void {
  const oidc = cfg.auth.oidc;
  if (!oidc) throw new Error('registerOidc needs cfg.auth.oidc');
  const secure = cfg.env === 'prod';

  // Discovered on first use and cached; a failure is not cached, so an IdP
  // that was down at the first login is retried at the next one. Not at
  // startup: an IdP blip must not crash-loop every pod.
  let config: Promise<client.Configuration> | null = null;
  const discover = (): Promise<client.Configuration> => {
    // http:// issuers are only accepted by env.ts in dev (a local mock IdP).
    const opts = cfg.env === 'dev' ? { execute: [client.allowInsecureRequests] } : undefined;
    config ??= client.discovery(new URL(oidc.issuer), oidc.clientId, oidc.clientSecret, undefined, opts).catch((err: unknown) => {
      config = null;
      throw err;
    });
    return config;
  };

  const fail = (reply: FastifyReply, code: string) => reply.redirect(`/sign-in?error=${code}`);

  app.get<{ Querystring: { next?: string } }>('/api/auth/login', async (req, reply) => {
    let conf: client.Configuration;
    try {
      conf = await discover();
    } catch (err) {
      req.log.warn({ oidc: errInfo(err) }, 'oidc discovery failed');
      return fail(reply, 'unavailable');
    }
    const tx: LoginTx = {
      s: client.randomState(),
      n: client.randomNonce(),
      v: client.randomPKCECodeVerifier(),
      r: safeNext(req.query.next),
    };
    const url = client.buildAuthorizationUrl(conf, {
      redirect_uri: oidc.redirectUrl,
      scope: 'openid email profile',
      response_type: 'code',
      code_challenge: await client.calculatePKCECodeChallenge(tx.v),
      code_challenge_method: 'S256',
      state: tx.s,
      nonce: tx.n,
    });
    reply.setCookie(names.tx, Buffer.from(JSON.stringify(tx)).toString('base64url'), {
      ...cookieOpts(secure, CALLBACK),
      maxAge: TX_MAX_AGE_S,
    });
    return reply.redirect(url.href);
  });

  app.get('/api/auth/callback', async (req, reply) => {
    const tx = readTx(req.cookies[names.tx]);
    reply.clearCookie(names.tx, cookieOpts(secure, CALLBACK));
    if (!tx) return fail(reply, 'expired');

    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      const conf = await discover();
      // The registered redirect URL plus this request's query: behind an
      // ingress the request's own host/proto may not be what the IdP saw.
      const current = new URL(oidc.redirectUrl);
      current.search = new URL(req.url, 'http://x').search;
      tokens = await client.authorizationCodeGrant(conf, current, {
        pkceCodeVerifier: tx.v,
        expectedState: tx.s,
        expectedNonce: tx.n,
        idTokenExpected: true,
      });
    } catch (err) {
      const denied = err instanceof client.AuthorizationResponseError && err.error === 'access_denied';
      req.log.warn({ oidc: errInfo(err) }, denied ? 'oidc sign-in denied at the IdP' : 'oidc sign-in failed');
      return fail(reply, denied ? 'denied' : 'failed');
    }

    const claims = tokens.claims();
    const email = normalEmail(claims?.email);
    // An IdP that says the address is unverified must not sign anyone in as it.
    if (!email || claims?.email_verified === false) {
      req.log.warn({ hasEmail: email !== null }, 'oidc sign-in refused: no verified email in the id_token');
      return fail(reply, 'email');
    }
    const m = await provision(pool, cfg.auth, email);
    if (typeof m === 'string') {
      req.log.warn({ reason: m }, 'oidc sign-in refused');
      return fail(reply, m);
    }
    const id = await createSession(pool, cfg.auth, m.userId, req.cookies[names.session]);
    reply.setCookie(names.session, id, { ...cookieOpts(secure, '/'), maxAge: Math.floor(cfg.auth.sessionAbsoluteMs / 1000) });
    req.log.info({ role: m.identity.user.role }, 'signed in');
    return reply.redirect(tx.r);
  });
}
