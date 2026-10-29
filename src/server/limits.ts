// Rate limits and the RPC time limit (T6.2).
//
//   sign-in   GET /api/auth/login + /api/auth/callback   per client IP   RATE_LIMIT_LOGIN_PER_MINUTE (60)
//             POST /api/auth/password/*                  (the same bucket; ./auth/password.ts also
//                                                        locks one account after repeated wrong passwords)
//   RPC       POST /api/rpc/<channel>                    per client IP   RATE_LIMIT_RPC_IP_PER_MINUTE (3000)
//                                                        per user        RATE_LIMIT_RPC_PER_MINUTE (1200)
//   MCP       POST /api/mcp                              the RPC buckets above (T6.3): a tool call
//                                                        runs the same handlers, so it spends the same budget
//   embed     GET /embed/<token>                         per client IP   RATE_LIMIT_RPC_IP_PER_MINUTE, its own bucket,
//                                                        before any query; per token and per org in ./embed/route.ts
//                                                        (RATE_LIMIT_EMBED_PER_MINUTE, RATE_LIMIT_EMBED_ORG_PER_MINUTE)
//   hooks     /api/hooks/refresh/<token>                 per client IP   RATE_LIMIT_LOGIN_PER_MINUTE, its own
//                                                        bucket (live data L0.5): a credential presented without
//                                                        a session, like a sign-in. Each URL is also held to one
//                                                        call per REFRESH_HOOK_MIN_INTERVAL_SEC in Postgres
//                                                        (./hooks/store.ts), across pods
//
// Over a limit → 429 with Retry-After (seconds until the window resets). The
// per-IP checks run before sign-in is looked up, so a flood costs no Postgres
// query; the per-user check runs after it (the user is only known then), on
// the org + email, so every tab and API token of one person shares a bucket.
//
// The client IP is the TCP peer — unless the peer is a proxy in
// TRUSTED_PROXY_CIDRS, then the right-most X-Forwarded-For entry that is not
// one of them. Behind an ingress without TRUSTED_PROXY_CIDRS every caller
// shares the ingress's address, and so one per-IP bucket that one anonymous
// client can spend for everyone: set it there. The first X-Forwarded-For an
// untrusted peer sends is logged once, at warn, naming that peer.
//
// Per pod ON PURPOSE (threat model R8): these buckets protect this pod's CPU, so
// they live in this process (@fastify/rate-limit's LRU store, 5,000 keys per
// limit) and N pods allow N × them. The limits that must hold across pods — the
// password lockout, email, Send now, embed per token and org — are ./counters.ts.

import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BlockList } from 'net';
import { isTrustedPeer as trusted } from './auth/index';
import { PASSWORD_ROUTES } from './auth/password';
import { ctx } from './context';
import type { LimitsEnv } from './env';
import { HOOK_ROUTE } from './hooks/store';
import { trackWork } from './lifecycle';
import { EMBED_ROUTE } from './embed/route';

const MINUTE = 60_000;
export const RPC_ROUTE = '/api/rpc/:channel';
const MCP_ROUTE = '/api/mcp';
const SIGN_IN_ROUTES = new Set<string>(['/api/auth/login', '/api/auth/callback', ...PASSWORD_ROUTES]);

/** The address a request came from, trusting X-Forwarded-For only as far as the proxies in `proxies`. */
export function clientIp(req: Pick<FastifyRequest, 'headers' | 'socket'>, proxies: BlockList): string {
  let ip = req.socket.remoteAddress ?? '';
  if (!trusted(proxies, ip)) return ip;
  const xff = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(xff) ? xff.join(',') : (xff ?? '')).split(',').map((s) => s.trim()).filter(Boolean);
  // Right to left: each trusted proxy vouches for the hop before it.
  while (hops.length && trusted(proxies, ip)) ip = hops.pop() as string;
  return ip;
}

type Limiter = (req: FastifyRequest) => Promise<{ isAllowed: true } | { isAllowed: false; isExceeded: boolean; ttlInSeconds: number }>;

