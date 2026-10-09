// Password sign-in (AUTH_MODE=password): Ordinate's own accounts, for trying
// it out before single sign-on is set up — the server says so at every start.
//
//   POST /api/auth/password/setup   { code, email, password } → the first admin, signed in
//   POST /api/auth/password/login   { email, password }       → a session (rotated)
//   POST /api/auth/password/change  { current, password }     → a new password; other sessions end
//
// First run: while no enabled admin has a password, each pod prints a one-time
// setup code in its log at startup (the ONE credential this server logs, on
// purpose: whoever can read the log runs the server). The sign-in page shows
// "Create admin account" and asks for it. Everyone else is added by an admin
// with a temporary password (src/server/admin/passwords.ts), which they must
// change at their first sign-in: until then app.ts answers nothing but /api/auth/*.
//
// Every answer is 200 `{ ok }`: a refusal is `{ ok: false, error: <code> }`,
// never an error status — a 4xx on a fetch is a console error in the browser,
// and a typo in a password is not one (/api/auth/me answers 200 for the same
// reason). The codes are words for the web page to choose (never sentences). A
// wrong email and a wrong password are the same `invalid`; `disabled` is only
// said to someone who knew the password. Bodies are never logged; app.ts
// redacts `password`. (The per-IP limit in limits.ts still answers 429.)

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { ServerEnv } from '../env';
import { audit, type AuditAction, type Outcome } from '../authz/audit';
import { cookieOpts, type CookieNames } from './cookies';
import { hashPassword, normalSetupCode, passwordProblem, PASSWORD_MAX, verifyPassword } from './passwordHash';
import { completeSetup, credentials, issueSetupCode, setPassword, SETUP_CODE_HOURS, setupCodeValid, setupOpen, stampSignIn } from './passwordStore';
import { createSession, endOtherSessions, normalEmail, sessionIdentity } from './store';

export const PASSWORD_ROUTES = ['/api/auth/password/login', '/api/auth/password/setup', '/api/auth/password/change'] as const;

// Shapes only; the password rules are passwordProblem's, so the page can say which one failed.
const Pw = z.string().max(PASSWORD_MAX * 4);
const LoginBody = z.strictObject({ email: z.string().max(320), password: Pw });
const SetupBody = z.strictObject({ code: z.string().max(64), email: z.string().max(320), password: Pw });
const ChangeBody = z.strictObject({ current: Pw, password: Pw });

// Wrong passwords per account: past FAIL_MAX in FAIL_WINDOW the account is
// refused (`locked`, with Retry-After) until the window ends — the per-IP
// sign-in limit (limits.ts) does not stop a guesser with many addresses. The
// price: a stranger can lock an account for 15 minutes; it never deletes one.
// ponytail: per process like limits.ts (N pods allow N × FAIL_MAX); bounded LRU.
const FAIL_MAX = 10;
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_KEYS = 5_000;
const failures = new Map<string, { n: number; until: number }>();

function lockedFor(key: string, now: number): number {
  const f = failures.get(key);
  if (!f || f.until <= now) return 0;
  return f.n >= FAIL_MAX ? Math.ceil((f.until - now) / 1000) : 0;
}

function recordFailure(key: string, now: number): void {
  const f = failures.get(key);
  failures.delete(key);
  failures.set(key, f && f.until > now ? { n: f.n + 1, until: f.until } : { n: 1, until: now + FAIL_WINDOW_MS });
  if (failures.size > FAIL_KEYS) failures.delete(failures.keys().next().value as string);
}

const problemCode = (p: 'short' | 'long') => (p === 'short' ? 'password-short' : 'password-long');

/** A designed refusal: 200, so the browser logs nothing (see the header). */
const refuse = (error: string, extra: Record<string, unknown> = {}) => ({ ok: false, error, ...extra });