/** 429 + Retry-After when `limiter` says the caller is over; true when it answered. */
async function refused(limiter: Limiter, req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const r = await limiter(req);
  if (r.isAllowed || !r.isExceeded) return false;
  const after = Math.max(1, r.ttlInSeconds);
  await reply.code(429).header('retry-after', after).send({ error: 'rate limited', retryAfter: after });
  return true;
}

export interface Limits {
  /** The per-user RPC check (also /api/mcp's): a route-level onRequest hook, after sign-in. */
  perUser(req: FastifyRequest, reply: FastifyReply): Promise<void>;
}

/**
 * Registers the plugin and the per-IP checks (a root onRequest hook; call it
 * before sign-in's hook is added). Returns the per-user check for the RPC route.
 */
export function registerLimits(app: FastifyInstance, cfg: LimitsEnv, proxies: BlockList): Limits {
  // global: false — nothing is limited unless asked below. The limiters are
  // made on first use: the plugin's decorator exists once it has loaded.
  void app.register(rateLimit, { global: false });
  let warned = false;
  const ipKey = (prefix: string) => (req: FastifyRequest) => {
    if (!warned && req.headers['x-forwarded-for'] !== undefined && !trusted(proxies, req.socket.remoteAddress)) {
      warned = true;
      req.log.warn({ peer: req.socket.remoteAddress }, 'X-Forwarded-For from a peer outside TRUSTED_PROXY_CIDRS: if it is your proxy, every client behind it shares its rate-limit buckets — add it to TRUSTED_PROXY_CIDRS');
    }
    return prefix + normalizeIP(clientIp(req, proxies));
  };
  let signIn: Limiter | null = null;
  let rpcIp: Limiter | null = null;
  let rpcUser: Limiter | null = null;
  let hookIp: Limiter | null = null;
  let embedIp: Limiter | null = null;

  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions.url ?? '';
    if (SIGN_IN_ROUTES.has(route)) {
      signIn ??= app.createRateLimit({ max: cfg.loginPerMinute, timeWindow: MINUTE, keyGenerator: ipKey('login:') });
      await refused(signIn, req, reply);
    } else if (route === RPC_ROUTE || (route === MCP_ROUTE && req.method === 'POST')) {
      rpcIp ??= app.createRateLimit({ max: cfg.rpcIpPerMinute, timeWindow: MINUTE, keyGenerator: ipKey('rpc:') });
      await refused(rpcIp, req, reply);
    } else if (route === EMBED_ROUTE) {
      embedIp ??= app.createRateLimit({ max: cfg.rpcIpPerMinute, timeWindow: MINUTE, keyGenerator: ipKey('embed:') });
      await refused(embedIp, req, reply);
    } else if (route === HOOK_ROUTE) {
      hookIp ??= app.createRateLimit({ max: cfg.loginPerMinute, timeWindow: MINUTE, keyGenerator: ipKey('hook:') });
      await refused(hookIp, req, reply);
    }
  });

  return {
    async perUser(req, reply) {
      rpcUser ??= app.createRateLimit({
        max: cfg.rpcUserPerMinute,
        timeWindow: MINUTE,
        keyGenerator: () => {
          const { org, user } = ctx();
          return `user:${org.id}\u0000${user.email}`;
        },
      });
      await refused(rpcUser, req, reply);
    },
  };
}

/** The reason a request's signal aborts when its RPC ran past RPC_TIMEOUT_SECONDS. */
export class RpcTimeout extends Error {
  constructor() {
    super('rpc time limit');
    this.name = 'RpcTimeout';
  }
}

/**
 * Settles with `work`, or rejects with the signal's reason once it aborts —
 * a time limit (RpcTimeout) or the caller hanging up. `work` itself cannot be
 * stopped; what it awaits on DuckDB is (the same signal interrupts the query
 * in the org worker), and its late result or error is dropped. The shutdown
 * waits for it either way (./lifecycle.ts trackWork).
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  trackWork(work); // the shutdown awaits it even after its reply was sent (./shutdown.ts)
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(signal.reason as Error);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err as Error);
      },
    );
  });
}