export function registerPassword(app: FastifyInstance, cfg: ServerEnv, pool: Pool, names: CookieNames): void {
  const auth = cfg.auth;
  const secure = cfg.env === 'prod';
  const domainAllowed = (email: string) => auth.allowedDomains.length === 0 || auth.allowedDomains.includes(email.slice(email.lastIndexOf('@') + 1));

  // After the org exists (auth/index.ts's onReady runs first): say what this mode is for, and open setup if no admin has a password.
  app.addHook('onReady', async () => {
    app.log.warn(
      'AUTH_MODE=password: Ordinate keeps its own passwords. It is meant for trying Ordinate out; ' +
        'switch to single sign-on (AUTH_MODE=oidc) before real use (docs/server/sso.md)',
    );
    const code = await issueSetupCode(pool, auth.org);
    if (code) {
      app.log.warn(
        `First-run setup code: ${code} (open Ordinate in a browser and enter it to create the first admin account; ` +
          `valid ${SETUP_CODE_HOURS} h, restart the server for a new one)`,
      );
    }
  });

  const trail = (req: FastifyRequest, actor: string | null, action: AuditAction, outcome: Outcome) =>
    audit(pool, { org: auth.org, actor, action, outcome, requestId: String(req.id) }).catch((err: unknown) =>
      req.log.error({ err: { name: (err as Error | null)?.name, code: (err as { code?: unknown } | null)?.code } }, 'audit write failed'),
    );

  const signIn = async (req: FastifyRequest, reply: FastifyReply, userId: string) => {
    const id = await createSession(pool, auth, userId, req.cookies[names.session]);
    reply.setCookie(names.session, id, { ...cookieOpts(secure, '/'), maxAge: Math.floor(auth.sessionAbsoluteMs / 1000) });
  };

  app.post('/api/auth/password/setup', async (req, reply) => {
    const body = SetupBody.safeParse(req.body);
    const email = body.success ? normalEmail(body.data.email) : null;
    const code = body.success ? normalSetupCode(body.data.code) : null;
    if (!body.success || !email) return refuse('invalid-input');
    if (!(await setupOpen(pool, auth.org))) return refuse('closed');
    if (!code || !(await setupCodeValid(pool, auth.org, code))) {
      req.log.warn('first-run setup refused: wrong or expired setup code');
      return refuse('code');
    }
    const problem = passwordProblem(body.data.password);
    if (problem) return refuse(problemCode(problem));
    if (!domainAllowed(email)) return refuse('domain');
    const done = await completeSetup(pool, auth.org, email, await hashPassword(body.data.password), code);
    if (done === 'closed') return refuse('closed');
    if (done === 'code') return refuse('code');
    await signIn(req, reply, done.userId);
    req.log.info('first admin account created');
    await trail(req, email, 'login', 'ok');
    return { ok: true };
  });

  app.post('/api/auth/password/login', async (req, reply) => {
    const body = LoginBody.safeParse(req.body);
    const email = body.success ? normalEmail(body.data.email) : null;
    if (!body.success || !email) return refuse('invalid-input');
    const key = `${auth.org}\u0000${email}`;
    const wait = lockedFor(key, Date.now());
    if (wait > 0) return reply.header('retry-after', wait).send(refuse('locked', { retryAfter: wait }));

    const c = await credentials(pool, auth.org, email);
    // Always one scrypt: an unknown email costs what a known one does.
    const good = await verifyPassword(body.data.password, c?.hash ?? null);
    if (!c || !good) {
      recordFailure(key, Date.now());
      req.log.info('password sign-in refused: wrong email or password');
      await trail(req, c ? email : null, 'login', 'denied');
      return refuse('invalid');
    }
    failures.delete(key);
    const refusal = c.disabled ? 'disabled' : !domainAllowed(email) ? 'domain' : null;
    if (refusal) {
      req.log.warn({ reason: refusal }, 'password sign-in refused');
      await trail(req, email, 'login', 'denied');
      return refuse(refusal);
    }
    const who = await stampSignIn(pool, auth, c.userId, email);
    await signIn(req, reply, c.userId);
    req.log.info({ role: who.role }, 'signed in');
    await trail(req, email, 'login', 'ok');
    return { ok: true, mustChangePassword: who.mustChange };
  });

  app.post('/api/auth/password/change', async (req, reply) => {
    // A browser session only: an API token cannot change the password behind it.
    const sid = req.cookies[names.session];
    const who = sid ? await sessionIdentity(pool, auth, sid) : null;
    if (!who) return refuse('signed-out');
    const body = ChangeBody.safeParse(req.body);
    if (!body.success) return refuse('invalid-input');
    const email = who.user.email;
    const key = `${auth.org}\u0000${email}`;
    const wait = lockedFor(key, Date.now());
    if (wait > 0) return reply.header('retry-after', wait).send(refuse('locked', { retryAfter: wait }));
    const c = await credentials(pool, who.org.id, email);
    if (!c || !(await verifyPassword(body.data.current, c.hash))) {
      recordFailure(key, Date.now());
      await trail(req, email, 'password_change', 'denied');
      return refuse('current');
    }
    const problem = passwordProblem(body.data.password);
    if (problem) return refuse(problemCode(problem));
    if (body.data.password === body.data.current) return refuse('same');
    if (!(await setPassword(pool, who.org.id, c.userId, await hashPassword(body.data.password), false))) {
      return refuse('signed-out');
    }
    // Whoever else held a session on the old password is out; this browser stays in.
    await endOtherSessions(pool, c.userId, sid);
    req.log.info('password changed');
    await trail(req, email, 'password_change', 'ok');
    return { ok: true };
  });
}
